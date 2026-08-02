import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { COMPANY_AGENTS } from "../agents/registry";
import { modelProfileSchema, reasoningEffortSchema, safeOperationalPayloadSchema } from "../cockpit/domain";
import { assertSafeOwnerMessage } from "../cockpit/owner-message-policy";
import { canonicalizeAction, digestCanonicalAction } from "../cockpit/canonical-action";
import {
  ROUTER_VERSION,
  modelRouterConfigSchema,
  routeModel,
  type ModelRouterConfig,
  type ModelRoutingDecision,
} from "../cockpit/model-orchestrator";
import { withTransaction } from "../db/pool";
import { ceoDelegationEnvelopeSchema, type CeoDelegationTask } from "./delegation-schema";

const requestSchema = z.object({
  ceoTurnId: z.string().trim().min(1).max(300),
  sourceCommandId: z.string().uuid().optional(),
  delegation: ceoDelegationEnvelopeSchema,
  budgetScope: z.literal("company:model:daily").default("company:model:daily"),
}).strict();

const allowlistRowSchema = z.object({
  profile: modelProfileSchema,
  model: z.string().min(1).max(100),
  reasoningEffort: reasoningEffortSchema,
}).strict();

export type AllowlistRow = z.infer<typeof allowlistRowSchema>;
export type DelegatedRun = { taskId: string; runId: string; decision: ModelRoutingDecision };
const OWNER_GATED_RISKS = new Set(["financial", "advertising", "production"]);

export class CeoDelegationService {
  constructor(private readonly pool: Pool, private readonly env: NodeJS.ProcessEnv = process.env) {}

  async delegate(rawRequest: unknown): Promise<DelegatedRun[]> {
    const request = requestSchema.parse(rawRequest);
    if (request.delegation.tasks.length === 0) return [];
    return withTransaction(this.pool, async (client) => {
      await assertCockpitRunning(client);
      const replay = await loadReplay(client, request.ceoTurnId, request.delegation.tasks.length);
      if (replay) return replay;

      const config = await loadAuthoritativeModelConfig(client, this.env);
      await ensureDailyModelBudget(client, request.budgetScope);
      const budget = await lockBudget(client, request.budgetScope);
      let remaining = budget.remaining;
      const results: DelegatedRun[] = [];

      for (const [index, task] of request.delegation.tasks.entries()) {
        validateAgentPolicy(task);
        const taskId = randomUUID();
        const estimatedCostUsdMicros = conservativeRunEstimate(task);
        const decision = routeModel({
          taskId,
          accountableAgentId: task.agentId,
          riskClass: task.riskClass,
          complexity: task.complexity,
          contextTokens: task.contextTokens,
          urgency: task.urgency,
          remainingBudgetUsdMicros: remaining,
          estimatedCostUsdMicros,
          manualProfile: task.manualProfile,
          manualModel: task.manualModel,
        }, config);
        if (decision.requiresDistinctVerifier && !task.verifierAgentId) throw new Error("DISTINCT_VERIFIER_REQUIRED");
        if (estimatedCostUsdMicros > remaining) throw new Error("MODEL_BUDGET_EXCEEDED");

        const instance = await activeInstance(client, task.agentId);
        await assertRosterEnabled(client, task.agentId, task.verifierAgentId);
        const runId = randomUUID();
        await client.query(
          `INSERT INTO cockpit_tasks
            (id, source_command_id, assigned_agent_id, verifier_agent_id, title, intended_outcome,
             risk_class, status, ceo_turn_id, delegation_index)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [taskId, request.sourceCommandId ?? null, task.agentId, task.verifierAgentId ?? null,
            task.title, task.intendedOutcome, task.riskClass,
            OWNER_GATED_RISKS.has(task.riskClass) ? "action_required" : "queued",
            request.ceoTurnId, index],
        );
        if (OWNER_GATED_RISKS.has(task.riskClass)) {
          await createOwnerApproval(client, taskId, task);
        }
        await client.query(
          `INSERT INTO cockpit_runs
            (id, task_id, agent_instance_id, transport, router_version, model_profile, selected_model,
             reasoning_effort, routing_score, routing_factors, routing_overridden, fallback_reason,
             requires_distinct_verifier, codex_thread_id, estimated_cost_usd_micros)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [runId, taskId, instance.id, instance.transport, decision.routerVersion, decision.profile,
            decision.model, decision.reasoningEffort, decision.score, decision.factors, decision.overridden,
            decision.fallbackReason, decision.requiresDistinctVerifier, instance.threadId,
            estimatedCostUsdMicros],
        );
        const payload = safeOperationalPayloadSchema.parse({
          version: 1, taskId, runId, agentId: task.agentId, threadId: instance.threadId,
          title: task.title, intendedOutcome: task.intendedOutcome, riskClass: task.riskClass,
          model: decision.model, modelProfile: decision.profile, reasoningEffort: decision.reasoningEffort,
          externalSpendUsdMicros: 0,
        });
        await client.query(
          `INSERT INTO cockpit_outbox (run_id, destination, safe_payload) VALUES ($1,$2,$3)`,
          [runId, `codex:${task.agentId}`, payload],
        );
        await client.query(
          `INSERT INTO cockpit_events (event_type, aggregate_type, aggregate_id, safe_payload)
           VALUES ('model.routing.selected','run',$1,$2)`,
          [runId, safeOperationalPayloadSchema.parse({
            routerVersion: decision.routerVersion, profile: decision.profile, model: decision.model,
            reasoningEffort: decision.reasoningEffort, score: decision.score, factors: decision.factors,
            overridden: decision.overridden, verifierAgentId: task.verifierAgentId ?? null,
            budgetScope: request.budgetScope, estimatedCostUsdMicros,
          })],
        );
        remaining -= estimatedCostUsdMicros;
        results.push({ taskId, runId, decision });
      }

      const reserved = budget.remaining - remaining;
      const updated = await client.query(
        `UPDATE cockpit_budgets SET model_usage_reserved_usd_micros = model_usage_reserved_usd_micros + $2,
           version = version + 1, updated_at = now()
         WHERE id = $1
           AND model_usage_reserved_usd_micros + model_usage_actual_usd_micros + $2 <= model_usage_limit_usd_micros
           AND external_spend_reserved_usd_micros = 0 AND external_spend_actual_usd_micros = 0`,
        [budget.id, reserved],
      );
      if (updated.rowCount !== 1) throw new Error("MODEL_BUDGET_RESERVATION_FAILED");
      return results;
    });
  }
}

async function assertCockpitRunning(client: PoolClient): Promise<void> {
  const result = await client.query<{ state: string }>("SELECT state FROM cockpit_pause WHERE id = 1 FOR SHARE");
  if (result.rows[0]?.state !== "running") throw new Error("COCKPIT_PAUSED");
}

async function loadReplay(client: PoolClient, ceoTurnId: string, expectedCount: number): Promise<DelegatedRun[] | null> {
  const result = await client.query<{ task_id: string; run_id: string; router_version: string; model_profile: ModelRoutingDecision["profile"]; selected_model: string; reasoning_effort: ModelRoutingDecision["reasoningEffort"]; routing_score: number; routing_factors: ModelRoutingDecision["factors"]; routing_overridden: boolean; fallback_reason: string | null; requires_distinct_verifier: boolean }>(
    `SELECT t.id AS task_id, r.id AS run_id, r.router_version, r.model_profile, r.selected_model,
            r.reasoning_effort, r.routing_score, r.routing_factors, r.routing_overridden,
            r.fallback_reason, r.requires_distinct_verifier
     FROM cockpit_tasks t JOIN cockpit_runs r ON r.task_id = t.id
     WHERE t.ceo_turn_id = $1 ORDER BY t.delegation_index`, [ceoTurnId],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== expectedCount) throw new Error("DELEGATION_REPLAY_MISMATCH");
  return result.rows.map((row) => ({
    taskId: row.task_id, runId: row.run_id,
    decision: {
      routerVersion: ROUTER_VERSION, taskId: row.task_id, profile: row.model_profile,
      model: row.selected_model, reasoningEffort: row.reasoning_effort, score: row.routing_score,
      factors: row.routing_factors, requiresDistinctVerifier: row.requires_distinct_verifier,
      overridden: row.routing_overridden, fallbackReason: row.fallback_reason,
    },
  }));
}

async function loadAuthoritativeModelConfig(client: PoolClient, env: NodeJS.ProcessEnv): Promise<ModelRouterConfig> {
  const result = await client.query(
    `SELECT profile, model, reasoning_effort AS "reasoningEffort"
     FROM cockpit_model_allowlist WHERE enabled = true ORDER BY profile, priority DESC, model`,
  );
  return buildModelRouterConfig(result.rows, env);
}

export function buildModelRouterConfig(
  rowsRaw: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ModelRouterConfig {
  const rows = z.array(allowlistRowSchema).parse(rowsRaw);
  const profiles = Object.fromEntries(modelProfileSchema.options.map((profile) => {
    const allowed = rows.filter((row) => row.profile === profile);
    const selected = env[`OPS_MODEL_${profile.toUpperCase()}`];
    if (selected && !allowed.some((row) => row.model === selected)) throw new Error("ENV_MODEL_NOT_ALLOWLISTED");
    const choices = allowed.map(({ model, reasoningEffort }) => ({ model, reasoningEffort }));
    return [profile, selected ? choices.filter((row) => row.model === selected) : choices];
  }));
  return modelRouterConfigSchema.parse({ version: ROUTER_VERSION, profiles });
}

async function lockBudget(client: PoolClient, scope: string): Promise<{ id: string; remaining: number }> {
  const result = await client.query<{ id: string; remaining: string; external_spend_limit_usd_micros: string; external_spend_reserved_usd_micros: string; external_spend_actual_usd_micros: string }>(
    `SELECT id,
       (model_usage_limit_usd_micros - model_usage_reserved_usd_micros - model_usage_actual_usd_micros)::text AS remaining,
       external_spend_limit_usd_micros::text, external_spend_reserved_usd_micros::text,
       external_spend_actual_usd_micros::text
     FROM cockpit_budgets WHERE scope = $1 AND period_start <= now() AND period_end > now()
     ORDER BY period_start DESC LIMIT 1 FOR UPDATE`, [scope],
  );
  const row = result.rows[0];
  if (!row) throw new Error("ACTIVE_MODEL_BUDGET_REQUIRED");
  if ([row.external_spend_limit_usd_micros, row.external_spend_reserved_usd_micros, row.external_spend_actual_usd_micros].some((value) => value !== "0")) {
    throw new Error("EXTERNAL_SPEND_MUST_REMAIN_ZERO");
  }
  const remaining = Number(row.remaining);
  if (!Number.isSafeInteger(remaining) || remaining < 0) throw new Error("INVALID_MODEL_BUDGET");
  return { id: row.id, remaining };
}

async function ensureDailyModelBudget(client: PoolClient, scope: "company:model:daily"): Promise<void> {
  await client.query(
    `INSERT INTO cockpit_budgets
      (scope, period_start, period_end, external_spend_limit_usd_micros,
       external_spend_reserved_usd_micros, external_spend_actual_usd_micros,
       model_usage_limit_usd_micros, usage_provenance)
     VALUES ($1,date_trunc('day',now()),date_trunc('day',now()) + interval '1 day',0,0,0,5000000,'estimated')
     ON CONFLICT (scope, period_start, period_end) DO NOTHING`,
    [scope],
  );
}

async function activeInstance(client: PoolClient, agentId: string): Promise<{ id: string; threadId: string; transport: "app_server" | "exec_resume" }> {
  const result = await client.query<{ id: string; thread_id: string; transport: "app_server" | "exec_resume" }>(
    `SELECT id, thread_id, transport FROM cockpit_agent_instances
     WHERE agent_id = $1 AND retired_at IS NULL AND state NOT IN ('offline','paused','problem','uncertain')
       AND length(trim(thread_id)) > 0 FOR SHARE`, [agentId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("ACTIVE_AGENT_INSTANCE_REQUIRED");
  return { id: row.id, threadId: row.thread_id, transport: row.transport };
}

async function assertRosterEnabled(client: PoolClient, agentId: string, verifierAgentId?: string): Promise<void> {
  const ids = verifierAgentId ? [agentId, verifierAgentId] : [agentId];
  const result = await client.query<{ id: string }>("SELECT id FROM cockpit_agents WHERE enabled = true AND id = ANY($1::text[])", [ids]);
  if (result.rows.length !== ids.length) throw new Error("AGENT_NOT_ENABLED");
}

function validateAgentPolicy(task: CeoDelegationTask): void {
  if (!COMPANY_AGENTS[task.agentId].allowedRisks.includes(task.riskClass)) throw new Error("AGENT_RISK_NOT_ALLOWED");
  assertSafeOwnerMessage(task.title);
  assertSafeOwnerMessage(task.intendedOutcome);
}

function conservativeRunEstimate(task: CeoDelegationTask): number {
  const riskMultiplier = OWNER_GATED_RISKS.has(task.riskClass) ? 2 : 1;
  const estimate = (5_000 + task.contextTokens * 10 + task.complexity * 5_000) * riskMultiplier;
  return Math.max(5_000, Math.min(2_000_000, Math.ceil(estimate)));
}

async function createOwnerApproval(client: PoolClient, taskId: string, task: CeoDelegationTask): Promise<void> {
  const action = {
    target: `agent:${task.agentId}`,
    operation: `execute_${task.riskClass}`,
    parameters: { taskId, title: task.title },
    maximumImpact: {
      amountUsdMicros: 0,
      description: `Local ${task.riskClass} work only; external network and spend remain disabled.`,
    },
    policyVersion: 1,
    actionVersion: 1,
  };
  const canonical = JSON.parse(canonicalizeAction(action)) as Record<string, unknown>;
  await client.query(
    `INSERT INTO cockpit_approvals
      (id, task_id, requested_by_agent_id, canonical_action, owner_explanation,
       action_digest, policy_version, action_version, risk_class, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,1,1,$7,now() + interval '24 hours')`,
    [randomUUID(), taskId, task.agentId, canonical, {
      willHappen: `The ${task.agentId} agent may perform the scoped local task: ${task.title}.`,
      willNotHappen: "No external spend, network access, production deployment, advertising launch or third-party contact is authorized.",
      refusalEffect: "The task remains blocked and no specialist turn is started.",
      reversible: "The authorization is single-use and only permits work inside the local project sandbox.",
    }, digestCanonicalAction(action), task.riskClass],
  );
}
