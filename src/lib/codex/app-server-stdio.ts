import { spawn } from "node:child_process";
import { z } from "zod";
import type { AppServerClient } from "./transports";

const APP_SERVER_PROTOCOL = "codex-app-server/v2" as const;
const MAX_JSONL_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_AGENT_MESSAGE_BUFFER_BYTES = 32 * 1024;
const MAX_OWNER_VISIBLE_MESSAGE_BYTES = 8 * 1024;

type DataListener = (chunk: Uint8Array | string) => void;
type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;

export interface StdioProcess {
  readonly stdin: { write(data: string): boolean; end(): void };
  readonly stdout: { on(event: "data", listener: DataListener): unknown; off(event: "data", listener: DataListener): unknown };
  readonly stderr?: { on(event: "data", listener: DataListener): unknown; off(event: "data", listener: DataListener): unknown };
  on(event: "exit", listener: ExitListener): unknown;
  off(event: "exit", listener: ExitListener): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface StdioProcessSpawner {
  spawn(command: string, args: readonly ["app-server", "--listen", "stdio://"]): StdioProcess;
}

export type AppServerLifecycleEvent =
  | { type: "turn_started"; threadId?: string; turnId: string }
  | { type: "turn_completed"; threadId?: string; turnId: string; status: "completed" | "interrupted" | "failed" | "unknown"; finalMessage?: string }
  | { type: "process_stopped"; reason: "exit" | "protocol_error" | "requested"; diagnostic?: AppServerDiagnostic };

type AppServerDiagnostic =
  | "auth_missing"
  | "provider_request_failed"
  | "provider_stream_disconnected"
  | "thread_missing"
  | "protocol_frame_oversized"
  | "protocol_invalid_json"
  | "protocol_invalid_message";

export type StdioClientOptions = {
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  onLifecycleEvent?: (event: AppServerLifecycleEvent) => void;
  spawner?: StdioProcessSpawner;
  workspaceRoot?: string;
  command?: string;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  sanitize: (value: unknown) => unknown;
};

const rpcMessageSchema = z.object({
  id: z.union([z.number().int().nonnegative(), z.string().max(128)]).optional(),
  method: z.string().max(128).optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number().int(), message: z.string().max(MAX_JSONL_FRAME_BYTES) }).optional(),
  params: z.unknown().optional(),
});

const emptyResultSchema = z.unknown().transform(() => ({}));
const threadResultSchema = z.object({ thread: z.object({ id: z.string().min(1).max(256) }) });
const turnResultSchema = z.object({ turn: z.object({ id: z.string().min(1).max(256) }) });
const turnNotificationSchema = z.object({
  threadId: z.string().min(1).max(256).optional(),
  turn: z.object({
    id: z.string().min(1).max(256),
    status: z.string().max(64).optional(),
  }),
});
const agentMessageDeltaSchema = z.object({
  threadId: z.string().min(1).max(256).optional(),
  turnId: z.string().min(1).max(256),
  delta: z.string().max(MAX_JSONL_FRAME_BYTES),
});
const agentMessageCompletedSchema = z.object({
  threadId: z.string().min(1).max(256).optional(),
  turnId: z.string().min(1).max(256),
  item: z.object({
    type: z.literal("agentMessage"),
    text: z.string().max(MAX_JSONL_FRAME_BYTES),
  }),
});

export class CodexAppServerStdioClient implements AppServerClient {
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly emit?: (event: AppServerLifecycleEvent) => void;
  private readonly spawner: StdioProcessSpawner;
  private readonly workspaceRoot: string;
  private readonly command: string;
  private process: StdioProcess | null = null;
  private nextRequestId = 1;
  private buffer = "";
  private state: "stopped" | "starting" | "connected" = "stopped";
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly turnThreads = new Map<string, string>();
  private readonly agentMessageBuffers = new Map<string, string>();
  private readonly completedAgentMessages = new Map<string, string>();
  private lastDiagnostic: AppServerDiagnostic | undefined;

  constructor(options: StdioClientOptions = {}) {
    this.requestTimeoutMs = boundedTimeout(options.requestTimeoutMs, 15_000);
    this.shutdownTimeoutMs = boundedTimeout(options.shutdownTimeoutMs, 2_000);
    this.emit = options.onLifecycleEvent;
    this.spawner = options.spawner ?? nodeSpawner;
    this.workspaceRoot = options.workspaceRoot ?? process.cwd();
    this.command = options.command?.trim() || "codex";
  }

  async start(): Promise<void> {
    if (this.state !== "stopped") throw safeError("app_server_already_started");
    this.state = "starting";
    this.buffer = "";
    this.lastDiagnostic = undefined;
    let child: StdioProcess;
    try {
      child = this.spawner.spawn(this.command, ["app-server", "--listen", "stdio://"]);
    } catch {
      this.state = "stopped";
      throw safeError("app_server_spawn_failed");
    }
    this.process = child;
    child.stdout.on("data", this.onData);
    child.stderr?.on("data", this.onStderr);
    child.on("exit", this.onExit);

    try {
      await this.request("initialize", {
        clientInfo: { name: "company_os", title: `${process.env.COMPANY_OS_PROJECT_NAME ?? "Company OS"} Cockpit`, version: "0.2.0" },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: [],
        },
      }, emptyResultSchema);
      this.notify("initialized", {});
      this.state = "connected";
    } catch {
      await this.stop("protocol_error");
      throw safeError("app_server_initialize_failed");
    }
  }

  async stop(reason: "requested" | "protocol_error" = "requested"): Promise<void> {
    const child = this.process;
    if (!child) {
      this.state = "stopped";
      return;
    }
    this.detach(child);
    this.process = null;
    this.state = "stopped";
    this.rejectPending("app_server_stopped");
    const stopped = new Promise<void>((resolve) => {
      const onExit: ExitListener = () => { child.off("exit", onExit); resolve(); };
      child.on("exit", onExit);
    });
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGTERM"), this.shutdownTimeoutMs);
    await Promise.race([stopped, new Promise<void>((resolve) => setTimeout(resolve, this.shutdownTimeoutMs * 2))]);
    clearTimeout(timer);
    this.emit?.({ type: "process_stopped", reason, ...(this.lastDiagnostic ? { diagnostic: this.lastDiagnostic } : {}) });
  }

  async protocolVersion(): Promise<string> {
    if (this.state !== "connected") throw safeError("app_server_offline");
    return APP_SERVER_PROTOCOL;
  }

  async health(): Promise<"connected" | "offline"> {
    return this.state === "connected" ? "connected" : "offline";
  }

  async startTurn(input: {
    threadId: string;
    prompt: string;
    idempotencyKey: string;
    model?: string;
    effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
    outputSchema?: Record<string, unknown>;
  }): Promise<{ threadId: string; turnId: string }> {
    if (this.state !== "connected") throw safeError("app_server_offline");
    // Resume is intentionally explicit: the cockpit only dispatches to existing,
    // immutably mapped agent threads and never fabricates a replacement thread.
    const resumed = await this.request(
      "thread/resume",
      {
        threadId: input.threadId,
        excludeTurns: true,
        permissions: ":workspace",
        runtimeWorkspaceRoots: [this.workspaceRoot],
      },
      threadResultSchema,
    );
    const params = {
      threadId: resumed.thread.id,
      input: [{ type: "text", text: input.prompt, text_elements: [] }],
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
      cwd: this.workspaceRoot,
      permissions: ":workspace",
      runtimeWorkspaceRoots: [this.workspaceRoot],
      approvalPolicy: "never",
    };
    // idempotencyKey remains local/outbox metadata. The current official request
    // schema has no idempotency field, so sending it would be unsafe.
    void input.idempotencyKey;
    const started = await this.request("turn/start", params, turnResultSchema);
    this.turnThreads.set(started.turn.id, resumed.thread.id);
    return { threadId: resumed.thread.id, turnId: started.turn.id };
  }

  async interruptTurn(turnId: string): Promise<"requested" | "not_found" | "uncertain"> {
    if (this.state !== "connected") return "not_found";
    const threadId = this.turnThreads.get(turnId);
    if (!threadId) return "not_found";
    try {
      await this.request("turn/interrupt", { threadId, turnId }, emptyResultSchema);
      return "requested";
    } catch {
      return "uncertain";
    }
  }

  private readonly onData: DataListener = (chunk) => {
    this.buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_JSONL_FRAME_BYTES && !this.buffer.includes("\n")) {
      this.failProtocol("protocol_frame_oversized");
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > MAX_JSONL_FRAME_BYTES) {
        this.failProtocol("protocol_frame_oversized");
        return;
      }
      if (line) this.handleLine(line);
      newline = this.buffer.indexOf("\n");
    }
  };

  private readonly onExit: ExitListener = () => {
    const child = this.process;
    if (child) this.detach(child);
    this.process = null;
    this.state = "stopped";
    this.rejectPending("app_server_exited");
    this.emit?.({
      type: "process_stopped",
      reason: "exit",
      ...(this.lastDiagnostic ? { diagnostic: this.lastDiagnostic } : {}),
    });
  };

  private readonly onStderr: DataListener = (chunk) => {
    const value = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    const diagnostic = classifyAppServerStderr(value);
    if (diagnostic) this.lastDiagnostic = diagnostic;
  };

  private handleLine(line: string): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      this.failProtocol("protocol_invalid_json");
      return;
    }
    const parsed = rpcMessageSchema.safeParse(decoded);
    if (!parsed.success) {
      this.failProtocol("protocol_invalid_message");
      return;
    }
    const message = parsed.data;
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(safeError(`app_server_rpc_${message.error.code}`));
      else {
        try {
          pending.resolve(pending.sanitize(message.result));
        } catch {
          pending.reject(safeError("app_server_invalid_result"));
        }
      }
      return;
    }
    if (message.method === "turn/started" || message.method === "turn/completed") {
      const notification = turnNotificationSchema.safeParse(message.params);
      if (!notification.success) return;
      const { threadId, turn } = notification.data;
      if (threadId) this.turnThreads.set(turn.id, threadId);
      if (message.method === "turn/started") {
        this.emit?.({ type: "turn_started", ...(threadId ? { threadId } : {}), turnId: turn.id });
      } else {
        const collected = this.completedAgentMessages.get(turn.id) ?? this.agentMessageBuffers.get(turn.id);
        this.completedAgentMessages.delete(turn.id);
        this.agentMessageBuffers.delete(turn.id);
        const finalMessage = collected ? sanitizeVisibleAgentMessage(collected) : undefined;
        this.emit?.({
          type: "turn_completed",
          ...(threadId ? { threadId } : {}),
          turnId: turn.id,
          status: normalizeTurnStatus(turn.status),
          ...(finalMessage ? { finalMessage } : {}),
        });
      }
      return;
    }
    if (message.method === "item/agentMessage/delta") {
      const notification = agentMessageDeltaSchema.safeParse(message.params);
      if (!notification.success) return;
      const current = this.agentMessageBuffers.get(notification.data.turnId) ?? "";
      this.agentMessageBuffers.set(
        notification.data.turnId,
        truncateUtf8(`${current}${notification.data.delta}`, MAX_AGENT_MESSAGE_BUFFER_BYTES),
      );
      if (notification.data.threadId) this.turnThreads.set(notification.data.turnId, notification.data.threadId);
      return;
    }
    if (message.method === "item/completed") {
      const notification = agentMessageCompletedSchema.safeParse(message.params);
      if (!notification.success) return;
      this.completedAgentMessages.set(
        notification.data.turnId,
        truncateUtf8(notification.data.item.text, MAX_AGENT_MESSAGE_BUFFER_BYTES),
      );
      if (notification.data.threadId) this.turnThreads.set(notification.data.turnId, notification.data.threadId);
    }
  }

  private request<T>(method: string, params: unknown, resultSchema: z.ZodType<T>): Promise<T> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(safeError("app_server_request_timeout"));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, sanitize: (value) => resultSchema.parse(value) });
      try {
        this.write({ id, method, params });
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(safeError("app_server_write_failed"));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private write(message: unknown): void {
    if (!this.process) throw safeError("app_server_offline");
    const accepted = this.process.stdin.write(`${JSON.stringify(message)}\n`);
    if (!accepted) throw safeError("app_server_backpressure");
  }

  private failProtocol(diagnostic: AppServerDiagnostic): void {
    this.lastDiagnostic = diagnostic;
    const child = this.process;
    if (child) this.detach(child);
    this.process = null;
    this.state = "stopped";
    this.rejectPending("app_server_protocol_error");
    child?.kill("SIGTERM");
    this.emit?.({
      type: "process_stopped",
      reason: "protocol_error",
      ...(this.lastDiagnostic ? { diagnostic: this.lastDiagnostic } : {}),
    });
  }

  private rejectPending(code: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(safeError(code));
    }
    this.pending.clear();
  }

  private detach(child: StdioProcess): void {
    child.stdout.off("data", this.onData);
    child.stderr?.off("data", this.onStderr);
    child.off("exit", this.onExit);
  }
}

const nodeSpawner: StdioProcessSpawner = {
  spawn(command, args) {
    return spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }) as unknown as StdioProcess;
  },
};

function boundedTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 50), 120_000);
}

function normalizeTurnStatus(status?: string): "completed" | "interrupted" | "failed" | "unknown" {
  if (status === "completed" || status === "interrupted" || status === "failed") return status;
  return "unknown";
}

function safeError(code: string): Error {
  const error = new Error(code);
  error.name = "CodexAppServerError";
  return error;
}

function classifyAppServerStderr(value: string): AppServerDiagnostic | undefined {
  const normalized = value.toLowerCase();
  if (normalized.includes("not logged in") || normalized.includes("authentication")) return "auth_missing";
  if (normalized.includes("no rollout found") || normalized.includes("thread id")) return "thread_missing";
  if (normalized.includes("stream disconnected")) return "provider_stream_disconnected";
  if (
    normalized.includes("error sending request")
    || normalized.includes("request failed")
    || normalized.includes("api.openai.com")
    || normalized.includes("chatgpt.com")
  ) {
    return "provider_request_failed";
  }
  return undefined;
}

export function sanitizeVisibleAgentMessage(value: string): string | undefined {
  const redacted = value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\b(authorization|api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, "[redacted-credential]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted-credential]")
    .trim();
  if (!redacted) return undefined;
  // Preserve the full bounded response for the orchestration parser. The
  // owner-visible portion is separately capped after the control fence is removed.
  return truncateUtf8(redacted, MAX_AGENT_MESSAGE_BUFFER_BYTES);
}

export function truncateOwnerVisibleMessage(value: string): string {
  return truncateUtf8(value, MAX_OWNER_VISIBLE_MESSAGE_BYTES);
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return value;
  return encoded.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, "");
}
