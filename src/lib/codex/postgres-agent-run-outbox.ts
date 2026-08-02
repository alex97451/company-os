import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { companyAgentIdSchema } from "../agents/registry";
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

const claimRowSchema = z.object({
  outboxId: z.union([z.string(), z.number()]).transform(String),
  runId: z.string().uuid(),
  taskId: z.string().uuid(),
  agentId: companyAgentIdSchema,
  threadId: z.string().min(1).max(256),
  title: z.string().min(1).max(300),
  intendedOutcome: z.string().min(1).max(2_000),
  riskClass: z.string().min(1).max(64),
  aggregateVersion: z.number().int().nonnegative(),
  model: z.string().min(1).max(128),
  effort: z.enum(["low", "medium", "high", "xhigh"]),
  createdAt: z.coerce.date(),
  approvalId: z.string().uuid().nullable(),
  outboxPayload: z.unknown(),
}).strict();

const verificationPayloadSchema = z.object({
  verificationOfRunId: z.string().uuid(),
  verificationSummary: z.string().min(1).max(4_000),
}).passthrough();

const strategicSessionPayloadSchema = z.object({
  strategicSessionId: z.string().uuid(),
  contributionId: z.string().uuid(),
  sessionStage: z.enum(["proposal", "objection", "ceo_synthesis", "ceo_decision"]),
  round: z.number().int().min(1).max(2),
}).passthrough();

const verifierResultSchema = z.object({
  verdict: z.enum(["approved", "changes_required", "blocked"]),
  summary: z.string().trim().min(1).max(4_000),
}).strict();

const verifierOutputSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approved", "changes_required", "blocked"] },
    summary: { type: "string" },
  },
  required: ["verdict", "summary"],
  additionalProperties: false,
} as const;

const specialistResultSchema = z.object({
  status: z.enum(["completed", "blocked"]),
  summary: z.string().trim().min(1).max(4_000),
  evidence: z.array(z.string().trim().min(1).max(500)).max(12).default([]),
}).strict();

const specialistOutputSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["completed", "blocked"] },
    summary: { type: "string" },
    evidence: {
      type: "array",
      items: { type: "string" },
      maxItems: 12,
    },
  },
  required: ["status", "summary", "evidence"],
  additionalProperties: false,
} as const;

export function parseSpecialistResult(value: string): z.infer<typeof specialistResultSchema> {
  return specialistResultSchema.parse(JSON.parse(value));
}

type AcceptedReceipt = Extract<DispatchReceipt, { status: "accepted" }>;
type RejectedReceipt = Extract<DispatchReceipt, { status: "rejected" }>;

/**
 * Durable specialist lane. It consumes only run-backed outbox rows; owner
 * commands remain isolated in PostgresCodexDispatchOutbox.
 */
export class PostgresAgentRunOutbox implements CodexDispatchOutbox {
  constructor(private readonly pool: Pool) {}

  async claimNext(ownerIdRaw: string, leaseUntil: Date): Promise<OutboxRecord | null> {
    const ownerId = z.string().trim().min(1).max(128).parse(ownerIdRaw);
    if (!Number.isFinite(leaseUntil.getTime()) || leaseUntil.getTime() <= Date.now()) {
      throw new Error("AGENT_RUN_LEASE_INVALID");
    }
    return withTransaction(this.pool, async (client) => {
      const pause = await client.query<{ state: string }>("SELECT state FROM cockpit_pause WHERE id = 1 FOR SHARE");
      if (pause.rows[0]?.state !== "running") return null;
      const selected = await client.query(
        `SELECT o.id AS "outboxId", r.id AS "runId", r.task_id AS "taskId",
                i.agent_id AS "agentId", i.thread_id AS "threadId", t.title,
                t.intended_outcome AS "intendedOutcome", t.risk_class AS "riskClass",
                t.aggregate_version AS "aggregateVersion", r.selected_model AS model,
                r.reasoning_effort AS effort, o.created_at AS "createdAt",
                approval.id AS "approvalId", o.safe_payload AS "outboxPayload"
         FROM cockpit_outbox o
         JOIN cockpit_runs r ON r.id = o.run_id
         JOIN cockpit_tasks t ON t.id = r.task_id
         JOIN cockpit_agent_instances i ON i.id = r.agent_instance_id AND i.retired_at IS NULL
         LEFT JOIN LATERAL (
           SELECT a.id FROM cockpit_approvals a
           WHERE a.task_id = t.id AND a.state = 'approved' AND a.expires_at > now()
           ORDER BY a.decided_at DESC LIMIT 1
         ) approval ON true
         WHERE o.run_id IS NOT NULL AND o.state = 'pending' AND o.available_at <= now()
           AND r.state = 'queued' AND i.state = 'waiting'
           AND (i.agent_id <> 'ceo' OR o.safe_payload ? 'strategicSessionId')
           AND NOT EXISTS (
             SELECT 1
             FROM company_sessions session
             WHERE session.state IN ('paused','stopping','stopped','failed','completed')
               AND (
                 session.id = NULLIF(o.safe_payload ->> 'strategicSessionId', '')::uuid
                 OR EXISTS (
                   SELECT 1 FROM company_session_execution_tasks session_task
                   WHERE session_task.session_id = session.id AND session_task.task_id = t.id
                 )
               )
           )
           AND (t.risk_class NOT IN ('financial','advertising','production') OR approval.id IS NOT NULL)
           AND NOT EXISTS (
             SELECT 1 FROM cockpit_outbox blocker
             WHERE blocker.destination = o.destination
               AND blocker.state IN ('leased','sent')
           )
         ORDER BY o.id FOR UPDATE OF o, r, t SKIP LOCKED LIMIT 1`,
      );
      if (!selected.rows[0]) return null;
      const row = claimRowSchema.parse(selected.rows[0]);
      const claimed = await client.query(
        `UPDATE cockpit_outbox SET state = 'leased', attempts = attempts + 1,
                lease_owner = $2, lease_expires_at = $3
         WHERE id = $1 AND state = 'pending' RETURNING id`,
        [row.outboxId, ownerId, leaseUntil],
      );
      if (!claimed.rows[0]) return null;
      await client.query(
        "UPDATE cockpit_runs SET state = 'dispatching', lease_owner = $2, lease_expires_at = $3 WHERE id = $1 AND state = 'queued'",
        [row.runId, ownerId, leaseUntil],
      );
      return {
        state: "claimed",
        envelope: dispatchEnvelopeSchema.parse({
          dispatchId: row.runId,
          runId: row.runId,
          agentId: row.agentId,
          threadId: row.threadId,
          prompt: specialistPrompt(row),
          model: row.model,
          effort: row.effort,
          ...(verificationPayloadSchema.safeParse(row.outboxPayload).success
            ? { outputSchema: verifierOutputSchema }
            : strategicSessionPayloadSchema.safeParse(row.outboxPayload).success
              ? {}
              : { outputSchema: specialistOutputSchema }),
          idempotencyKey: `company-os-run-${row.runId}`,
          expectedAggregateVersion: row.aggregateVersion,
          expiresAt: new Date(row.createdAt.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
        }),
      };
    });
  }

  async markAccepted(runIdRaw: string, receipt: AcceptedReceipt): Promise<void> {
    const runId = z.string().uuid().parse(runIdRaw);
    await withTransaction(this.pool, async (client) => {
      const run = await client.query<{ task_id: string; agent_instance_id: string }>(
        `UPDATE cockpit_runs SET state = 'working', codex_thread_id = $2, codex_turn_id = $3,
                lease_owner = NULL, lease_expires_at = NULL, started_at = $4
         WHERE id = $1 AND state = 'dispatching' RETURNING task_id, agent_instance_id`,
        [runId, receipt.remoteThreadId, receipt.remoteTurnId, new Date(receipt.acceptedAt)],
      );
      const row = run.rows[0];
      if (!row) throw new Error("AGENT_RUN_NOT_DISPATCHING");
      const task = await client.query<{ risk_class: string }>(
        "SELECT risk_class FROM cockpit_tasks WHERE id = $1 FOR UPDATE",
        [row.task_id],
      );
      if (["financial", "advertising", "production"].includes(task.rows[0]?.risk_class ?? "")) {
        const consumed = await client.query(
          `UPDATE cockpit_approvals SET state = 'consumed', consumed_at = now()
           WHERE id = (
             SELECT id FROM cockpit_approvals
             WHERE task_id = $1 AND state = 'approved' AND expires_at > now()
             ORDER BY decided_at DESC LIMIT 1 FOR UPDATE
           ) RETURNING id`,
          [row.task_id],
        );
        if (!consumed.rows[0]) throw new Error("OWNER_APPROVAL_CONSUMPTION_RACE");
      }
      await client.query(
        "UPDATE cockpit_outbox SET state = 'sent', sent_at = $2, lease_owner = NULL, lease_expires_at = NULL WHERE run_id = $1 AND state = 'leased'",
        [runId, new Date(receipt.acceptedAt)],
      );
      await client.query("UPDATE cockpit_tasks SET status = 'working', updated_at = now() WHERE id = $1", [row.task_id]);
      await client.query("UPDATE cockpit_agent_instances SET state = 'working', heartbeat_at = now() WHERE id = $1", [row.agent_instance_id]);
      await client.query(
        `UPDATE company_session_contributions SET status = 'working', started_at = now()
         WHERE run_id = $1 AND status = 'queued'`,
        [runId],
      );
      await client.query(
        `UPDATE company_session_participants participant SET status = 'working'
         FROM company_session_contributions contribution
         WHERE contribution.run_id = $1
           AND participant.session_id = contribution.session_id
           AND participant.agent_id = contribution.author_agent_id`,
        [runId],
      );
      await event(client, "agent.run.started", runId, { taskId: row.task_id, transport: receipt.transport });
    });
  }

  async markRejected(runIdRaw: string, receipt: RejectedReceipt): Promise<void> {
    await this.failRun(runIdRaw, "failed", receipt.code);
  }

  async markReconciliationRequired(
    runIdRaw: string,
    metadata: { transport: TransportKind; code: "send_outcome_unknown" | "persistence_after_accept_failed" },
  ): Promise<void> {
    await this.failRun(runIdRaw, "reconciliation_required", metadata.code);
  }

  async releaseClaim(runIdRaw: string, reason: "transport_unavailable"): Promise<void> {
    void reason;
    const runId = z.string().uuid().parse(runIdRaw);
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `UPDATE cockpit_outbox SET state = 'pending', available_at = now() + interval '1 second',
                lease_owner = NULL, lease_expires_at = NULL
         WHERE run_id = $1 AND state = 'leased' AND sent_at IS NULL`,
        [runId],
      );
      await client.query(
        "UPDATE cockpit_runs SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL WHERE id = $1 AND state = 'dispatching'",
        [runId],
      );
    });
  }

  async reconcileExpiredLeases(): Promise<number> {
    return withTransaction(this.pool, async (client) => {
      const expired = await client.query<{ run_id: string }>(
        `UPDATE cockpit_outbox SET state = 'reconciliation_required', lease_owner = NULL, lease_expires_at = NULL
         WHERE run_id IS NOT NULL AND state = 'leased' AND lease_expires_at <= now() RETURNING run_id`,
      );
      for (const row of expired.rows) {
        await markRunUncertain(client, row.run_id, "lease_expired_outcome_unknown");
      }
      return expired.rows.length;
    });
  }

  async markProcessStopped(reason: "exit" | "protocol_error" | "requested"): Promise<number> {
    return withTransaction(this.pool, async (client) => {
      const affected = await client.query<{ id: string }>(
        `UPDATE cockpit_runs SET state = 'reconciliation_required', lease_owner = NULL, lease_expires_at = NULL
         WHERE state IN ('dispatching','working','interruption_requested') RETURNING id`,
      );
      for (const row of affected.rows) {
        await client.query(
          "UPDATE cockpit_outbox SET state = 'reconciliation_required', lease_owner = NULL, lease_expires_at = NULL WHERE run_id = $1 AND state IN ('leased','sent')",
          [row.id],
        );
        await event(client, "agent.run.reconciliation_required", row.id, { code: `process_${reason}` });
      }
      return affected.rows.length;
    });
  }

  async listDispatchedTurns(): Promise<Array<{ commandId: string; remoteTurnId: string }>> {
    const result = await this.pool.query<{ commandId: string; remoteTurnId: string }>(
      `SELECT id AS "commandId", codex_turn_id AS "remoteTurnId"
       FROM cockpit_runs WHERE state IN ('working','interruption_requested')
         AND codex_turn_id IS NOT NULL ORDER BY started_at`,
    );
    return z.array(z.object({
      commandId: z.string().uuid(),
      remoteTurnId: z.string().min(1).max(256),
    }).strict()).parse(result.rows);
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
      const found = await client.query<{
        id: string; task_id: string; agent_instance_id: string; codex_thread_id: string | null;
        requires_distinct_verifier: boolean; estimated_cost_usd_micros: string; created_at: Date;
        routing_factors: unknown;
      }>(
        `SELECT id, task_id, agent_instance_id, codex_thread_id, requires_distinct_verifier,
                estimated_cost_usd_micros::text, created_at, routing_factors
         FROM cockpit_runs WHERE codex_turn_id = $1 FOR UPDATE`,
        [input.remoteTurnId],
      );
      const run = found.rows[0];
      if (!run) return "not_found";
      if (input.remoteThreadId && run.codex_thread_id !== input.remoteThreadId) {
        await markRunUncertain(client, run.id, "thread_correlation_mismatch");
        return "reconciliation_required";
      }
      if (input.status !== "completed" || !input.finalMessage) {
        await markRunUncertain(client, run.id, input.status === "completed" ? "visible_response_missing" : `turn_${input.status}`);
        return "reconciliation_required";
      }
      const verificationMeta = z.object({
        verificationOfRunId: z.string().uuid(),
      }).passthrough().safeParse(run.routing_factors);
      const strategicMeta = z.object({
        strategicSessionId: z.string().uuid(),
      }).passthrough().safeParse(run.routing_factors);
      let summary = input.finalMessage.slice(0, 4_000);
      let verifierVerdict: z.infer<typeof verifierResultSchema> | null = null;
      let specialistResult: z.infer<typeof specialistResultSchema> | null = null;
      if (verificationMeta.success) {
        try {
          verifierVerdict = verifierResultSchema.parse(JSON.parse(input.finalMessage));
          summary = verifierVerdict.summary;
        } catch {
          await markRunUncertain(client, run.id, "verifier_result_invalid");
          return "reconciliation_required";
        }
      } else if (!strategicMeta.success) {
        try {
          specialistResult = parseSpecialistResult(input.finalMessage);
          summary = specialistResult.summary;
        } catch {
          await markRunUncertain(client, run.id, "specialist_result_invalid");
          return "reconciliation_required";
        }
      }
      if (findOwnerMessagePolicyViolation(summary)) {
        await markRunUncertain(client, run.id, "sensitive_result_rejected");
        return "reconciliation_required";
      }
      if (specialistResult?.status === "blocked") {
        await client.query(
          "UPDATE cockpit_runs SET state = 'blocked', completed_at = now(), lease_owner = NULL, lease_expires_at = NULL WHERE id = $1 AND state = 'working'",
          [run.id],
        );
        await client.query("UPDATE cockpit_outbox SET state = 'completed' WHERE run_id = $1 AND state = 'sent'", [run.id]);
        await client.query("UPDATE cockpit_tasks SET status = 'problem', completed_at = NULL, updated_at = now() WHERE id = $1", [run.task_id]);
        await client.query("UPDATE cockpit_agent_instances SET state = 'waiting', heartbeat_at = now() WHERE id = $1", [run.agent_instance_id]);
        await event(client, "agent.run.blocked", run.id, {
          taskId: run.task_id,
          summary,
          evidence: specialistResult.evidence,
          demo: input.demo,
        });
        const contribution = await client.query<{ session_id: string; author_agent_id: string }>(
          `UPDATE company_session_contributions
              SET status = 'blocked', safe_body = $2, completed_at = now()
            WHERE run_id = $1 AND status = 'working'
            RETURNING session_id, author_agent_id`,
          [run.id, summary],
        );
        if (contribution.rows[0]) {
          await client.query(
            `UPDATE company_session_participants SET status = 'blocked'
             WHERE session_id = $1 AND agent_id = $2`,
            [contribution.rows[0].session_id, contribution.rows[0].author_agent_id],
          );
        }
        await settleModelReservation(client, run.estimated_cost_usd_micros, run.created_at, true);
        return "completed";
      }
      await client.query(
        "UPDATE cockpit_runs SET state = 'completed', completed_at = now(), lease_owner = NULL, lease_expires_at = NULL WHERE id = $1 AND state = 'working'",
        [run.id],
      );
      await client.query("UPDATE cockpit_outbox SET state = 'completed' WHERE run_id = $1 AND state = 'sent'", [run.id]);
      await client.query("UPDATE cockpit_agent_instances SET state = 'waiting', heartbeat_at = now() WHERE id = $1", [run.agent_instance_id]);
      await event(client, "agent.run.completed", run.id, {
        taskId: run.task_id, summary, demo: input.demo,
        ...(verifierVerdict ? { verdict: verifierVerdict.verdict } : {}),
      });
      const contribution = await client.query<{ id: string; session_id: string; author_agent_id: string }>(
        `UPDATE company_session_contributions
            SET status = 'completed', safe_body = $2, completed_at = now()
          WHERE run_id = $1 AND status = 'working'
          RETURNING id, session_id, author_agent_id`,
        [run.id, summary],
      );
      if (contribution.rows[0]) {
        await client.query(
          `UPDATE company_session_participants SET status = 'contributed'
           WHERE session_id = $1 AND agent_id = $2`,
          [contribution.rows[0].session_id, contribution.rows[0].author_agent_id],
        );
        await client.query(
          `INSERT INTO company_session_events (session_id, event_type, safe_payload)
           VALUES ($1,'session.contribution.completed',$2)`,
          [contribution.rows[0].session_id, safeOperationalPayloadSchema.parse({
            contributionId: contribution.rows[0].id,
            agentId: contribution.rows[0].author_agent_id,
            summary: summary.slice(0, 2_000),
          })],
        );
      }
      await settleModelReservation(client, run.estimated_cost_usd_micros, run.created_at, true);
      if (run.requires_distinct_verifier) {
        await queueVerifier(client, run.id, run.task_id, summary);
      } else if (verifierVerdict) {
        await client.query(
          "UPDATE cockpit_tasks SET status = $2, completed_at = now(), updated_at = now() WHERE id = $1",
          [run.task_id, verifierVerdict.verdict === "approved" ? "done" : "problem"],
        );
      } else {
        await client.query("UPDATE cockpit_tasks SET status = 'done', completed_at = now(), updated_at = now() WHERE id = $1", [run.task_id]);
      }
      return "completed";
    });
  }

  private async failRun(runIdRaw: string, state: "failed" | "reconciliation_required", code: string): Promise<void> {
    const runId = z.string().uuid().parse(runIdRaw);
    await withTransaction(this.pool, async (client) => {
      const run = await client.query<{
        task_id: string; agent_instance_id: string; estimated_cost_usd_micros: string; created_at: Date;
      }>(
        `UPDATE cockpit_runs SET state = $2, completed_at = CASE WHEN $2 = 'failed' THEN now() ELSE completed_at END,
                lease_owner = NULL, lease_expires_at = NULL
         WHERE id = $1 AND state IN ('queued','dispatching','working')
         RETURNING task_id, agent_instance_id, estimated_cost_usd_micros::text, created_at`,
        [runId, state],
      );
      const row = run.rows[0];
      if (!row) return;
      await client.query(
        `UPDATE cockpit_outbox SET state = $2, lease_owner = NULL, lease_expires_at = NULL
         WHERE run_id = $1 AND state IN ('pending','leased','sent')`,
        [runId, state === "failed" ? "failed" : "reconciliation_required"],
      );
      await client.query("UPDATE cockpit_tasks SET status = 'problem', updated_at = now() WHERE id = $1", [row.task_id]);
      await client.query("UPDATE cockpit_agent_instances SET state = $2, heartbeat_at = now() WHERE id = $1", [
        row.agent_instance_id, state === "failed" ? "problem" : "uncertain",
      ]);
      await client.query(
        `UPDATE company_session_contributions
            SET status = CASE WHEN $2 = 'failed' THEN 'failed' ELSE 'blocked' END,
                completed_at = now()
          WHERE run_id = $1 AND status IN ('queued','working')`,
        [runId, state],
      );
      if (state === "failed") {
        await settleModelReservation(client, row.estimated_cost_usd_micros, row.created_at, false);
      }
      await event(client, `agent.run.${state}`, runId, { code });
    });
  }
}

function specialistPrompt(row: z.infer<typeof claimRowSchema>): string {
  const projectName = process.env.COMPANY_OS_PROJECT_NAME ?? "le projet connecté";
  const workspace = process.env.COMPANY_OS_PROJECT_ROOT ?? process.cwd();
  const verification = verificationPayloadSchema.safeParse(row.outboxPayload);
  if (verification.success) {
    return [
      `You are the independent ${projectName} ${row.agentId} verifier.`,
      "Review the prior agent's owner-safe summary against the task outcome and repository evidence.",
      "Do not modify files, access the network, spend money, deploy, advertise, or contact anyone.",
      `Task: ${row.title}`,
      `Required outcome: ${row.intendedOutcome}`,
      `Prior run: ${verification.data.verificationOfRunId}`,
      `Prior result: ${verification.data.verificationSummary}`,
      "Return only the required structured verdict: approved, changes_required, or blocked, with a concise safe summary.",
    ].join("\n");
  }
  const session = strategicSessionPayloadSchema.safeParse(row.outboxPayload);
  if (session.success) {
    const role = row.agentId === "ceo" ? "directeur général" : `agent ${row.agentId}`;
    return [
      `Tu es le ${role} interne de ${projectName} dans une session stratégique autonome locale.`,
      `Travaille uniquement dans ${workspace} et respecte son AGENTS.md.`,
      "Ne révèle jamais de raisonnement interne. Donne seulement constats, arguments, preuves locales, risques, dépendances, décisions et livrables.",
      "Aucune dépense, publication, publicité, email, contact tiers ou déploiement de production.",
      `Étape: ${session.data.sessionStage}, tour ${session.data.round}.`,
      `Sujet: ${row.title}`,
      `Résultat demandé: ${row.intendedOutcome}`,
      row.agentId === "ceo" && session.data.sessionStage === "ceo_decision"
        ? "Respecte exactement le format de délégation demandé dans le résultat."
        : "Retourne une contribution concise, compréhensible par un propriétaire non technique.",
    ].join("\n");
  }
  return [
    `You are the internal ${projectName} ${row.agentId} agent.`,
    `Work only inside ${workspace} and follow its AGENTS.md.`,
    "Do not spend money, deploy production, launch ads, contact people, or perform irreversible financial actions.",
    "Never access paths outside the assigned workspace or any root forbidden by Company OS.",
    `Task: ${row.title}`,
    `Required outcome: ${row.intendedOutcome}`,
    `Risk class: ${row.riskClass}`,
    "Return only the required structured result.",
    "Use status=completed only when the requested deliverable actually exists and the listed evidence was checked.",
    "Use status=blocked when no deliverable was produced, including any permission, sandbox, dependency or environment failure.",
    "Do not include secrets, customer data, hidden reasoning, or raw quote contents.",
  ].join("\n");
}

async function markRunUncertain(client: PoolClient, runId: string, code: string): Promise<void> {
  const run = await client.query<{ task_id: string; agent_instance_id: string }>(
    `UPDATE cockpit_runs SET state = 'reconciliation_required', lease_owner = NULL, lease_expires_at = NULL
     WHERE id = $1 AND state <> 'completed' RETURNING task_id, agent_instance_id`,
    [runId],
  );
  const row = run.rows[0];
  if (!row) return;
  await client.query("UPDATE cockpit_tasks SET status = 'problem', updated_at = now() WHERE id = $1", [row.task_id]);
  await client.query("UPDATE cockpit_agent_instances SET state = 'uncertain', heartbeat_at = now() WHERE id = $1", [row.agent_instance_id]);
  await client.query(
    "UPDATE cockpit_outbox SET state = 'reconciliation_required', lease_owner = NULL, lease_expires_at = NULL WHERE run_id = $1 AND state IN ('leased','sent')",
    [runId],
  );
  await event(client, "agent.run.reconciliation_required", runId, { code });
}

async function queueVerifier(client: PoolClient, completedRunId: string, taskId: string, verificationSummary: string): Promise<void> {
  const source = await client.query<{
    verifier_agent_id: string | null; router_version: string; model_profile: string; selected_model: string;
    reasoning_effort: string; routing_score: number; routing_factors: unknown; estimated_cost_usd_micros: string;
  }>(
    `SELECT t.verifier_agent_id, r.router_version, r.model_profile, r.selected_model,
            r.reasoning_effort, r.routing_score, r.routing_factors, r.estimated_cost_usd_micros::text
     FROM cockpit_tasks t JOIN cockpit_runs r ON r.id = $2 WHERE t.id = $1 FOR UPDATE OF t`,
    [taskId, completedRunId],
  );
  const row = source.rows[0];
  if (!row?.verifier_agent_id) throw new Error("VERIFIER_AGENT_MISSING");
  const instance = await client.query<{ id: string; thread_id: string }>(
    `SELECT id, thread_id FROM cockpit_agent_instances
     WHERE agent_id = $1 AND retired_at IS NULL AND state NOT IN ('offline','paused','problem','uncertain') FOR SHARE`,
    [row.verifier_agent_id],
  );
  const verifier = instance.rows[0];
  if (!verifier) throw new Error("ACTIVE_VERIFIER_INSTANCE_REQUIRED");
  const sourceCost = Number(row.estimated_cost_usd_micros);
  if (!Number.isSafeInteger(sourceCost) || sourceCost < 0) throw new Error("INVALID_SOURCE_RUN_COST");
  const verifierCost = Math.max(5_000, Math.ceil(sourceCost / 2));
  const reserved = await client.query(
    `UPDATE cockpit_budgets SET model_usage_reserved_usd_micros = model_usage_reserved_usd_micros + $1,
       version = version + 1, updated_at = now()
     WHERE scope = 'company:model:daily' AND period_start <= now() AND period_end > now()
       AND model_usage_reserved_usd_micros + model_usage_actual_usd_micros + $1 <= model_usage_limit_usd_micros
     RETURNING id`,
    [verifierCost],
  );
  if (!reserved.rows[0]) throw new Error("VERIFIER_MODEL_BUDGET_EXCEEDED");
  const run = await client.query<{ id: string }>(
    `INSERT INTO cockpit_runs
      (task_id, agent_instance_id, transport, router_version, model_profile, selected_model,
       reasoning_effort, routing_score, routing_factors, requires_distinct_verifier, codex_thread_id,
       estimated_cost_usd_micros)
     SELECT $1,$2,transport,$3,$4,$5,$6,$7,$8 || $9::jsonb,false,$10,$11
     FROM cockpit_agent_instances WHERE id = $2 RETURNING id`,
    [taskId, verifier.id, row.router_version, row.model_profile, row.selected_model,
      row.reasoning_effort, row.routing_score, row.routing_factors, JSON.stringify({ verificationOfRunId: completedRunId }), verifier.thread_id, verifierCost],
  );
  const verifierRunId = run.rows[0]?.id;
  if (!verifierRunId) throw new Error("VERIFIER_RUN_NOT_CREATED");
  await client.query(
    "INSERT INTO cockpit_outbox (run_id, destination, safe_payload) VALUES ($1,$2,$3)",
    [verifierRunId, `codex:${row.verifier_agent_id}`, safeOperationalPayloadSchema.parse({
      version: 1, taskId, runId: verifierRunId, agentId: row.verifier_agent_id,
      verificationOfRunId: completedRunId, verificationSummary, externalSpendUsdMicros: 0,
    })],
  );
  await client.query("UPDATE cockpit_tasks SET status = 'verification', updated_at = now() WHERE id = $1", [taskId]);
  await event(client, "agent.verification.queued", verifierRunId, { taskId, verificationOfRunId: completedRunId });
}

async function event(client: PoolClient, eventType: string, aggregateId: string, payload: unknown): Promise<void> {
  await client.query(
    `INSERT INTO cockpit_events (event_type, aggregate_type, aggregate_id, safe_payload)
     VALUES ($1,'run',$2,$3)`,
    [eventType, aggregateId, safeOperationalPayloadSchema.parse(payload)],
  );
}

async function settleModelReservation(client: PoolClient, rawAmount: string, createdAt: Date, consumed: boolean): Promise<void> {
  const amount = Number(rawAmount);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("INVALID_RUN_MODEL_COST");
  if (amount === 0) return;
  const updated = await client.query(
    `UPDATE cockpit_budgets
     SET model_usage_reserved_usd_micros = model_usage_reserved_usd_micros - $1,
         model_usage_actual_usd_micros = model_usage_actual_usd_micros + $2,
         version = version + 1, updated_at = now()
     WHERE scope = 'company:model:daily' AND period_start <= $3 AND period_end > $3
       AND model_usage_reserved_usd_micros >= $1`,
    [amount, consumed ? amount : 0, createdAt],
  );
  if (updated.rowCount !== 1) throw new Error("MODEL_BUDGET_SETTLEMENT_FAILED");
}
