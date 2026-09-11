import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { ownerAgentPresentation } from "../agents/owner-presentation";
import { companyAgentIdSchema, riskClassSchema } from "../agents/registry";
import { canonicalActionSchema, canonicalizeAction, digestCanonicalAction } from "../cockpit/canonical-action";
import { safeOperationalPayloadSchema } from "../cockpit/domain";
import { assertSafeOwnerMessage } from "../cockpit/owner-message-policy";
import { routeModel, type ModelRouterConfig } from "../cockpit/model-orchestrator";
import { routerInputSchema } from "../cockpit/domain";
import {
  agentStatusForOwner,
  cockpitAgentStatusSchema,
  cockpitRunStatusSchema,
  cockpitTaskStatusSchema,
  modelProfileSchema,
  ownerFacingStatusSchema,
  taskStatusForOwner,
} from "../cockpit/domain";
import { buildAgentActivities, type AgentActivity } from "../cockpit/agent-activity";
import { withTransaction } from "./pool";

const createCommandSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
  expectedAggregateVersion: z.number().int().min(0),
  commandType: z.string().trim().min(1).max(100),
  safePayload: safeOperationalPayloadSchema,
  expiresAt: z.date(),
}).strict();

const ownerMessagePayloadSchema = z.object({
  message: z.string().trim().min(1).max(1_200),
  ownerVisibleMessage: z.string().trim().min(1).max(1_200).optional(),
  actorId: z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/).optional(),
  actorRole: z.enum(["owner", "operator"]).optional(),
}).strict();

const createTaskSchema = z.object({
  sourceCommandId: z.string().uuid().optional(),
  parentTaskId: z.string().uuid().optional(),
  assignedAgentId: companyAgentIdSchema,
  verifierAgentId: companyAgentIdSchema.optional(),
  title: z.string().trim().min(1).max(300),
  intendedOutcome: z.string().trim().min(1).max(2_000),
  riskClass: riskClassSchema,
}).strict().refine((value) => value.assignedAgentId !== value.verifierAgentId, {
  message: "The verifier must be distinct from the accountable agent.",
  path: ["verifierAgentId"],
});

const createApprovalSchema = z.object({
  taskId: z.string().uuid(),
  requestedByAgentId: companyAgentIdSchema,
  riskClass: z.enum(["financial", "advertising", "production"]),
  action: canonicalActionSchema,
  ownerExplanation: z.object({
    willHappen: z.string().trim().min(1).max(1_000),
    willNotHappen: z.string().trim().min(1).max(1_000),
    refusalEffect: z.string().trim().min(1).max(1_000),
    reversible: z.string().trim().min(1).max(500),
  }).strict(),
  expiresAt: z.date(),
}).strict();

const decideApprovalSchema = z.object({
  approvalId: z.string().uuid(),
  actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  policyVersion: z.number().int().positive(),
  actionVersion: z.number().int().positive(),
  decision: z.enum(["approved", "refused"]),
}).strict();

const sequenceSchema = z.union([z.string().regex(/^\d+$/), z.number().int().min(0)]).transform(String);
const eventRowSchema = z.object({
  sequence: sequenceSchema,
  id: z.string().uuid(),
  eventType: z.string(),
  aggregateType: z.enum(["agent", "command", "task", "run", "approval", "budget", "pause", "system"]),
  aggregateId: z.string(),
  safePayload: safeOperationalPayloadSchema,
  occurredAt: z.date(),
}).strict();

const agentSnapshotRowSchema = z.object({
  id: companyAgentIdSchema,
  displayName: z.string(),
  status: cockpitAgentStatusSchema,
  currentTaskId: z.string().uuid().nullable(),
  currentTaskTitle: z.string().nullable(),
  modelProfile: modelProfileSchema.nullable(),
  heartbeatAt: z.date().nullable(),
}).strict();

const agentActivitySourceRowSchema = z.object({
  agentId: companyAgentIdSchema,
  agentStatus: cockpitAgentStatusSchema,
  taskId: z.string().uuid().nullable(),
  taskTitle: z.string().nullable(),
  intendedOutcome: z.string().nullable(),
  taskStatus: cockpitTaskStatusSchema.nullable(),
  runId: z.string().uuid().nullable(),
  runState: cockpitRunStatusSchema.nullable(),
  modelProfile: modelProfileSchema.nullable(),
  startedAt: z.date().nullable(),
  lastSignalAt: z.date().nullable(),
  conclusion: z.string().max(4_000).nullable(),
  deliverables: z.array(z.string().min(1).max(500)).max(12),
  isSimulation: z.boolean(),
}).strict();

const taskSnapshotRowSchema = z.object({
  id: z.string().uuid(),
  assignedAgentId: companyAgentIdSchema,
  verifierAgentId: companyAgentIdSchema.nullable(),
  title: z.string(),
  intendedOutcome: z.string(),
  completionSummary: z.string().nullable(),
  riskClass: riskClassSchema,
  status: cockpitTaskStatusSchema,
  aggregateVersion: z.number().int().min(0),
  updatedAt: z.date(),
}).strict();

const approvalSnapshotRowSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  requestedByAgentId: companyAgentIdSchema,
  actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  policyVersion: z.number().int().positive(),
  actionVersion: z.number().int().positive(),
  riskClass: z.enum(["financial", "advertising", "production"]),
  ownerExplanation: z.object({
    willHappen: z.string(),
    willNotHappen: z.string(),
    refusalEffect: z.string(),
    reversible: z.string(),
  }).strict(),
  expiresAt: z.date(),
  createdAt: z.date(),
}).strict();

const pauseSnapshotSchema = z.object({
  state: z.enum(["running", "pause_active", "interruption_requested", "work_still_active", "confirmed_stopped"]),
  reason: z.string().nullable(),
  version: z.number().int().min(0),
  changedBy: z.string(),
  changedAt: z.date(),
}).strict();

const runtimeStatusSchema = z.enum(["connected", "degraded", "offline"]);
const runtimeHealthRowSchema = z.object({
  component: z.enum(["supervisor", "bridge", "codex"]),
  status: runtimeStatusSchema,
  detailCode: z.string().nullable(),
  heartbeatAt: z.date(),
}).strict();

export type CockpitRuntimeHealth = {
  database: { status: "connected"; heartbeatAt: Date };
  supervisor: z.infer<typeof runtimeHealthRowSchema>;
  bridge: z.infer<typeof runtimeHealthRowSchema>;
  codex: z.infer<typeof runtimeHealthRowSchema>;
};

const messageSnapshotRowSchema = z.object({
  id: z.string().uuid(),
  sender: z.enum(["owner", "ceo"]),
  commandId: z.string().uuid(),
  safeBody: z.string().min(1).max(16_384),
  status: z.enum(["pending", "dispatched", "completed", "failed", "reconciliation_required", "demo"]),
  createdAt: z.date(),
}).strict();

const ownerStateRowSchema = z.object({
  commandVersion: z.number().int().min(0),
}).strict();

export type CockpitEvent = z.infer<typeof eventRowSchema>;
export type CockpitSnapshot = {
  agents: Array<z.infer<typeof agentSnapshotRowSchema> & {
    displayName: string;
    role: string;
    ownerStatus: z.infer<typeof ownerFacingStatusSchema>;
  }>;
  agentActivity: AgentActivity[];
  tasks: Array<z.infer<typeof taskSnapshotRowSchema> & { ownerStatus: z.infer<typeof ownerFacingStatusSchema> }>;
  approvals: z.infer<typeof approvalSnapshotRowSchema>[];
  messages: z.infer<typeof messageSnapshotRowSchema>[];
  pause: z.infer<typeof pauseSnapshotSchema>;
  health: CockpitRuntimeHealth;
  latestEvents: CockpitEvent[];
  lastSequence: string;
  commandVersion: number;
};

export class CockpitRepository {
  constructor(private readonly pool: Pool) {}

  async createOwnerCommand(rawInput: unknown): Promise<string> {
    const input = createCommandSchema.parse(rawInput);
    if (input.commandType !== "owner.message") throw new Error("OWNER_COMMAND_TYPE_UNSUPPORTED");
    if (input.expiresAt.getTime() <= Date.now()) throw new Error("COMMAND_ALREADY_EXPIRED");
    return withTransaction(this.pool, async (client) => {
      const replay = await client.query<{ id: string }>(
        "SELECT id FROM cockpit_commands WHERE idempotency_key = $1",
        [input.idempotencyKey],
      );
      if (replay.rows[0]) return replay.rows[0].id;
      const ownerMessage = ownerMessagePayloadSchema.parse(input.safePayload);
      assertSafeOwnerMessage(ownerMessage.message);
      if (ownerMessage.ownerVisibleMessage) assertSafeOwnerMessage(ownerMessage.ownerVisibleMessage);
      const versionResult = await client.query<{ commandVersion: number }>(
        `SELECT command_version AS "commandVersion"
         FROM cockpit_owner_state WHERE id = 1 FOR UPDATE`,
      );
      const ownerState = ownerStateRowSchema.safeParse(versionResult.rows[0]);
      if (!ownerState.success) throw new Error("COCKPIT_OWNER_STATE_NOT_CONFIGURED");
      if (ownerState.data.commandVersion !== input.expectedAggregateVersion) {
        throw new Error("COMMAND_STALE_VERSION");
      }
      const id = randomUUID();
      const result = await client.query<{ id: string }>(
        `INSERT INTO cockpit_commands
          (id, idempotency_key, target_agent_id, expected_aggregate_version, command_type, safe_payload, expires_at)
         VALUES ($1,$2,'ceo',$3,$4,$5,$6)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
        [id, input.idempotencyKey, input.expectedAggregateVersion, input.commandType, input.safePayload, input.expiresAt],
      );
      const insertedId = result.rows[0]?.id;
      if (!insertedId) {
        throw new Error("COMMAND_NOT_CREATED");
      }
      const advanced = await client.query<{ commandVersion: number }>(
        `UPDATE cockpit_owner_state
         SET command_version = command_version + 1, updated_at = now()
         WHERE id = 1 AND command_version = $1
         RETURNING command_version AS "commandVersion"`,
        [input.expectedAggregateVersion],
      );
      const nextOwnerState = ownerStateRowSchema.safeParse(advanced.rows[0]);
      if (!nextOwnerState.success) throw new Error("COMMAND_STALE_VERSION");
      await client.query(
        `INSERT INTO cockpit_messages (sender, command_id, safe_body, status)
         VALUES ('owner',$1,$2,'pending')`,
        [insertedId, ownerMessage.ownerVisibleMessage ?? ownerMessage.message],
      );
      const outboxPayload = safeOperationalPayloadSchema.parse({
        commandId: insertedId,
        commandType: input.commandType,
        expectedAggregateVersion: input.expectedAggregateVersion,
        safePayload: input.safePayload,
        expiresAt: input.expiresAt.toISOString(),
      });
      await client.query(
        `INSERT INTO cockpit_outbox (command_id, destination, safe_payload)
         VALUES ($1,'codex:ceo',$2)`,
        [insertedId, outboxPayload],
      );
      await client.query(
        `INSERT INTO cockpit_events (event_type, aggregate_type, aggregate_id, safe_payload)
         VALUES ('owner.command.created','command',$1,$2)`,
        [insertedId, safeOperationalPayloadSchema.parse({
          commandType: input.commandType,
          actorId: ownerMessage.actorId ?? "owner",
          actorRole: ownerMessage.actorRole ?? "owner",
          expectedAggregateVersion: input.expectedAggregateVersion,
          commandVersion: nextOwnerState.data.commandVersion,
          expiresAt: input.expiresAt.toISOString(),
        })],
      );
      return insertedId;
    });
  }

  async createTask(rawInput: unknown): Promise<string> {
    const input = createTaskSchema.parse(rawInput);
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO cockpit_tasks
        (id, parent_task_id, source_command_id, assigned_agent_id, verifier_agent_id, title, intended_outcome, risk_class)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, input.parentTaskId ?? null, input.sourceCommandId ?? null, input.assignedAgentId,
        input.verifierAgentId ?? null, input.title, input.intendedOutcome, input.riskClass],
    );
    return id;
  }

  async createRoutedRun(inputRaw: unknown, agentInstanceId: string, config?: ModelRouterConfig): Promise<string> {
    const input = routerInputSchema.parse(inputRaw);
    const instanceId = z.string().uuid().parse(agentInstanceId);
    const decision = routeModel(input, config);
    const runId = randomUUID();
    await withTransaction(this.pool, async (client) => {
      const instance = await client.query<{ agent_id: string; transport: "app_server" | "exec_resume" }>(
        `SELECT agent_id, transport FROM cockpit_agent_instances
         WHERE id = $1 AND retired_at IS NULL FOR SHARE`,
        [instanceId],
      );
      const active = instance.rows[0];
      if (!active || active.agent_id !== input.accountableAgentId) throw new Error("AGENT_INSTANCE_MISMATCH");
      await client.query(
        `INSERT INTO cockpit_runs
          (id, task_id, agent_instance_id, transport, router_version, model_profile, selected_model,
           reasoning_effort, routing_score, routing_factors, routing_overridden, fallback_reason,
           requires_distinct_verifier, estimated_cost_usd_micros)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [runId, input.taskId, instanceId, active.transport, decision.routerVersion, decision.profile,
          decision.model, decision.reasoningEffort, decision.score, decision.factors, decision.overridden,
          decision.fallbackReason, decision.requiresDistinctVerifier, input.estimatedCostUsdMicros],
      );
      await client.query(
        `INSERT INTO cockpit_events (event_type, aggregate_type, aggregate_id, safe_payload)
         VALUES ('model.routing.selected','run',$1,$2)`,
        [runId, {
          routerVersion: decision.routerVersion, profile: decision.profile, model: decision.model,
          reasoningEffort: decision.reasoningEffort, score: decision.score, factors: decision.factors,
          overridden: decision.overridden, fallbackReason: decision.fallbackReason,
        }],
      );
    });
    return runId;
  }

  async requestApproval(rawInput: unknown): Promise<{ id: string; digest: string }> {
    const input = createApprovalSchema.parse(rawInput);
    if (input.expiresAt.getTime() <= Date.now()) throw new Error("APPROVAL_ALREADY_EXPIRED");
    const canonical = JSON.parse(canonicalizeAction(input.action)) as Record<string, unknown>;
    const digest = digestCanonicalAction(input.action);
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO cockpit_approvals
        (id, task_id, requested_by_agent_id, canonical_action, owner_explanation, action_digest,
         policy_version, action_version, risk_class, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, input.taskId, input.requestedByAgentId, canonical, input.ownerExplanation, digest,
        input.action.policyVersion, input.action.actionVersion, input.riskClass, input.expiresAt],
    );
    return { id, digest };
  }

  async decideApproval(rawInput: unknown): Promise<void> {
    const input = decideApprovalSchema.parse(rawInput);
    await withTransaction(this.pool, async (client) => {
      const updated = await client.query<{ task_id: string }>(
        `UPDATE cockpit_approvals SET state = $2, decided_at = now()
         WHERE id = $1 AND state = 'pending' AND expires_at > now()
           AND action_digest = $3 AND policy_version = $4 AND action_version = $5
         RETURNING task_id`,
        [input.approvalId, input.decision, input.actionDigest, input.policyVersion, input.actionVersion],
      );
      const taskId = updated.rows[0]?.task_id;
      if (!taskId) throw new Error("APPROVAL_STALE_OR_MISMATCHED");
      await client.query(
        `INSERT INTO cockpit_events (event_type, aggregate_type, aggregate_id, safe_payload)
         VALUES ($1,'approval',$2,$3)`,
        [`approval.${input.decision}`, input.approvalId, safeOperationalPayloadSchema.parse({
          taskId,
          actionDigest: input.actionDigest,
          policyVersion: input.policyVersion,
          actionVersion: input.actionVersion,
        })],
      );
    });
  }

  async getSnapshot(eventLimit = 100): Promise<CockpitSnapshot> {
    const limit = z.number().int().min(1).max(500).parse(eventLimit);
    return withTransaction(this.pool, async (client) => {
      const [agentsResult, activityResult, tasksResult, approvalsResult, messagesResult, pauseResult, healthResult, eventsResult, ownerStateResult] = await Promise.all([
        client.query(
          `SELECT a.id, a.display_name AS "displayName", COALESCE(i.state, 'offline') AS status,
                  current_task.id AS "currentTaskId", current_task.title AS "currentTaskTitle",
                  current_run.model_profile AS "modelProfile", i.heartbeat_at AS "heartbeatAt"
           FROM cockpit_agents a
           LEFT JOIN cockpit_agent_instances i ON i.agent_id = a.id AND i.retired_at IS NULL
           LEFT JOIN LATERAL (
             SELECT t.id, t.title FROM cockpit_tasks t
             WHERE t.assigned_agent_id = a.id AND t.status IN ('queued','working','action_required','verification','paused')
             ORDER BY t.updated_at DESC LIMIT 1
           ) current_task ON true
           LEFT JOIN LATERAL (
             SELECT r.model_profile FROM cockpit_runs r
             WHERE r.task_id = current_task.id
             ORDER BY r.created_at DESC LIMIT 1
           ) current_run ON true
           WHERE a.enabled = true ORDER BY CASE WHEN a.id = 'ceo' THEN 0 ELSE 1 END, a.display_name`,
        ),
        client.query(
          `SELECT a.id AS "agentId", COALESCE(i.state, 'offline') AS "agentStatus",
                  recent_task.id AS "taskId", recent_task.title AS "taskTitle",
                  recent_task.intended_outcome AS "intendedOutcome", recent_task.status AS "taskStatus",
                  recent_run.id AS "runId", recent_run.state AS "runState",
                  recent_run.model_profile AS "modelProfile",
                  COALESCE(recent_run.started_at, recent_run.created_at, recent_task.created_at) AS "startedAt",
                  i.heartbeat_at AS "lastSignalAt",
                  conclusion_event.summary AS conclusion,
                  COALESCE(evidence_event.evidence, '[]'::jsonb) AS deliverables,
                  EXISTS (
                    SELECT 1 FROM cockpit_events mode_event
                    WHERE mode_event.aggregate_type = 'run'
                      AND mode_event.aggregate_id = recent_run.id::text
                      AND (
                        mode_event.safe_payload ->> 'transport' = 'demo-v1'
                        OR mode_event.safe_payload ->> 'demo' = 'true'
                      )
                  ) AS "isSimulation"
           FROM cockpit_agents a
           LEFT JOIN cockpit_agent_instances i ON i.agent_id = a.id AND i.retired_at IS NULL
           LEFT JOIN LATERAL (
             SELECT t.id, t.title, t.intended_outcome, t.status, t.created_at, t.updated_at
             FROM cockpit_tasks t
             WHERE (
                 t.assigned_agent_id = a.id
                 OR (t.verifier_agent_id = a.id AND t.status = 'verification')
               )
               AND (
                 t.status IN ('queued','working','action_required','verification','paused','problem')
                 OR t.updated_at > now() - interval '10 minutes'
               )
             ORDER BY
               CASE WHEN t.status IN ('queued','working','action_required','verification','paused') THEN 0 ELSE 1 END,
               t.updated_at DESC
             LIMIT 1
           ) recent_task ON true
           LEFT JOIN LATERAL (
             SELECT r.id, r.state, r.model_profile, r.created_at, r.started_at
             FROM cockpit_runs r
             JOIN cockpit_agent_instances run_instance ON run_instance.id = r.agent_instance_id
             WHERE r.task_id = recent_task.id
               AND run_instance.agent_id = a.id
             ORDER BY r.created_at DESC LIMIT 1
           ) recent_run ON true
           LEFT JOIN LATERAL (
             SELECT left(result_event.safe_payload ->> 'summary', 4000) AS summary
             FROM cockpit_events result_event
             WHERE result_event.aggregate_type = 'run'
               AND result_event.aggregate_id = recent_run.id::text
               AND result_event.event_type IN ('agent.run.completed','agent.run.conclusion.corrected','agent.run.blocked')
               AND result_event.safe_payload ? 'summary'
             ORDER BY result_event.sequence DESC LIMIT 1
           ) conclusion_event ON true
           LEFT JOIN LATERAL (
             SELECT result_event.safe_payload -> 'evidence' AS evidence
             FROM cockpit_events result_event
             WHERE result_event.aggregate_type = 'run'
               AND result_event.aggregate_id = recent_run.id::text
               AND result_event.event_type IN ('agent.run.completed','agent.run.conclusion.corrected','agent.run.blocked')
               AND jsonb_typeof(result_event.safe_payload -> 'evidence') = 'array'
             ORDER BY result_event.sequence DESC LIMIT 1
           ) evidence_event ON true
           WHERE a.enabled = true
           ORDER BY CASE WHEN a.id = 'ceo' THEN 0 ELSE 1 END, a.display_name`,
        ),
        client.query(
          `SELECT task.id, task.assigned_agent_id AS "assignedAgentId",
                  task.verifier_agent_id AS "verifierAgentId",
                  task.title, task.intended_outcome AS "intendedOutcome",
                  completion.summary AS "completionSummary",
                  task.risk_class AS "riskClass", task.status,
                  task.aggregate_version AS "aggregateVersion", task.updated_at AS "updatedAt"
           FROM cockpit_tasks task
           LEFT JOIN LATERAL (
             SELECT left(event.safe_payload ->> 'summary', 4000) AS summary
             FROM cockpit_runs run
             JOIN cockpit_events event
               ON event.aggregate_type = 'run'
              AND event.aggregate_id = run.id::text
              AND event.event_type IN ('agent.run.completed', 'agent.run.conclusion.corrected')
             WHERE run.task_id = task.id
               AND event.safe_payload ? 'summary'
             ORDER BY event.occurred_at DESC
             LIMIT 1
           ) completion ON true
           ORDER BY task.updated_at DESC LIMIT 200`,
        ),
        client.query(
          `SELECT id, task_id AS "taskId", requested_by_agent_id AS "requestedByAgentId",
                  action_digest AS "actionDigest", policy_version AS "policyVersion",
                  action_version AS "actionVersion", risk_class AS "riskClass",
                  owner_explanation AS "ownerExplanation",
                  expires_at AS "expiresAt", created_at AS "createdAt"
           FROM cockpit_approvals WHERE state = 'pending' AND expires_at > now()
           ORDER BY created_at`,
        ),
        client.query(
          `SELECT id, sender, command_id AS "commandId", safe_body AS "safeBody", status,
                  created_at AS "createdAt"
           FROM cockpit_messages WHERE expires_at > now()
           ORDER BY created_at DESC LIMIT 200`,
        ),
        client.query(
          `SELECT state, reason, version, changed_by AS "changedBy", changed_at AS "changedAt"
           FROM cockpit_pause WHERE id = 1`,
        ),
        client.query(
          `SELECT component, status, detail_code AS "detailCode", heartbeat_at AS "heartbeatAt"
           FROM cockpit_runtime_health ORDER BY component`,
        ),
        client.query(
          `SELECT sequence, id, event_type AS "eventType", aggregate_type AS "aggregateType",
                  aggregate_id AS "aggregateId", safe_payload AS "safePayload", occurred_at AS "occurredAt"
           FROM cockpit_events WHERE expires_at > now() ORDER BY sequence DESC LIMIT $1`,
          [limit],
        ),
        client.query(
          `SELECT command_version AS "commandVersion"
           FROM cockpit_owner_state WHERE id = 1`,
        ),
      ]);
      const agents = z.array(agentSnapshotRowSchema).parse(agentsResult.rows)
        .map((agent) => {
          const presentation = ownerAgentPresentation(agent.id);
          return {
            ...agent,
            displayName: presentation.name,
            role: presentation.role,
            ownerStatus: agentStatusForOwner(agent.status),
          };
        });
      const activitySources = z.array(agentActivitySourceRowSchema).parse(activityResult.rows);
      const tasks = z.array(taskSnapshotRowSchema).parse(tasksResult.rows)
        .map((task) => ({ ...task, ownerStatus: taskStatusForOwner(task.status) }));
      const approvals = z.array(approvalSnapshotRowSchema).parse(approvalsResult.rows);
      const messages = z.array(messageSnapshotRowSchema).parse(messagesResult.rows).reverse();
      const pause = pauseSnapshotSchema.parse(pauseResult.rows[0]);
      const measuredAt = new Date();
      const healthRows = z.array(runtimeHealthRowSchema).parse(healthResult.rows);
      const component = (name: "supervisor" | "bridge" | "codex") => {
        const row = healthRows.find((candidate) => candidate.component === name) ?? {
          component: name, status: "offline" as const, detailCode: "heartbeat_missing", heartbeatAt: new Date(0),
        };
        const age = measuredAt.getTime() - row.heartbeatAt.getTime();
        return {
          ...row,
          status: age > 15_000 ? "offline" as const : age > 5_000 && row.status === "connected" ? "degraded" as const : row.status,
        };
      };
      const health: CockpitRuntimeHealth = {
        database: { status: "connected", heartbeatAt: measuredAt },
        supervisor: component("supervisor"), bridge: component("bridge"), codex: component("codex"),
      };
      const latestEvents = z.array(eventRowSchema).parse(eventsResult.rows).reverse();
      const agentActivity = buildAgentActivities(activitySources, latestEvents);
      const ownerState = ownerStateRowSchema.parse(ownerStateResult.rows[0]);
      return {
        agents, agentActivity, tasks, approvals, messages, pause, health, latestEvents,
        lastSequence: latestEvents.at(-1)?.sequence ?? "0",
        commandVersion: ownerState.commandVersion,
      };
    });
  }

  async listEventsAfter(afterSequence: string | number, limit = 250): Promise<CockpitEvent[]> {
    const sequence = sequenceSchema.parse(afterSequence);
    const boundedLimit = z.number().int().min(1).max(500).parse(limit);
    const result = await this.pool.query(
      `SELECT sequence, id, event_type AS "eventType", aggregate_type AS "aggregateType",
              aggregate_id AS "aggregateId", safe_payload AS "safePayload", occurred_at AS "occurredAt"
       FROM cockpit_events
       WHERE sequence > $1::bigint AND expires_at > now()
       ORDER BY sequence LIMIT $2`,
      [sequence, boundedLimit],
    );
    return z.array(eventRowSchema).parse(result.rows);
  }

  async purgeExpiredEvents(): Promise<number> {
    const events = await this.pool.query("DELETE FROM cockpit_events WHERE expires_at <= now()");
    await this.pool.query("DELETE FROM cockpit_messages WHERE expires_at <= now()");
    // Commands duplicate the owner message in safe_payload and their outbox
    // rows duplicate it again. Removing terminal commands after the same
    // 30-day window cascades both copies while preserving active work.
    await this.pool.query(
      `DELETE FROM cockpit_commands
       WHERE created_at <= now() - interval '30 days'
         AND state IN ('completed','rejected','expired')`,
    );
    return events.rowCount ?? 0;
  }

  async setGeneralPause(state: "running" | "pause_active" | "interruption_requested" | "work_still_active" | "confirmed_stopped", changedBy: string, reason?: string): Promise<void> {
    const actor = z.string().trim().min(1).max(100).parse(changedBy);
    const safeReason = z.string().trim().min(1).max(500).optional().parse(reason);
    await withTransaction(this.pool, async (client) => {
      const updated = await client.query<{ version: number }>(
        `UPDATE cockpit_pause SET state = $1, reason = $2, changed_by = $3,
         changed_at = now(), version = version + 1 WHERE id = 1 RETURNING version`,
        [state, safeReason ?? null, actor],
      );
      if (!updated.rows[0]) throw new Error("COCKPIT_PAUSE_NOT_CONFIGURED");
      await client.query(
        `INSERT INTO cockpit_events (event_type, aggregate_type, aggregate_id, safe_payload)
         VALUES ('pause.changed','pause','global',$1)`,
        [safeOperationalPayloadSchema.parse({ state, reason: safeReason ?? null, changedBy: actor, version: updated.rows[0].version })],
      );
    });
  }

  async getPauseState(): Promise<z.infer<typeof pauseSnapshotSchema>> {
    const result = await this.pool.query(
      `SELECT state, reason, version, changed_by AS "changedBy", changed_at AS "changedAt"
       FROM cockpit_pause WHERE id = 1`,
    );
    return pauseSnapshotSchema.parse(result.rows[0]);
  }

  async heartbeatRuntime(
    component: "supervisor" | "bridge" | "codex",
    status: "connected" | "degraded" | "offline",
    detailCode?: string,
  ): Promise<void> {
    const safeDetail = z.string().regex(/^[a-z0-9_.-]{1,100}$/).optional().parse(detailCode);
    await this.pool.query(
      `INSERT INTO cockpit_runtime_health (component, status, detail_code, heartbeat_at, updated_at)
       VALUES ($1,$2,$3,now(),now())
       ON CONFLICT (component) DO UPDATE SET status = EXCLUDED.status,
         detail_code = EXCLUDED.detail_code, heartbeat_at = EXCLUDED.heartbeat_at, updated_at = now()`,
      [component, status, safeDetail ?? null],
    );
  }
}
