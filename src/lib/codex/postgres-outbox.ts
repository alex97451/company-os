import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { safeOperationalPayloadSchema } from "../cockpit/domain";
import { findOwnerMessagePolicyViolation } from "../cockpit/owner-message-policy";
import { withTransaction } from "../db/pool";
import {
  dispatchEnvelopeSchema,
  type CodexDispatchOutbox,
  type DispatchReceipt,
  type OutboxRecord,
  type TransportKind,
} from "./contracts";

const ownerMessageSchema = z.object({
  message: z.string().trim().min(1).max(1_200),
  actorId: z.string().trim().min(1).max(128).optional(),
  actorRole: z.enum(["owner", "operator"]).optional(),
}).passthrough();
const ownerDispatchConfigSchema = z.object({
  model: z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/).default("gpt-5.6-sol"),
  effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).default("high"),
}).strict();
const claimRowSchema = z.object({
  outboxId: z.union([z.string(), z.number()]).transform(String),
  commandId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(256),
  expectedAggregateVersion: z.number().int().nonnegative(),
  commandType: z.string(),
  commandPayload: z.unknown(),
  outboxPayload: z.unknown(),
  expiresAt: z.coerce.date(),
  threadId: z.string().min(1).max(256).nullable(),
}).strict();

type AcceptedReceipt = Extract<DispatchReceipt, { status: "accepted" }>;
type RejectedReceipt = Extract<DispatchReceipt, { status: "rejected" }>;

/** PostgreSQL is authoritative. A leased row is never reclaimed automatically. */
export class PostgresCodexDispatchOutbox implements CodexDispatchOutbox {
  private readonly ownerDispatchConfig: z.infer<typeof ownerDispatchConfigSchema>;

  constructor(private readonly pool: Pool, config: unknown = {}) {
    this.ownerDispatchConfig = ownerDispatchConfigSchema.parse(config);
  }

  async claimNext(ownerIdRaw: string, leaseUntil: Date): Promise<OutboxRecord | null> {
    const ownerId = z.string().trim().min(1).max(128).parse(ownerIdRaw);
    if (!Number.isFinite(leaseUntil.getTime()) || leaseUntil.getTime() <= Date.now()) {
      throw new Error("CODEX_LEASE_INVALID");
    }

    return withTransaction(this.pool, async (client) => {
      // Serializes CEO claims even with multiple local supervisor processes.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('company-os-codex-ceo-outbox'))");
      const pause = await client.query<{ state: string }>(
        "SELECT state FROM cockpit_pause WHERE id = 1 FOR SHARE",
      );
      if (pause.rows[0]?.state !== "running") return null;
      const result = await client.query(
        `SELECT o.id AS "outboxId", c.id AS "commandId", c.idempotency_key AS "idempotencyKey",
                c.expected_aggregate_version AS "expectedAggregateVersion", c.command_type AS "commandType",
                c.safe_payload AS "commandPayload", o.safe_payload AS "outboxPayload",
                c.expires_at AS "expiresAt", i.thread_id AS "threadId"
         FROM cockpit_outbox o
         JOIN cockpit_commands c ON c.id = o.command_id
         LEFT JOIN cockpit_agent_instances i
           ON i.agent_id = 'ceo' AND i.retired_at IS NULL
         WHERE o.destination = 'codex:ceo' AND o.state = 'pending' AND o.available_at <= now()
           AND c.state = 'pending'
           AND NOT EXISTS (
             SELECT 1 FROM cockpit_outbox blocker
             WHERE blocker.destination = 'codex:ceo'
               AND blocker.state IN ('leased','sent')
           )
         ORDER BY o.id
         FOR UPDATE OF o, c SKIP LOCKED LIMIT 1`,
      );
      if (!result.rows[0]) return null;

      const row = claimRowSchema.parse(result.rows[0]);
      if (row.expiresAt.getTime() <= Date.now()) {
        await rejectBeforeSend(client, row, "expired", "command.expired");
        return null;
      }

      const outboxMetadata = z.object({
        commandId: z.string().uuid(),
        commandType: z.string(),
        expectedAggregateVersion: z.number().int().nonnegative(),
      }).passthrough().safeParse(row.outboxPayload);
      const message = ownerMessageSchema.safeParse(row.commandPayload);
      const metadataMatches = outboxMetadata.success
        && outboxMetadata.data.commandId === row.commandId
        && outboxMetadata.data.commandType === row.commandType
        && outboxMetadata.data.expectedAggregateVersion === row.expectedAggregateVersion;
      if (row.commandType !== "owner.message" || !message.success || !metadataMatches) {
        await rejectBeforeSend(client, row, "policy_rejected", "command.rejected");
        return null;
      }

      // Missing immutable CEO mapping is an offline condition. Release before
      // any send and retry later; do not fabricate a replacement thread.
      if (!row.threadId) {
        await client.query(
          `UPDATE cockpit_outbox SET available_at = now() + interval '1 second',
                  lease_owner = NULL, lease_expires_at = NULL
           WHERE id = $1 AND state = 'pending'`,
          [row.outboxId],
        );
        return null;
      }

      const claimed = await client.query(
        `UPDATE cockpit_outbox SET state = 'leased', attempts = attempts + 1,
                lease_owner = $2, lease_expires_at = $3
         WHERE id = $1 AND state = 'pending' RETURNING id`,
        [row.outboxId, ownerId, leaseUntil],
      );
      if (!claimed.rows[0]) return null;

      return {
        state: "claimed",
        envelope: dispatchEnvelopeSchema.parse({
          dispatchId: row.commandId,
          agentId: "ceo",
          threadId: row.threadId,
          prompt: ceoPrompt(message.data.message),
          idempotencyKey: row.idempotencyKey,
          expectedAggregateVersion: row.expectedAggregateVersion,
          expiresAt: row.expiresAt.toISOString(),
          model: this.ownerDispatchConfig.model,
          effort: this.ownerDispatchConfig.effort,
        }),
      };
    });
  }

  async markAccepted(dispatchIdRaw: string, receipt: AcceptedReceipt): Promise<void> {
    const dispatchId = z.string().uuid().parse(dispatchIdRaw);
    await withTransaction(this.pool, async (client) => {
      const updated = await client.query(
        `UPDATE cockpit_outbox SET state = 'sent', sent_at = $2, lease_owner = NULL, lease_expires_at = NULL
         WHERE command_id = $1 AND destination = 'codex:ceo' AND state = 'leased' RETURNING id`,
        [dispatchId, new Date(receipt.acceptedAt)],
      );
      if (!updated.rows[0]) throw new Error("CODEX_DISPATCH_NOT_LEASED");
      const command = await client.query(
        `UPDATE cockpit_commands SET state = 'dispatched', dispatched_at = $2,
                remote_thread_id = $3, remote_turn_id = $4
         WHERE id = $1 AND state = 'pending' RETURNING id`,
        [dispatchId, new Date(receipt.acceptedAt), receipt.remoteThreadId, receipt.remoteTurnId],
      );
      if (!command.rows[0]) throw new Error("CODEX_COMMAND_NOT_PENDING");
      await client.query(
        `UPDATE cockpit_messages SET status = 'dispatched'
         WHERE command_id = $1 AND sender = 'owner' AND status = 'pending'`,
        [dispatchId],
      );
      await insertEvent(client, "codex.dispatch.accepted", dispatchId, {
        transport: receipt.transport,
        remoteThreadId: receipt.remoteThreadId,
        remoteTurnId: receipt.remoteTurnId,
        acceptedAt: receipt.acceptedAt,
        model: this.ownerDispatchConfig.model,
        effort: this.ownerDispatchConfig.effort,
      });
    });
  }

  async markRejected(dispatchIdRaw: string, receipt: RejectedReceipt): Promise<void> {
    const dispatchId = z.string().uuid().parse(dispatchIdRaw);
    await withTransaction(this.pool, async (client) => {
      const updated = await client.query(
        `UPDATE cockpit_outbox SET state = 'failed', lease_owner = NULL, lease_expires_at = NULL
         WHERE command_id = $1 AND destination = 'codex:ceo' AND state = 'leased' RETURNING id`,
        [dispatchId],
      );
      if (!updated.rows[0]) throw new Error("CODEX_DISPATCH_NOT_LEASED");
      const commandState = receipt.code === "expired" ? "expired" : "rejected";
      const command = await client.query(
        `UPDATE cockpit_commands SET state = $2, completed_at = now()
         WHERE id = $1 AND state = 'pending' RETURNING id`,
        [dispatchId, commandState],
      );
      if (!command.rows[0]) throw new Error("CODEX_COMMAND_NOT_PENDING");
      await insertEvent(client, "codex.dispatch.rejected", dispatchId, {
        transport: receipt.transport,
        code: receipt.code,
      });
    });
  }

  async markReconciliationRequired(
    dispatchIdRaw: string,
    metadata: { transport: TransportKind; code: "send_outcome_unknown" | "persistence_after_accept_failed" },
  ): Promise<void> {
    const dispatchId = z.string().uuid().parse(dispatchIdRaw);
    await withTransaction(this.pool, async (client) => {
      const updated = await client.query(
        `UPDATE cockpit_outbox SET state = 'reconciliation_required', lease_owner = NULL, lease_expires_at = NULL
         WHERE command_id = $1 AND destination = 'codex:ceo' AND state = 'leased' RETURNING id`,
        [dispatchId],
      );
      if (!updated.rows[0]) throw new Error("CODEX_DISPATCH_NOT_LEASED");
      const command = await client.query(
        `UPDATE cockpit_commands SET state = 'reconciliation_required'
         WHERE id = $1 AND state IN ('pending','dispatched') RETURNING id`,
        [dispatchId],
      );
      if (!command.rows[0]) throw new Error("CODEX_COMMAND_NOT_RECONCILABLE");
      await insertEvent(client, "codex.dispatch.reconciliation_required", dispatchId, metadata);
    });
  }

  async releaseClaim(dispatchIdRaw: string, reason: "transport_unavailable"): Promise<void> {
    const dispatchId = z.string().uuid().parse(dispatchIdRaw);
    const updated = await this.pool.query(
      `UPDATE cockpit_outbox SET state = 'pending', available_at = now() + interval '1 second',
              lease_owner = NULL, lease_expires_at = NULL
       WHERE command_id = $1 AND destination = 'codex:ceo' AND state = 'leased' AND sent_at IS NULL`,
      [dispatchId],
    );
    if ((updated.rowCount ?? 0) !== 1) throw new Error(`CODEX_RELEASE_DENIED_${reason.toUpperCase()}`);
  }

  /** Expired leases have an unknown send outcome and are never retried. */
  async reconcileExpiredLeases(): Promise<number> {
    return withTransaction(this.pool, async (client) => {
      const expired = await client.query<{ command_id: string }>(
        `UPDATE cockpit_outbox SET state = 'reconciliation_required', lease_owner = NULL, lease_expires_at = NULL
         WHERE destination = 'codex:ceo' AND state = 'leased' AND lease_expires_at <= now()
         RETURNING command_id`,
      );
      for (const row of expired.rows) {
        if (!row.command_id) continue;
        await client.query(
          `UPDATE cockpit_commands SET state = 'reconciliation_required'
           WHERE id = $1 AND state IN ('pending','dispatched')`,
          [row.command_id],
        );
        await client.query(
          `UPDATE cockpit_messages SET status = 'reconciliation_required'
           WHERE command_id = $1 AND status IN ('pending','dispatched')`,
          [row.command_id],
        );
        await insertEvent(client, "codex.dispatch.lease_expired", row.command_id, {
          code: "lease_expired_outcome_unknown",
        });
      }
      return expired.rows.length;
    });
  }

  async listDispatchedTurns(): Promise<Array<{ commandId: string; remoteTurnId: string }>> {
    const result = await this.pool.query<{ commandId: string; remoteTurnId: string }>(
      `SELECT id AS "commandId", remote_turn_id AS "remoteTurnId"
       FROM cockpit_commands
       WHERE state = 'dispatched' AND remote_turn_id IS NOT NULL
       ORDER BY dispatched_at`,
    );
    return z.array(z.object({ commandId: z.string().uuid(), remoteTurnId: z.string().min(1).max(256) }).strict()).parse(result.rows);
  }

  /** A stopped bridge makes every unfinished accepted turn unknowable and blocks the CEO lane. */
  async markProcessStopped(reasonRaw: string): Promise<number> {
    const reason = z.enum(["exit", "protocol_error", "requested"]).parse(reasonRaw);
    return withTransaction(this.pool, async (client) => {
      const commands = await client.query<{ id: string }>(
        `UPDATE cockpit_commands SET state = 'reconciliation_required'
         WHERE state = 'dispatched' AND remote_turn_id IS NOT NULL RETURNING id`,
      );
      for (const command of commands.rows) {
        await client.query(
          `UPDATE cockpit_outbox SET state = 'reconciliation_required', lease_owner = NULL, lease_expires_at = NULL
           WHERE command_id = $1 AND destination = 'codex:ceo' AND state IN ('leased','sent')`,
          [command.id],
        );
        await client.query(
          `UPDATE cockpit_messages SET status = 'reconciliation_required'
           WHERE command_id = $1 AND status IN ('pending','dispatched')`,
          [command.id],
        );
        await insertEvent(client, "codex.process_stopped.reconciliation_required", command.id, { reason });
      }
      return commands.rows.length;
    });
  }

  async completeTurn(inputRaw: unknown): Promise<"completed" | "reconciliation_required" | "not_found"> {
    const input = z.object({
      remoteTurnId: z.string().min(1).max(256),
      remoteThreadId: z.string().min(1).max(256).optional(),
      status: z.enum(["completed", "interrupted", "failed", "unknown"]),
      finalMessage: z.string().trim().min(1).max(8_192).optional(),
      demo: z.boolean().default(false),
    }).strict().parse(inputRaw);

    return withTransaction(this.pool, async (client) => {
      const found = await client.query<{ id: string; state: string; remote_thread_id: string | null }>(
        `SELECT id, state, remote_thread_id FROM cockpit_commands
         WHERE remote_turn_id = $1 FOR UPDATE`,
        [input.remoteTurnId],
      );
      const command = found.rows[0];
      if (!command) return "not_found";
      if (input.remoteThreadId && command.remote_thread_id !== input.remoteThreadId) {
        await markCompletionReconciliation(client, command.id, "thread_correlation_mismatch");
        return "reconciliation_required";
      }
      if (command.state === "completed") return "completed";
      if (command.state !== "dispatched") {
        await markCompletionReconciliation(client, command.id, "command_state_mismatch");
        return "reconciliation_required";
      }
      if (input.status === "interrupted" || input.status === "failed") {
        await client.query(
          "UPDATE cockpit_commands SET state = 'rejected', completed_at = now() WHERE id = $1 AND state = 'dispatched'",
          [command.id],
        );
        await client.query(
          "UPDATE cockpit_messages SET status = 'failed' WHERE command_id = $1 AND status IN ('pending','dispatched')",
          [command.id],
        );
        await client.query(
          "UPDATE cockpit_outbox SET state = 'failed', lease_owner = NULL, lease_expires_at = NULL WHERE command_id = $1",
          [command.id],
        );
        await insertEvent(client, `codex.turn.${input.status}`, command.id, { remoteTurnId: input.remoteTurnId });
        return "completed";
      }
      if (input.status !== "completed" || !input.finalMessage) {
        await markCompletionReconciliation(client, command.id, input.status === "completed" ? "visible_response_missing" : `turn_${input.status}`);
        return "reconciliation_required";
      }
      if (findOwnerMessagePolicyViolation(input.finalMessage)) {
        await markCompletionReconciliation(client, command.id, "sensitive_result_rejected");
        return "reconciliation_required";
      }

      await client.query(
        `INSERT INTO cockpit_messages (sender, command_id, safe_body, status)
         VALUES ('ceo',$1,$2,$3)
         ON CONFLICT (command_id) WHERE sender = 'ceo' DO NOTHING`,
        [command.id, input.finalMessage, input.demo ? "demo" : "completed"],
      );
      await client.query(
        "UPDATE cockpit_outbox SET state = 'completed' WHERE command_id = $1 AND destination = 'codex:ceo' AND state = 'sent'",
        [command.id],
      );
      const updated = await client.query(
        `UPDATE cockpit_commands SET state = 'completed', completed_at = now()
         WHERE id = $1 AND state = 'dispatched' RETURNING id`,
        [command.id],
      );
      if (!updated.rows[0]) throw new Error("CODEX_COMMAND_COMPLETION_RACE");
      await client.query(
        `UPDATE cockpit_messages SET status = 'completed'
         WHERE command_id = $1 AND sender = 'owner' AND status = 'dispatched'`,
        [command.id],
      );
      await insertEvent(client, "codex.turn.completed", command.id, {
        remoteTurnId: input.remoteTurnId,
        status: input.status,
        responseStored: true,
        demo: input.demo,
      });
      return "completed";
    });
  }

  async reconcileAuthoritativeCompletion(inputRaw: unknown): Promise<"completed" | "not_found"> {
    const input = z.object({
      remoteTurnId: z.string().min(1).max(256),
      remoteThreadId: z.string().min(1).max(256),
      finalMessage: z.string().trim().min(1).max(8_192),
    }).strict().parse(inputRaw);
    if (findOwnerMessagePolicyViolation(input.finalMessage)) {
      throw new Error("AUTHORITATIVE_RESULT_POLICY_REJECTED");
    }

    return withTransaction(this.pool, async (client) => {
      const found = await client.query<{ id: string; state: string; remote_thread_id: string | null }>(
        `SELECT id, state, remote_thread_id
           FROM cockpit_commands
          WHERE remote_turn_id = $1
          FOR UPDATE`,
        [input.remoteTurnId],
      );
      const command = found.rows[0];
      if (!command) return "not_found";
      if (command.remote_thread_id !== input.remoteThreadId) {
        throw new Error("AUTHORITATIVE_THREAD_MISMATCH");
      }
      if (command.state === "completed") return "completed";
      if (command.state !== "reconciliation_required") {
        throw new Error("AUTHORITATIVE_COMMAND_NOT_RECONCILABLE");
      }

      await client.query(
        `INSERT INTO cockpit_messages (sender, command_id, safe_body, status)
         VALUES ('ceo',$1,$2,'completed')
         ON CONFLICT (command_id) WHERE sender = 'ceo'
         DO UPDATE SET safe_body = EXCLUDED.safe_body, status = 'completed'`,
        [command.id, input.finalMessage],
      );
      await client.query(
        `UPDATE cockpit_outbox
            SET state = 'completed', lease_owner = NULL, lease_expires_at = NULL
          WHERE command_id = $1
            AND destination = 'codex:ceo'
            AND state IN ('sent','reconciliation_required')`,
        [command.id],
      );
      await client.query(
        `UPDATE cockpit_commands
            SET state = 'completed', completed_at = now()
          WHERE id = $1 AND state = 'reconciliation_required'`,
        [command.id],
      );
      await client.query(
        `UPDATE cockpit_messages SET status = 'completed'
         WHERE command_id = $1 AND sender = 'owner'
           AND status IN ('pending','dispatched','reconciliation_required')`,
        [command.id],
      );
      await insertEvent(client, "codex.turn.authoritatively_reconciled", command.id, {
        remoteTurnId: input.remoteTurnId,
        responseStored: true,
      });
      return "completed";
    });
  }
}

function ceoPrompt(ownerMessage: string): string {
  const projectName = process.env.COMPANY_OS_PROJECT_NAME ?? "le projet connecté";
  const workspace = process.env.COMPANY_OS_PROJECT_ROOT ?? process.cwd();
  return [
    `You are the CEO of ${projectName}. The owner communicates only with you.`,
    `Your only project workspace is ${workspace}.`,
    "Answer the owner directly, then delegate bounded internal work when useful.",
    "Never spend money, deploy production, launch advertising, contact third parties, or perform irreversible financial actions without a recorded owner approval.",
    "Never include secrets, customer data, private source contents, or hidden reasoning.",
    "If delegating, append exactly one final ```company-delegations JSON block using version 1 and at most five tasks. Otherwise append no block.",
    "Each task requires agentId, title, intendedOutcome, riskClass, complexity, contextTokens, urgency, estimatedCostUsdMicros; critical work also requires a distinct verifierAgentId.",
    "",
    `Owner message: ${ownerMessage}`,
  ].join("\n");
}

async function markCompletionReconciliation(client: PoolClient, commandId: string, code: string): Promise<void> {
  await client.query(
    `UPDATE cockpit_commands SET state = 'reconciliation_required'
     WHERE id = $1 AND state <> 'completed'`,
    [commandId],
  );
  await client.query(
    `UPDATE cockpit_messages SET status = 'reconciliation_required'
     WHERE command_id = $1 AND status IN ('pending','dispatched')`,
    [commandId],
  );
  await insertEvent(client, "codex.turn.reconciliation_required", commandId, { code });
}

async function rejectBeforeSend(
  client: PoolClient,
  row: z.infer<typeof claimRowSchema>,
  code: "expired" | "policy_rejected",
  eventType: string,
): Promise<void> {
  await client.query(
    "UPDATE cockpit_outbox SET state = 'failed', lease_owner = NULL, lease_expires_at = NULL WHERE id = $1 AND state = 'pending'",
    [row.outboxId],
  );
  await client.query(
    "UPDATE cockpit_commands SET state = $2, completed_at = now() WHERE id = $1 AND state = 'pending'",
    [row.commandId, code === "expired" ? "expired" : "rejected"],
  );
  await client.query(
    `UPDATE cockpit_messages SET status = 'failed'
     WHERE command_id = $1 AND sender = 'owner' AND status = 'pending'`,
    [row.commandId],
  );
  await insertEvent(client, eventType, row.commandId, { code });
}

async function insertEvent(client: PoolClient, eventType: string, aggregateId: string, payload: unknown): Promise<void> {
  const safePayload = safeOperationalPayloadSchema.parse(payload);
  await client.query(
    `INSERT INTO cockpit_events (event_type, aggregate_type, aggregate_id, safe_payload)
     VALUES ($1,'command',$2,$3)`,
    [eventType, aggregateId, safePayload],
  );
}
