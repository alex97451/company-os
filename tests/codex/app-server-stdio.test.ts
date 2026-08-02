import { EventEmitter } from "node:events";
import nodeProcess from "node:process";
import { describe, expect, it, vi } from "vitest";
import { AppServerV2Transport, CodexAppServerStdioClient, type AppServerLifecycleEvent, type DispatchEnvelope, type StdioProcess, type StdioProcessSpawner } from "@/lib/codex";

type RpcWrite = { id?: number; method: string; params: Record<string, unknown> };

class FakeStdioProcess implements StdioProcess {
  readonly writes: RpcWrite[] = [];
  readonly stdoutEmitter = new EventEmitter();
  readonly processEmitter = new EventEmitter();
  readonly stdout = {
    on: (event: "data", listener: (chunk: Uint8Array | string) => void) => this.stdoutEmitter.on(event, listener),
    off: (event: "data", listener: (chunk: Uint8Array | string) => void) => this.stdoutEmitter.off(event, listener),
  };
  readonly stdin = {
    write: (data: string) => {
      const message = JSON.parse(data.trim()) as RpcWrite;
      this.writes.push(message);
      this.onWrite?.(message);
      return true;
    },
    end: () => queueMicrotask(() => this.processEmitter.emit("exit", 0, null)),
  };
  killedWith: NodeJS.Signals | undefined;
  onWrite?: (message: RpcWrite) => void;

  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void) { this.processEmitter.on(event, listener); return this; }
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void) { this.processEmitter.off(event, listener); return this; }
  kill(signal?: NodeJS.Signals) { this.killedWith = signal; queueMicrotask(() => this.processEmitter.emit("exit", null, signal ?? null)); return true; }
  respond(id: number, result: unknown) { this.stdoutEmitter.emit("data", `${JSON.stringify({ id, result })}\n`); }
  notify(method: string, params: unknown) { this.stdoutEmitter.emit("data", `${JSON.stringify({ method, params })}\n`); }
}

function harness(options: { requestTimeoutMs?: number; events?: AppServerLifecycleEvent[] } = {}) {
  const process = new FakeStdioProcess();
  const spawn = vi.fn(() => process);
  const spawner: StdioProcessSpawner = { spawn };
  const client = new CodexAppServerStdioClient({
    spawner,
    requestTimeoutMs: options.requestTimeoutMs ?? 500,
    shutdownTimeoutMs: 50,
    onLifecycleEvent: options.events ? (event) => options.events?.push(event) : undefined,
  });
  return { client, process, spawn };
}

async function startConnected() {
  const test = harness();
  test.process.onWrite = (message) => {
    if (message.method === "initialize" && message.id !== undefined) queueMicrotask(() => test.process.respond(message.id!, { userAgent: "test" }));
  };
  await test.client.start();
  return test;
}

describe("Codex app-server stdio client", () => {
  it("does not spawn until explicitly started and performs the official handshake", async () => {
    const { client, process, spawn } = harness();
    expect(spawn).not.toHaveBeenCalled();
    process.onWrite = (message) => {
      if (message.method === "initialize" && message.id !== undefined) queueMicrotask(() => process.respond(message.id!, { userAgent: "test" }));
    };

    await client.start();
    expect(spawn).toHaveBeenCalledWith("codex", ["app-server", "--listen", "stdio://"]);
    expect(process.writes.map((entry) => entry.method)).toEqual(["initialize", "initialized"]);
    expect(process.writes[0]?.params).toMatchObject({
      clientInfo: { name: "company_os" },
      capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
    });
    await expect(client.health()).resolves.toBe("connected");
    await client.stop();
  });

  it("resumes the mapped thread then starts a turn with model and effort", async () => {
    const { client, process } = await startConnected();
    process.onWrite = (message) => {
      if (message.method === "thread/resume" && message.id !== undefined) queueMicrotask(() => process.respond(message.id!, { thread: { id: "thread-ceo", ignoredHistory: ["never persisted"] } }));
      if (message.method === "turn/start" && message.id !== undefined) queueMicrotask(() => process.respond(message.id!, { turn: { id: "turn-42" } }));
    };

    await expect(client.startTurn({ threadId: "thread-ceo", prompt: "Inspect local priorities.", idempotencyKey: "dispatch-safe-idempotency", model: "gpt-5.6-terra", effort: "medium" })).resolves.toEqual({ threadId: "thread-ceo", turnId: "turn-42" });
    const resume = process.writes.find((entry) => entry.method === "thread/resume");
    const turn = process.writes.find((entry) => entry.method === "turn/start");
    expect(resume?.params).toEqual({
      threadId: "thread-ceo",
      excludeTurns: true,
      permissions: ":workspace",
      runtimeWorkspaceRoots: [nodeProcess.cwd()],
    });
    expect(turn?.params).toEqual({
      threadId: "thread-ceo",
      input: [{ type: "text", text: "Inspect local priorities.", text_elements: [] }],
      model: "gpt-5.6-terra",
      effort: "medium",
      cwd: nodeProcess.cwd(),
      permissions: ":workspace",
      runtimeWorkspaceRoots: [nodeProcess.cwd()],
      approvalPolicy: "never",
    });
    expect(JSON.stringify(turn)).not.toContain("dispatch-safe-idempotency");
    await client.stop();
  });

  it("collects only allowlisted lifecycle IDs and normalized status", async () => {
    const events: AppServerLifecycleEvent[] = [];
    const test = harness({ events });
    test.process.onWrite = (message) => {
      if (message.method === "initialize" && message.id !== undefined) queueMicrotask(() => test.process.respond(message.id!, {}));
    };
    await test.client.start();
    test.process.notify("item/reasoning/delta", { delta: "sensitive hidden reasoning" });
    test.process.notify("turn/started", { threadId: "thread-ceo", turn: { id: "turn-1", hidden: "discard" } });
    test.process.notify("turn/completed", { threadId: "thread-ceo", turn: { id: "turn-1", status: "mystery", output: "discard" } });

    expect(events).toEqual([
      { type: "turn_started", threadId: "thread-ceo", turnId: "turn-1" },
      { type: "turn_completed", threadId: "thread-ceo", turnId: "turn-1", status: "unknown" },
    ]);
    expect(JSON.stringify(events)).not.toContain("sensitive hidden reasoning");
    await test.client.stop();
  });

  it("emits only the bounded redacted final visible agent message", async () => {
    const events: AppServerLifecycleEvent[] = [];
    const test = harness({ events });
    test.process.onWrite = (message) => {
      if (message.method === "initialize" && message.id !== undefined) queueMicrotask(() => test.process.respond(message.id!, {}));
    };
    await test.client.start();
    test.process.notify("item/agentMessage/delta", {
      threadId: "thread-ceo", turnId: "turn-safe", itemId: "item-1", delta: "Contact ceo@example.com. token=abc123. ",
    });
    test.process.notify("item/agentMessage/delta", {
      threadId: "thread-ceo", turnId: "turn-safe", itemId: "item-1", delta: "Travail local terminé.",
    });
    test.process.notify("turn/completed", { threadId: "thread-ceo", turn: { id: "turn-safe", status: "completed" } });

    expect(events.at(-1)).toEqual({
      type: "turn_completed",
      threadId: "thread-ceo",
      turnId: "turn-safe",
      status: "completed",
      finalMessage: "Contact [redacted-email]. token=[redacted] Travail local terminé.",
    });
    await test.client.stop();
  });

  it("supports turn interruption using the recorded thread correlation", async () => {
    const { client, process } = await startConnected();
    process.onWrite = (message) => {
      if (message.method === "thread/resume" && message.id !== undefined) queueMicrotask(() => process.respond(message.id!, { thread: { id: "thread-ceo" } }));
      if (message.method === "turn/start" && message.id !== undefined) queueMicrotask(() => process.respond(message.id!, { turn: { id: "turn-7" } }));
      if (message.method === "turn/interrupt" && message.id !== undefined) queueMicrotask(() => process.respond(message.id!, {}));
    };
    await client.startTurn({ threadId: "thread-ceo", prompt: "Work locally.", idempotencyKey: "dispatch-interrupt-123" });
    await expect(client.interruptTurn("turn-7")).resolves.toBe("requested");
    expect(process.writes.find((entry) => entry.method === "turn/interrupt")?.params).toEqual({ threadId: "thread-ceo", turnId: "turn-7" });
    await client.stop();
  });

  it("makes a post-send timeout uncertain and never retries through the adapter", async () => {
    const { client, process } = harness({ requestTimeoutMs: 50 });
    process.onWrite = (message) => {
      if (message.method === "initialize" && message.id !== undefined) queueMicrotask(() => process.respond(message.id!, {}));
      if (message.method === "thread/resume" && message.id !== undefined) queueMicrotask(() => process.respond(message.id!, { thread: { id: "thread-ceo" } }));
      // turn/start was accepted by stdin but its response is deliberately lost.
    };
    await client.start();
    const transport = new AppServerV2Transport(client);
    const envelope: DispatchEnvelope = {
      dispatchId: "10000000-0000-4000-8000-000000000001", runId: "10000000-0000-4000-8000-000000000002",
      agentId: "ceo", threadId: "thread-ceo", prompt: "Local task", model: "gpt-5.6-terra", effort: "low",
      idempotencyKey: "dispatch-timeout-safe", expectedAggregateVersion: 1, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await expect(transport.dispatch(envelope)).resolves.toEqual({ status: "uncertain", transport: "app-server-v2", code: "send_outcome_unknown" });
    expect(process.writes.filter((entry) => entry.method === "turn/start")).toHaveLength(1);
    await client.stop();
    });
  });

  it("uses an explicit local Codex executable without invoking a shell", async () => {
    const process = new FakeStdioProcess();
    const spawn = vi.fn(() => process);
    const client = new CodexAppServerStdioClient({
      command: "work/codex-local.exe",
      spawner: { spawn },
      requestTimeoutMs: 500,
      shutdownTimeoutMs: 50,
    });
    process.onWrite = (message) => {
      if (message.method === "initialize" && message.id !== undefined) {
        queueMicrotask(() => process.respond(message.id!, { userAgent: "test" }));
      }
    };

    await client.start();
    expect(spawn).toHaveBeenCalledWith(
      "work/codex-local.exe",
      ["app-server", "--listen", "stdio://"],
    );
    await client.stop();
  });
