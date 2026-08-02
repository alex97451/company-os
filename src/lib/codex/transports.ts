import { createHash } from "node:crypto";
import {
  SUPPORTED_APP_SERVER_PROTOCOLS,
  dispatchEnvelopeSchema,
  type CodexTransport,
  type DispatchEnvelope,
  type DispatchReceipt,
} from "./contracts";

export interface AppServerClient {
  protocolVersion(): Promise<string>;
  health(): Promise<"connected" | "offline">;
  startTurn(input: { threadId: string; prompt: string; idempotencyKey: string; model?: string; effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"; outputSchema?: Record<string, unknown> }): Promise<{ threadId: string; turnId: string }>;
  interruptTurn?(turnId: string): Promise<"requested" | "not_found" | "uncertain">;
}

export class AppServerV2Transport implements CodexTransport {
  readonly kind = "app-server-v2" as const;

  constructor(private readonly client: AppServerClient) {}

  async health(): Promise<"connected" | "degraded" | "offline"> {
    try {
      if ((await this.client.health()) === "offline") return "offline";
      return isSupportedProtocol(await this.client.protocolVersion()) ? "connected" : "degraded";
    } catch {
      return "offline";
    }
  }

  async dispatch(input: DispatchEnvelope): Promise<DispatchReceipt> {
    const envelope = dispatchEnvelopeSchema.parse(input);
    if (Date.parse(envelope.expiresAt) <= Date.now()) return { status: "rejected", transport: this.kind, code: "expired" };
    try {
      if (!isSupportedProtocol(await this.client.protocolVersion())) {
        return { status: "rejected", transport: this.kind, code: "unsupported_protocol" };
      }
      const result = await this.client.startTurn({
        threadId: envelope.threadId,
        prompt: envelope.prompt,
        idempotencyKey: envelope.idempotencyKey,
        ...(envelope.model ? { model: envelope.model } : {}),
        ...(envelope.effort ? { effort: envelope.effort } : {}),
        ...(envelope.outputSchema ? { outputSchema: envelope.outputSchema } : {}),
      });
      return { status: "accepted", transport: this.kind, remoteThreadId: result.threadId, remoteTurnId: result.turnId, acceptedAt: new Date().toISOString() };
    } catch {
      // A transport exception cannot establish whether Codex accepted the turn.
      return { status: "uncertain", transport: this.kind, code: "send_outcome_unknown" };
    }
  }

  async interrupt(remoteTurnId: string): Promise<"requested" | "not_found" | "uncertain"> {
    if (!this.client.interruptTurn) return "uncertain";
    try {
      return await this.client.interruptTurn(remoteTurnId);
    } catch {
      return "uncertain";
    }
  }
}

export interface ExecResumeRunner {
  resume(input: { threadId: string; prompt: string }): Promise<{ threadId: string; turnId: string }>;
  available(): Promise<boolean>;
}

export class ExecResumeTransport implements CodexTransport {
  readonly kind = "exec-resume-v1" as const;
  constructor(private readonly runner: ExecResumeRunner) {}

  async health(): Promise<"degraded" | "offline"> {
    try {
      return (await this.runner.available()) ? "degraded" : "offline";
    } catch {
      return "offline";
    }
  }

  async dispatch(input: DispatchEnvelope): Promise<DispatchReceipt> {
    const envelope = dispatchEnvelopeSchema.parse(input);
    if (Date.parse(envelope.expiresAt) <= Date.now()) return { status: "rejected", transport: this.kind, code: "expired" };
    try {
      const result = await this.runner.resume({ threadId: envelope.threadId, prompt: envelope.prompt });
      return { status: "accepted", transport: this.kind, remoteThreadId: result.threadId, remoteTurnId: result.turnId, acceptedAt: new Date().toISOString() };
    } catch {
      return { status: "uncertain", transport: this.kind, code: "send_outcome_unknown" };
    }
  }
}

export class DeterministicDemoTransport implements CodexTransport {
  readonly kind = "demo-v1" as const;
  constructor(private readonly seed = "company-os-test-double") {}

  async health(): Promise<"connected"> {
    return "connected";
  }

  async dispatch(input: DispatchEnvelope): Promise<DispatchReceipt> {
    const envelope = dispatchEnvelopeSchema.parse(input);
    if (Date.parse(envelope.expiresAt) <= Date.now()) return { status: "rejected", transport: this.kind, code: "expired" };
    const digest = createHash("sha256").update(`${this.seed}:${envelope.idempotencyKey}`).digest("hex").slice(0, 24);
    return { status: "accepted", transport: this.kind, remoteThreadId: envelope.threadId, remoteTurnId: `demo-${digest}`, acceptedAt: "2026-07-20T00:00:00.000Z" };
  }
}

function isSupportedProtocol(value: string): value is (typeof SUPPORTED_APP_SERVER_PROTOCOLS)[number] {
  return (SUPPORTED_APP_SERVER_PROTOCOLS as readonly string[]).includes(value);
}
