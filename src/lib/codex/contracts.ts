import { z } from "zod";
import { companyAgentIdSchema } from "@/lib/agents/registry";

export const CODEX_BRIDGE_API_VERSION = "company-os-codex-bridge/v1" as const;
export const SUPPORTED_APP_SERVER_PROTOCOLS = ["codex-app-server/v2"] as const;

export const bridgeHealthSchema = z.enum([
  "connected",
  "degraded",
  "offline",
  "reconciliation_required",
]);

export type BridgeHealth = z.infer<typeof bridgeHealthSchema>;

export const dispatchEnvelopeSchema = z.object({
  dispatchId: z.string().uuid(),
  // Owner-to-CEO commands are dispatchable before the CEO creates a task/run.
  // Run dispatches still carry this correlation when one already exists.
  runId: z.string().uuid().optional(),
  agentId: companyAgentIdSchema,
  threadId: z.string().min(1).max(256),
  prompt: z.string().min(1).max(32_000),
  model: z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/).optional(),
  effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().min(16).max(256),
  expectedAggregateVersion: z.number().int().nonnegative(),
  expiresAt: z.string().datetime(),
});

export type DispatchEnvelope = z.infer<typeof dispatchEnvelopeSchema>;

export type DispatchReceipt =
  | {
      status: "accepted";
      transport: TransportKind;
      remoteThreadId: string;
      remoteTurnId: string;
      acceptedAt: string;
    }
  | {
      status: "rejected";
      transport: TransportKind;
      code: "expired" | "stale" | "offline" | "unsupported_protocol" | "policy_rejected";
    }
  | {
      status: "uncertain";
      transport: TransportKind;
      code: "send_outcome_unknown";
    };

export type TransportKind = "app-server-v2" | "exec-resume-v1" | "demo-v1";

export interface CodexTransport {
  readonly kind: TransportKind;
  health(): Promise<Exclude<BridgeHealth, "reconciliation_required">>;
  dispatch(envelope: DispatchEnvelope): Promise<DispatchReceipt>;
  interrupt?(remoteTurnId: string): Promise<"requested" | "not_found" | "uncertain">;
}

export type OutboxRecord = {
  envelope: DispatchEnvelope;
  state: "claimed";
};

/**
 * Implementations must claim and transition records transactionally. Only one
 * supervisor may own a dispatch at once.
 */
export interface CodexDispatchOutbox {
  claimNext(ownerId: string, leaseUntil: Date): Promise<OutboxRecord | null>;
  markAccepted(dispatchId: string, receipt: Extract<DispatchReceipt, { status: "accepted" }>): Promise<void>;
  markRejected(dispatchId: string, receipt: Extract<DispatchReceipt, { status: "rejected" }>): Promise<void>;
  markReconciliationRequired(
    dispatchId: string,
    metadata: { transport: TransportKind; code: "send_outcome_unknown" | "persistence_after_accept_failed" },
  ): Promise<void>;
  releaseClaim(dispatchId: string, reason: "transport_unavailable"): Promise<void>;
}

export const safeCodexEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent_state"), agentId: companyAgentIdSchema, state: z.enum(["waiting", "working", "action_required", "done", "problem"]), message: z.string().max(2_000).optional() }),
  z.object({ type: z.literal("task_progress"), agentId: companyAgentIdSchema, runId: z.string().uuid(), summary: z.string().max(4_000), percent: z.number().int().min(0).max(100).optional() }),
  z.object({ type: z.literal("dispatch_ack"), runId: z.string().uuid(), remoteThreadId: z.string().max(256), remoteTurnId: z.string().max(256) }),
  z.object({ type: z.literal("turn_completed"), runId: z.string().uuid(), summary: z.string().max(4_000) }),
  z.object({ type: z.literal("turn_failed"), runId: z.string().uuid(), code: z.string().regex(/^[a-z0-9_]{1,64}$/), safeMessage: z.string().max(2_000) }),
  z.object({ type: z.literal("artifact_ready"), runId: z.string().uuid(), label: z.string().max(256), path: z.string().max(1_024) }),
]);

export type SafeCodexEvent = z.infer<typeof safeCodexEventSchema> & {
  bridgeVersion: typeof CODEX_BRIDGE_API_VERSION;
  occurredAt: string;
};
