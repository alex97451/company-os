import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  COMPANY_AGENTS,
  type CompanyAgentDefinition,
  type CompanyAgentId,
  type RiskClass,
} from "./registry";

const OWNER_GATED_RISKS = new Set<RiskClass>(["financial", "advertising", "production"]);

export type CircuitBreakerState = {
  state: "closed" | "open";
  reason?: string;
};

export type AgentApproval = {
  id: string;
  agentId: CompanyAgentId;
  actionDigest: string;
  riskClass: RiskClass;
  policyVersion: number;
  expiresAt: Date;
  usedAt: Date | null;
};

export type AgentUsage = {
  runCalls: number;
  dayCalls: number;
  dayCostUsdMicros: number;
};

export type AgentActionRequest = {
  agentId: CompanyAgentId;
  runId: string;
  tool: string;
  scope: string;
  riskClass: RiskClass;
  policyVersion: number;
  actionDigest: string;
  estimatedCostUsdMicros: number;
  callCount?: number;
  approval?: AgentApproval | null;
};

export type AgentPolicyDecision = {
  allowed: boolean;
  code:
    | "ALLOW"
    | "DENY_UNKNOWN_AGENT"
    | "DENY_CIRCUIT_OPEN"
    | "DENY_SCOPE"
    | "DENY_TOOL"
    | "DENY_RISK"
    | "DENY_APPROVAL_REQUIRED"
    | "DENY_APPROVAL_INVALID"
    | "DENY_APPROVAL_REPLAY"
    | "DENY_RUN_BUDGET"
    | "DENY_DAY_BUDGET"
    | "DENY_COST_BUDGET"
    | "DENY_INVALID_REQUEST";
  reason: string;
  requiresApproval: boolean;
};

export type EvaluateAgentActionContext = {
  agent?: CompanyAgentDefinition | null;
  usage?: AgentUsage;
  circuitBreaker?: CircuitBreakerState;
  forbiddenScopeMarkers?: readonly string[];
  now?: Date;
};

export function digestAgentAction(action: Omit<AgentActionRequest, "actionDigest" | "approval">): string {
  const serialized = JSON.stringify(Object.fromEntries(Object.entries(action).sort(([a], [b]) => a.localeCompare(b))));
  return createHash("sha256").update(serialized).digest("hex");
}

function deny(code: AgentPolicyDecision["code"], reason: string, requiresApproval = false): AgentPolicyDecision {
  return { allowed: false, code, reason, requiresApproval };
}

function scopeAllowed(scope: string, allowed: readonly string[]): boolean {
  return allowed.some((candidate) => scope === candidate || scope.startsWith(`${candidate}:`));
}

export function evaluateAgentAction(
  request: AgentActionRequest,
  context: EvaluateAgentActionContext = {},
): AgentPolicyDecision {
  const agent = context.agent === undefined ? COMPANY_AGENTS[request.agentId] : context.agent;
  const usage = context.usage ?? { runCalls: 0, dayCalls: 0, dayCostUsdMicros: 0 };
  const circuit = context.circuitBreaker ?? { state: "closed" };
  const now = context.now ?? new Date();
  const callCount = request.callCount ?? 1;
  if (!agent) return deny("DENY_UNKNOWN_AGENT", "No active policy exists for this agent.");
  if (!Number.isInteger(callCount) || callCount < 1 || !Number.isSafeInteger(request.estimatedCostUsdMicros) || request.estimatedCostUsdMicros < 0) {
    return deny("DENY_INVALID_REQUEST", "Call count and estimated cost must be non-negative bounded integers.");
  }
  if (circuit.state === "open") return deny("DENY_CIRCUIT_OPEN", circuit.reason ?? "The global circuit breaker is open.");
  const forbiddenScopeMarkers = context.forbiddenScopeMarkers ?? configuredForbiddenScopeMarkers();
  if (forbiddenScopeMarkers.some((marker) => request.scope.toLowerCase().includes(marker.toLowerCase()))) {
    return deny("DENY_SCOPE", "The requested scope is permanently forbidden.");
  }
  if (!scopeAllowed(request.scope, agent.allowedScopes)) return deny("DENY_SCOPE", "The requested scope is outside the agent allowlist.");
  if (!agent.allowedTools.includes(request.tool)) return deny("DENY_TOOL", "The requested tool is outside the agent allowlist.");
  if (!agent.allowedRisks.includes(request.riskClass)) return deny("DENY_RISK", "The risk class is outside the agent allowlist.");
  if (usage.runCalls + callCount > agent.maxCallsPerRun) return deny("DENY_RUN_BUDGET", "The per-run call ceiling would be exceeded.");
  if (usage.dayCalls + callCount > agent.maxCallsPerDay) return deny("DENY_DAY_BUDGET", "The daily call ceiling would be exceeded.");
  if (usage.dayCostUsdMicros + request.estimatedCostUsdMicros > agent.maxCostUsdMicrosPerDay) {
    return deny("DENY_COST_BUDGET", "The daily cost ceiling would be exceeded.");
  }
  if (OWNER_GATED_RISKS.has(request.riskClass)) {
    if (!request.approval) return deny("DENY_APPROVAL_REQUIRED", "A single-use owner approval is required.", true);
    if (request.approval.usedAt) return deny("DENY_APPROVAL_REPLAY", "The owner approval has already been used.", true);
    if (
      request.approval.agentId !== request.agentId
      || request.approval.actionDigest !== request.actionDigest
      || request.approval.riskClass !== request.riskClass
      || request.approval.policyVersion !== request.policyVersion
      || request.approval.expiresAt.getTime() <= now.getTime()
    ) {
      return deny("DENY_APPROVAL_INVALID", "The owner approval does not bind this exact action or has expired.", true);
    }
  }
  return { allowed: true, code: "ALLOW", reason: "Policy checks passed; reserve budget atomically before execution.", requiresApproval: false };
}

function configuredForbiddenScopeMarkers(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.COMPANY_PROJECTS_FORBIDDEN_ROOTS ?? "")
    .split(";")
    .map((marker) => marker.trim())
    .filter(Boolean);
}

export type PolicyReservation = { reservationId: string; approvalId: string | null };

export class PostgresAgentPolicyGateway {
  constructor(private readonly pool: Pool) {}

  async authorizeAndReserve(request: AgentActionRequest): Promise<AgentPolicyDecision & Partial<PolicyReservation>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.loadAndEvaluate(client, request);
      if (!result.allowed) {
        await client.query("ROLLBACK");
        return result;
      }
      const reservation = await client.query<{ id: string }>(
        `INSERT INTO agent_action_reservations
          (run_id, agent_id, tool, scope, risk_class, action_digest, policy_version, estimated_cost_usd_micros, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'reserved') RETURNING id`,
        [request.runId, request.agentId, request.tool, request.scope, request.riskClass, request.actionDigest, request.policyVersion, request.estimatedCostUsdMicros],
      );
      if (request.approval) {
        const consumed = await client.query(
          "UPDATE agent_approvals SET used_at = now() WHERE id = $1 AND used_at IS NULL AND expires_at > now()",
          [request.approval.id],
        );
        if (consumed.rowCount !== 1) throw new Error("APPROVAL_CONCURRENT_REPLAY");
      }
      await client.query(
        `INSERT INTO agent_daily_usage (usage_date, agent_id, calls, reserved_cost_usd_micros)
         VALUES (CURRENT_DATE,$1,$2,$3)
         ON CONFLICT (usage_date, agent_id) DO UPDATE SET
           calls = agent_daily_usage.calls + EXCLUDED.calls,
           reserved_cost_usd_micros = agent_daily_usage.reserved_cost_usd_micros + EXCLUDED.reserved_cost_usd_micros`,
        [request.agentId, request.callCount ?? 1, request.estimatedCostUsdMicros],
      );
      await client.query("UPDATE agent_runs SET calls = calls + $2 WHERE id = $1", [request.runId, request.callCount ?? 1]);
      await client.query("COMMIT");
      return { ...result, reservationId: reservation.rows[0]?.id, approvalId: request.approval?.id ?? null };
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof Error && error.message === "APPROVAL_CONCURRENT_REPLAY") {
        return deny("DENY_APPROVAL_REPLAY", "The approval was consumed concurrently.", true);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async recordOutcome(reservationId: string, status: "succeeded" | "failed", actualCostUsdMicros: number): Promise<void> {
    if (!Number.isSafeInteger(actualCostUsdMicros) || actualCostUsdMicros < 0) throw new Error("INVALID_ACTUAL_COST");
    await this.pool.query(
      `WITH completed AS (
         UPDATE agent_action_reservations
         SET status = $2, actual_cost_usd_micros = $3, completed_at = now()
         WHERE id = $1 AND status = 'reserved'
         RETURNING agent_id, reserved_at
       )
       UPDATE agent_daily_usage usage
       SET actual_cost_usd_micros = usage.actual_cost_usd_micros + $3
       FROM completed
       WHERE usage.agent_id = completed.agent_id
         AND usage.usage_date = (completed.reserved_at AT TIME ZONE 'UTC')::date`,
      [reservationId, status, actualCostUsdMicros],
    );
  }

  private async loadAndEvaluate(client: PoolClient, request: AgentActionRequest): Promise<AgentPolicyDecision> {
    await client.query(
      "INSERT INTO agent_daily_usage (usage_date, agent_id) VALUES (CURRENT_DATE,$1) ON CONFLICT DO NOTHING",
      [request.agentId],
    );
    const [policyResult, breakerResult, runResult, usageResult, approvalResult] = await Promise.all([
      client.query<{
        enabled: boolean;
        allowed_tools: string[];
        allowed_scopes: string[];
        allowed_risks: RiskClass[];
        max_calls_per_run: number;
        max_calls_per_day: number;
        max_cost_usd_micros_per_day: string;
      }>(`SELECT enabled, allowed_tools, allowed_scopes, allowed_risks,
            max_calls_per_run, max_calls_per_day, max_cost_usd_micros_per_day
          FROM agent_policies WHERE agent_id = $1 AND policy_version = $2 FOR UPDATE`, [request.agentId, request.policyVersion]),
      client.query<{ state: "closed" | "open"; reason: string | null }>("SELECT state, reason FROM agent_circuit_breaker WHERE id = 1 FOR UPDATE"),
      client.query<{ calls: number }>("SELECT calls FROM agent_runs WHERE id = $1 AND agent_id = $2 FOR UPDATE", [request.runId, request.agentId]),
      client.query<{ calls: number; reserved_cost_usd_micros: string }>(
        "SELECT calls, reserved_cost_usd_micros FROM agent_daily_usage WHERE usage_date = CURRENT_DATE AND agent_id = $1 FOR UPDATE",
        [request.agentId],
      ),
      request.approval
        ? client.query<AgentApproval>(
          `SELECT id, agent_id AS "agentId", action_digest AS "actionDigest", risk_class AS "riskClass",
                  policy_version AS "policyVersion", expires_at AS "expiresAt", used_at AS "usedAt"
           FROM agent_approvals WHERE id = $1 FOR UPDATE`,
          [request.approval.id],
        )
        : Promise.resolve({ rows: [] as AgentApproval[] }),
    ]);
    if (runResult.rows.length === 0) return deny("DENY_INVALID_REQUEST", "The agent run does not exist or belongs to another agent.");
    const storedPolicy = policyResult.rows[0];
    const staticAgent = COMPANY_AGENTS[request.agentId];
    const agent = storedPolicy?.enabled && staticAgent ? {
      ...staticAgent,
      allowedTools: storedPolicy.allowed_tools,
      allowedScopes: storedPolicy.allowed_scopes,
      allowedRisks: storedPolicy.allowed_risks,
      maxCallsPerRun: storedPolicy.max_calls_per_run,
      maxCallsPerDay: storedPolicy.max_calls_per_day,
      maxCostUsdMicrosPerDay: Number(storedPolicy.max_cost_usd_micros_per_day),
    } : null;
    const approval = approvalResult.rows[0] ?? null;
    return evaluateAgentAction({ ...request, approval }, {
      agent,
      circuitBreaker: breakerResult.rows[0]
        ? { state: breakerResult.rows[0].state, reason: breakerResult.rows[0].reason ?? undefined }
        : { state: "open", reason: "Circuit-breaker configuration is missing." },
      usage: {
        runCalls: runResult.rows[0]?.calls ?? 0,
        dayCalls: usageResult.rows[0]?.calls ?? 0,
        dayCostUsdMicros: Number(usageResult.rows[0]?.reserved_cost_usd_micros ?? 0),
      },
    });
  }
}
