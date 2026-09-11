import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { CockpitRepository } from "@/lib/db/cockpit-repository";

type QueryCall = { sql: string; params: readonly unknown[] };
type QueryAnswer = { rows: unknown[]; rowCount: number };

function fakePool(handler: (sql: string, params: readonly unknown[]) => QueryAnswer): { pool: Pool; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const query = async (sql: string, params: readonly unknown[] = []) => {
    calls.push({ sql, params });
    return handler(sql, params);
  };
  const client = { query, release: () => undefined };
  return {
    pool: { query, connect: async () => client } as unknown as Pool,
    calls,
  };
}

const commandId = "dc1bd90f-66cc-412b-a017-e420489334fb";
const approvalId = "cf03ad7f-733a-45ee-9caf-20bf178c982d";
const taskId = "9fa9504f-45bb-420f-bc15-6a6de8c1e43b";
const digest = "a".repeat(64);

describe("cockpit repository atomic boundaries", () => {
  it("creates a CEO command, outbox item and event in one transaction", async () => {
    const fake = fakePool((sql) => ({
      rows: sql.includes("cockpit_owner_state") ? [{ commandVersion: 3 }] : sql.includes("INSERT INTO cockpit_commands") ? [{ id: commandId }] : [],
      rowCount: sql.includes("INSERT") ? 1 : 0,
    }));
    const repository = new CockpitRepository(fake.pool);

    await expect(repository.createOwnerCommand({
      idempotencyKey: "owner-command-0001",
      expectedAggregateVersion: 3,
      commandType: "owner.message",
      safePayload: {
        message: "Validate local cockpit with a structured internal contract",
        ownerVisibleMessage: "Le CEO prépare un bilan local en lecture seule.",
      },
      expiresAt: new Date(Date.now() + 60_000),
    })).resolves.toBe(commandId);

    expect(fake.calls.map(({ sql }) => sql.trim().split(/\s+/).slice(0, 4).join(" "))).toEqual(expect.arrayContaining([
      "BEGIN",
      "SET LOCAL statement_timeout =",
      "INSERT INTO cockpit_commands (id,",
      "INSERT INTO cockpit_messages (sender,",
      "INSERT INTO cockpit_outbox (command_id,",
      "INSERT INTO cockpit_events (event_type,",
      "COMMIT",
    ]));
    const outboxCall = fake.calls.find(({ sql }) => sql.includes("INSERT INTO cockpit_outbox"));
    expect(outboxCall?.params[1]).toMatchObject({ commandId, commandType: "owner.message" });
    const ownerMessageCall = fake.calls.find(({ sql }) => sql.includes("INSERT INTO cockpit_messages"));
    expect(ownerMessageCall?.params[1]).toBe("Le CEO prépare un bilan local en lecture seule.");
  });

  it("does not duplicate outbox work for an idempotent replay", async () => {
    const fake = fakePool((sql) => {
      if (sql.includes("SELECT id FROM cockpit_commands")) return { rows: [{ id: commandId }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const repository = new CockpitRepository(fake.pool);
    await repository.createOwnerCommand({
      idempotencyKey: "owner-command-0001",
      expectedAggregateVersion: 3,
      commandType: "owner.message",
      safePayload: {},
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(fake.calls.some(({ sql }) => sql.includes("INSERT INTO cockpit_outbox"))).toBe(false);
    expect(fake.calls.some(({ sql }) => sql.includes("INSERT INTO cockpit_events"))).toBe(false);
  });

  it("rejects a stale owner command before creating outbox work", async () => {
    const fake = fakePool((sql) => ({
      rows: sql.includes("cockpit_owner_state") ? [{ commandVersion: 4 }] : [],
      rowCount: 0,
    }));
    const repository = new CockpitRepository(fake.pool);
    await expect(repository.createOwnerCommand({
      idempotencyKey: "owner-command-stale",
      expectedAggregateVersion: 3,
      commandType: "owner.message",
      safePayload: { message: "stale" },
      expiresAt: new Date(Date.now() + 60_000),
    })).rejects.toThrow("COMMAND_STALE_VERSION");
    expect(fake.calls.some(({ sql }) => sql.includes("INSERT INTO cockpit_outbox"))).toBe(false);
  });

  it("atomically refuses a stale approval digest and rolls back", async () => {
    const fake = fakePool(() => ({ rows: [], rowCount: 0 }));
    const repository = new CockpitRepository(fake.pool);
    await expect(repository.decideApproval({
      approvalId,
      actionDigest: digest,
      policyVersion: 2,
      actionVersion: 1,
      decision: "approved",
    })).rejects.toThrow("APPROVAL_STALE_OR_MISMATCHED");
    expect(fake.calls.some(({ sql }) => sql.trim() === "ROLLBACK")).toBe(true);
    expect(fake.calls.some(({ sql }) => sql.includes("INSERT INTO cockpit_events"))).toBe(false);
  });

  it("records the exact approved digest and versions in the audit event", async () => {
    const fake = fakePool((sql) => sql.includes("UPDATE cockpit_approvals")
      ? { rows: [{ task_id: taskId }], rowCount: 1 }
      : { rows: [], rowCount: 0 });
    const repository = new CockpitRepository(fake.pool);
    await repository.decideApproval({
      approvalId,
      actionDigest: digest,
      policyVersion: 2,
      actionVersion: 1,
      decision: "approved",
    });
    const event = fake.calls.find(({ sql }) => sql.includes("INSERT INTO cockpit_events"));
    expect(event?.params).toEqual([
      "approval.approved",
      approvalId,
      { taskId, actionDigest: digest, policyVersion: 2, actionVersion: 1 },
    ]);
    expect(fake.calls.some(({ sql }) => sql.trim() === "COMMIT")).toBe(true);
  });

  it("purges only rows whose retention deadline has elapsed", async () => {
    const fake = fakePool((sql) => ({ rows: [], rowCount: sql.startsWith("DELETE FROM cockpit_events") ? 7 : 0 }));
    await expect(new CockpitRepository(fake.pool).purgeExpiredEvents()).resolves.toBe(7);
    expect(fake.calls.some(({ sql }) => sql === "DELETE FROM cockpit_events WHERE expires_at <= now()" )).toBe(true);
    expect(fake.calls.some(({ sql }) => sql === "DELETE FROM cockpit_messages WHERE expires_at <= now()" )).toBe(true);
  });

  it("correlates verification activity with the agent instance that owns the run", async () => {
    const now = new Date("2026-08-14T00:00:00.000Z");
    const fake = fakePool((sql) => {
      if (sql.includes("FROM cockpit_pause")) {
        return { rows: [{ state: "running", reason: null, version: 1, changedBy: "owner", changedAt: now }], rowCount: 1 };
      }
      if (sql.includes("FROM cockpit_owner_state")) {
        return { rows: [{ commandVersion: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await new CockpitRepository(fake.pool).getSnapshot();

    const activityQuery = fake.calls.find(({ sql }) => sql.includes('recent_task.id AS "taskId"'))?.sql ?? "";
    expect(activityQuery).toContain("t.verifier_agent_id = a.id AND t.status = 'verification'");
    expect(activityQuery).toContain("run_instance.agent_id = a.id");
  });
});
