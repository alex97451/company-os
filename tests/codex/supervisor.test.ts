import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CodexDispatchSupervisor, type CodexDispatchOutbox, type CodexTransport, type DispatchEnvelope, type DispatchReceipt } from "@/lib/codex";

function envelope(): DispatchEnvelope {
  return {
    dispatchId: randomUUID(), runId: randomUUID(), agentId: "ceo", threadId: "ceo-thread",
    prompt: "Prepare a local-only status report.", idempotencyKey: `dispatch-${randomUUID()}`,
    expectedAggregateVersion: 1, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function outbox(input: DispatchEnvelope) {
  return {
    claimNext: vi.fn(async () => ({ envelope: input, state: "claimed" as const })),
    markAccepted: vi.fn(async () => undefined),
    markRejected: vi.fn(async () => undefined),
    markReconciliationRequired: vi.fn(async () => undefined),
    releaseClaim: vi.fn(async () => undefined),
  } satisfies CodexDispatchOutbox;
}

function transport(kind: CodexTransport["kind"], health: "connected" | "degraded" | "offline", receipt: DispatchReceipt): CodexTransport & { dispatch: ReturnType<typeof vi.fn> } {
  return { kind, health: async () => health, dispatch: vi.fn(async () => receipt) };
}

describe("Codex dispatch supervisor", () => {
  it("uses exactly one healthy transport", async () => {
    const input = envelope();
    const store = outbox(input);
    const primary = transport("app-server-v2", "connected", { status: "accepted", transport: "app-server-v2", remoteThreadId: input.threadId, remoteTurnId: "turn-1", acceptedAt: new Date().toISOString() });
    const fallback = transport("exec-resume-v1", "degraded", { status: "accepted", transport: "exec-resume-v1", remoteThreadId: input.threadId, remoteTurnId: "turn-2", acceptedAt: new Date().toISOString() });
    const supervisor = new CodexDispatchSupervisor(store, primary, fallback);

    await expect(supervisor.processOne("worker-1")).resolves.toMatchObject({ status: "accepted" });
    expect(primary.dispatch).toHaveBeenCalledOnce();
    expect(fallback.dispatch).not.toHaveBeenCalled();
    expect(store.markAccepted).toHaveBeenCalledOnce();
  });

  it("uses degraded fallback only before any primary send", async () => {
    const input = envelope();
    const store = outbox(input);
    const primary = transport("app-server-v2", "degraded", { status: "uncertain", transport: "app-server-v2", code: "send_outcome_unknown" });
    const fallback = transport("exec-resume-v1", "degraded", { status: "accepted", transport: "exec-resume-v1", remoteThreadId: input.threadId, remoteTurnId: "turn-fallback", acceptedAt: new Date().toISOString() });
    const supervisor = new CodexDispatchSupervisor(store, primary, fallback);

    await expect(supervisor.processOne("worker-1")).resolves.toMatchObject({ status: "accepted" });
    expect(primary.dispatch).not.toHaveBeenCalled();
    expect(fallback.dispatch).toHaveBeenCalledOnce();
    expect(supervisor.health()).toBe("degraded");
  });

  it("circuit-breaks uncertainty and never retries through fallback", async () => {
    const input = envelope();
    const store = outbox(input);
    const primary = transport("app-server-v2", "connected", { status: "uncertain", transport: "app-server-v2", code: "send_outcome_unknown" });
    const fallback = transport("exec-resume-v1", "degraded", { status: "accepted", transport: "exec-resume-v1", remoteThreadId: input.threadId, remoteTurnId: "duplicate", acceptedAt: new Date().toISOString() });
    const supervisor = new CodexDispatchSupervisor(store, primary, fallback);

    await expect(supervisor.processOne("worker-1")).resolves.toEqual({ status: "reconciliation_required", dispatchId: input.dispatchId });
    expect(fallback.dispatch).not.toHaveBeenCalled();
    expect(store.markReconciliationRequired).toHaveBeenCalledWith(input.dispatchId, { transport: "app-server-v2", code: "send_outcome_unknown" });
    expect(supervisor.health()).toBe("reconciliation_required");
    await expect(supervisor.processOne("worker-1")).resolves.toEqual({ status: "supervisor_halted" });
    expect(store.claimNext).toHaveBeenCalledOnce();
  });

  it("halts when an accepted turn cannot be persisted", async () => {
    const input = envelope();
    const store = outbox(input);
    store.markAccepted.mockRejectedValueOnce(new Error("database unavailable"));
    const primary = transport("app-server-v2", "connected", { status: "accepted", transport: "app-server-v2", remoteThreadId: input.threadId, remoteTurnId: "accepted-but-not-recorded", acceptedAt: new Date().toISOString() });
    const supervisor = new CodexDispatchSupervisor(store, primary);

    await expect(supervisor.processOne("worker-1")).resolves.toEqual({ status: "reconciliation_required", dispatchId: input.dispatchId });
    expect(store.markReconciliationRequired).toHaveBeenCalledWith(input.dispatchId, { transport: "app-server-v2", code: "persistence_after_accept_failed" });
    await expect(supervisor.processOne("worker-1")).resolves.toEqual({ status: "supervisor_halted" });
    expect(primary.dispatch).toHaveBeenCalledOnce();
  });

  it("treats an adapter exception as uncertain and does not fall back", async () => {
    const input = envelope();
    const store = outbox(input);
    const primary = transport("app-server-v2", "connected", { status: "rejected", transport: "app-server-v2", code: "offline" });
    primary.dispatch.mockRejectedValueOnce(new Error("adapter contract violation"));
    const fallback = transport("exec-resume-v1", "degraded", { status: "accepted", transport: "exec-resume-v1", remoteThreadId: input.threadId, remoteTurnId: "duplicate", acceptedAt: new Date().toISOString() });
    const supervisor = new CodexDispatchSupervisor(store, primary, fallback);

    await expect(supervisor.processOne("worker-1")).resolves.toEqual({ status: "reconciliation_required", dispatchId: input.dispatchId });
    expect(store.markReconciliationRequired).toHaveBeenCalledWith(input.dispatchId, { transport: "app-server-v2", code: "send_outcome_unknown" });
    expect(fallback.dispatch).not.toHaveBeenCalled();
  });

  it("releases a claim when no transport is available", async () => {
    const input = envelope();
    const store = outbox(input);
    const primary = transport("app-server-v2", "offline", { status: "rejected", transport: "app-server-v2", code: "offline" });
    const supervisor = new CodexDispatchSupervisor(store, primary);
    await expect(supervisor.processOne("worker-1")).resolves.toEqual({ status: "transport_unavailable", dispatchId: input.dispatchId });
    expect(store.releaseClaim).toHaveBeenCalledWith(input.dispatchId, "transport_unavailable");
    expect(primary.dispatch).not.toHaveBeenCalled();
  });
});
