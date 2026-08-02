import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresCodexDispatchOutbox } from "@/lib/codex";

type Call = { sql: string; params: readonly unknown[] };
type Answer = { rows: unknown[]; rowCount?: number };

function fakePool(handler: (sql: string, params: readonly unknown[]) => Answer): { pool: Pool; calls: Call[] } {
  const calls: Call[] = [];
  const query = async (sql: string, params: readonly unknown[] = []) => {
    calls.push({ sql, params });
    const answer = handler(sql, params);
    return { ...answer, rowCount: answer.rowCount ?? answer.rows.length };
  };
  const client = { query, release: () => undefined };
  return { pool: { query, connect: async () => client } as unknown as Pool, calls };
}

const commandId = "10000000-0000-4000-8000-000000000001";
const expiresAt = new Date(Date.now() + 60_000);

function claimRow(threadId: string | null = "ceo-thread") {
  return {
    outboxId: "42",
    commandId,
    idempotencyKey: "owner-command-10000000",
    expectedAggregateVersion: 7,
    commandType: "owner.message",
    commandPayload: { message: "Prepare the local company brief." },
    outboxPayload: { commandId, commandType: "owner.message", expectedAggregateVersion: 7 },
    expiresAt,
    threadId,
  };
}

describe("Postgres Codex dispatch outbox", () => {
  it("claims one CEO command with SKIP LOCKED and a safe configured envelope", async () => {
    const fake = fakePool((sql) => {
      if (sql.includes("cockpit_pause")) return { rows: [{ state: "running" }] };
      if (sql.includes("FROM cockpit_outbox o")) return { rows: [claimRow()] };
      if (sql.includes("UPDATE cockpit_outbox SET state = 'leased'")) return { rows: [{ id: "42" }] };
      return { rows: [] };
    });
    const outbox = new PostgresCodexDispatchOutbox(fake.pool, { model: "gpt-5.6-sol", effort: "high" });

    const result = await outbox.claimNext("supervisor-1", new Date(Date.now() + 15_000));

    expect(result?.envelope).toMatchObject({
      dispatchId: commandId,
      agentId: "ceo",
      threadId: "ceo-thread",
      model: "gpt-5.6-sol",
      effort: "high",
    });
    expect(result?.envelope.prompt).toContain("Owner message: Prepare the local company brief.");
    expect(result?.envelope.prompt).toContain("company-delegations");
    const selection = fake.calls.find(({ sql }) => sql.includes("FROM cockpit_outbox o"))?.sql ?? "";
    expect(selection).toContain("FOR UPDATE OF o, c SKIP LOCKED");
    expect(selection).toContain("blocker.state IN ('leased','sent')");
    expect(fake.calls.some(({ sql }) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(fake.calls.some(({ sql }) => sql.trim() === "COMMIT")).toBe(true);
  });

  it("releases before send when the immutable CEO thread is missing", async () => {
    const fake = fakePool((sql) => {
      if (sql.includes("cockpit_pause")) return { rows: [{ state: "running" }] };
      return sql.includes("FROM cockpit_outbox o") ? { rows: [claimRow(null)] } : { rows: [] };
    });
    const result = await new PostgresCodexDispatchOutbox(fake.pool).claimNext(
      "supervisor-1",
      new Date(Date.now() + 15_000),
    );
    expect(result).toBeNull();
    expect(fake.calls.some(({ sql }) => sql.includes("available_at = now() + interval '1 second'"))).toBe(true);
    expect(fake.calls.some(({ sql }) => sql.includes("state = 'leased'"))).toBe(false);
  });

  it("marks the owner message failed when a command expires before send", async () => {
    const fake = fakePool((sql) => {
      if (sql.includes("cockpit_pause")) return { rows: [{ state: "running" }] };
      if (sql.includes("FROM cockpit_outbox o")) {
        return { rows: [{ ...claimRow(), expiresAt: new Date(Date.now() - 1_000) }] };
      }
      return { rows: [] };
    });

    const result = await new PostgresCodexDispatchOutbox(fake.pool).claimNext(
      "supervisor-1",
      new Date(Date.now() + 15_000),
    );

    expect(result).toBeNull();
    expect(fake.calls.some(({ sql }) => sql.includes("cockpit_messages SET status = 'failed'"))).toBe(true);
    expect(fake.calls.some(({ sql }) => sql.includes("state = 'leased'"))).toBe(false);
  });

  it("atomically persists acceptance and an audit event with the CEO model", async () => {
    const fake = fakePool((sql) => {
      if (sql.includes("UPDATE cockpit_outbox SET state = 'sent'")) return { rows: [{ id: "42" }] };
      if (sql.includes("UPDATE cockpit_commands SET state = 'dispatched'")) return { rows: [{ id: commandId }] };
      return { rows: [] };
    });
    const outbox = new PostgresCodexDispatchOutbox(fake.pool, { model: "gpt-5.6-sol", effort: "high" });
    await outbox.markAccepted(commandId, {
      status: "accepted",
      transport: "app-server-v2",
      remoteThreadId: "ceo-thread",
      remoteTurnId: "turn-1",
      acceptedAt: new Date().toISOString(),
    });
    const event = fake.calls.find(({ sql }) => sql.includes("INSERT INTO cockpit_events"));
    expect(event?.params[2]).toMatchObject({ model: "gpt-5.6-sol", effort: "high", remoteTurnId: "turn-1" });
    expect(fake.calls.find(({ sql }) => sql.includes("remote_thread_id = $3"))?.params.slice(2)).toEqual(["ceo-thread", "turn-1"]);
    expect(fake.calls.some(({ sql }) => sql.includes("cockpit_messages SET status = 'dispatched'"))).toBe(true);
    expect(fake.calls.some(({ sql }) => sql.trim() === "COMMIT")).toBe(true);
  });

  it("atomically persists the correlated CEO reply and completes its command", async () => {
    const fake = fakePool((sql) => {
      if (sql.includes("SELECT id, state, remote_thread_id")) {
        return { rows: [{ id: commandId, state: "dispatched", remote_thread_id: "ceo-thread" }] };
      }
      if (sql.includes("UPDATE cockpit_commands SET state = 'completed'")) return { rows: [{ id: commandId }] };
      return { rows: [] };
    });
    const result = await new PostgresCodexDispatchOutbox(fake.pool).completeTurn({
      remoteTurnId: "turn-1",
      remoteThreadId: "ceo-thread",
      status: "completed",
      finalMessage: "Local work completed.",
    });
    expect(result).toBe("completed");
    expect(fake.calls.find(({ sql }) => sql.includes("INSERT INTO cockpit_messages"))?.params).toEqual([
      commandId,
      "Local work completed.",
      "completed",
    ]);
    expect(fake.calls.some(({ sql }) => sql.trim() === "COMMIT")).toBe(true);
  });

  it("reconciles a completed authoritative turn without resending it", async () => {
    const fake = fakePool((sql) => {
      if (sql.includes("SELECT id, state, remote_thread_id")) {
        return {
          rows: [{
            id: commandId,
            state: "reconciliation_required",
            remote_thread_id: "ceo-thread",
          }],
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const result = await new PostgresCodexDispatchOutbox(fake.pool).reconcileAuthoritativeCompletion({
      remoteTurnId: "turn-1",
      remoteThreadId: "ceo-thread",
      finalMessage: "The local CEO task is complete.",
    });

    expect(result).toBe("completed");
    expect(fake.calls.some(({ params }) => params.includes("codex.turn.authoritatively_reconciled"))).toBe(true);
    expect(fake.calls.some(({ sql }) => sql.includes("state = 'completed'"))).toBe(true);
    expect(fake.calls.some(({ sql }) => sql.trim() === "COMMIT")).toBe(true);
  });

  it("requires reconciliation when a completed turn has no visible CEO reply", async () => {
    const fake = fakePool((sql) => sql.includes("SELECT id, state, remote_thread_id")
      ? { rows: [{ id: commandId, state: "dispatched", remote_thread_id: "ceo-thread" }] }
      : { rows: [] });
    const result = await new PostgresCodexDispatchOutbox(fake.pool).completeTurn({
      remoteTurnId: "turn-1",
      remoteThreadId: "ceo-thread",
      status: "completed",
    });
    expect(result).toBe("reconciliation_required");
    expect(fake.calls.some(({ sql }) => sql.includes("state = 'reconciliation_required'"))).toBe(true);
    expect(fake.calls.some(({ sql }) => sql.includes("INSERT INTO cockpit_messages"))).toBe(false);
  });

  it("rejects a sensitive CEO reply before persisting any response text", async () => {
    const sensitiveReply = "Send the result to customer@example.com.";
    const fake = fakePool((sql) => sql.includes("SELECT id, state, remote_thread_id")
      ? { rows: [{ id: commandId, state: "dispatched", remote_thread_id: "ceo-thread" }] }
      : { rows: [] });

    const result = await new PostgresCodexDispatchOutbox(fake.pool).completeTurn({
      remoteTurnId: "turn-1",
      remoteThreadId: "ceo-thread",
      status: "completed",
      finalMessage: sensitiveReply,
    });

    expect(result).toBe("reconciliation_required");
    expect(fake.calls.some(({ sql }) => sql.includes("INSERT INTO cockpit_messages"))).toBe(false);
    expect(fake.calls.some(({ params }) => params.includes(sensitiveReply))).toBe(false);
    expect(fake.calls.find(({ sql }) => sql.includes("INSERT INTO cockpit_events"))?.params[2])
      .toEqual({ code: "sensitive_result_rejected" });
  });

  it("rolls back acceptance if the command transition is no longer valid", async () => {
    const fake = fakePool((sql) => sql.includes("UPDATE cockpit_outbox SET state = 'sent'")
      ? { rows: [{ id: "42" }] }
      : { rows: [] });
    await expect(new PostgresCodexDispatchOutbox(fake.pool).markAccepted(commandId, {
      status: "accepted",
      transport: "demo-v1",
      remoteThreadId: "demo-ceo-local",
      remoteTurnId: "demo-turn",
      acceptedAt: new Date().toISOString(),
    })).rejects.toThrow("CODEX_COMMAND_NOT_PENDING");
    expect(fake.calls.some(({ sql }) => sql.trim() === "ROLLBACK")).toBe(true);
    expect(fake.calls.some(({ sql }) => sql.includes("INSERT INTO cockpit_events"))).toBe(false);
  });
});
