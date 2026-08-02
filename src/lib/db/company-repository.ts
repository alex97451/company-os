import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { CompanyAgentId, RiskClass } from "../agents";

export class CompanyRepository {
  constructor(private readonly pool: Pool) {}

  async startScheduledRun(input: {
    agentId: CompanyAgentId;
    trigger: string;
    scope: string;
    policyVersion: number;
    leaseMinutes?: number;
  }): Promise<string | null> {
    await this.pool.query(
      `UPDATE agent_runs SET state = 'failed', completed_at = now()
       WHERE state = 'active' AND lease_expires_at <= now()`,
    );
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO agent_runs (id, agent_id, trigger, scope, policy_version, lease_owner, lease_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,now() + make_interval(mins => $7))
       ON CONFLICT (agent_id, trigger, scope, policy_version) WHERE state = 'active' DO NOTHING
       RETURNING id`,
      [randomUUID(), input.agentId, input.trigger, input.scope, input.policyVersion, `worker:${process.pid}`, input.leaseMinutes ?? 10],
    );
    return result.rows[0]?.id ?? null;
  }

  async createTask(input: {
    ownerAgent: CompanyAgentId;
    verifierAgent?: CompanyAgentId;
    trigger: string;
    scope: string;
    outcomeMetric: string;
    riskClass: RiskClass;
    policyVersion: number;
    dedupeWindowMinutes?: number;
  }): Promise<string | null> {
    const windowMinutes = Math.min(Math.max(input.dedupeWindowMinutes ?? 1_440, 1), 10_080);
    const window = Math.floor(Date.now() / (windowMinutes * 60_000));
    const dedupeKey = createHash("sha256")
      .update(`${input.ownerAgent}:${input.trigger}:${input.scope}:${input.outcomeMetric}:${window}`)
      .digest("hex");
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO company_tasks
        (owner_agent, verifier_agent, trigger, scope, outcome_metric, risk_class, policy_version, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT DO NOTHING RETURNING id`,
      [input.ownerAgent, input.verifierAgent ?? null, input.trigger, input.scope, input.outcomeMetric, input.riskClass, input.policyVersion, dedupeKey],
    );
    return result.rows[0]?.id ?? null;
  }

  async finishRun(runId: string, state: "completed" | "failed" | "blocked"): Promise<void> {
    await this.pool.query(
      "UPDATE agent_runs SET state = $2, completed_at = now() WHERE id = $1 AND state = 'active'",
      [runId, state],
    );
  }
}
