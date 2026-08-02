import type { CompanyAgentId } from "./registry";

export type CompanyAgentSchedule = {
  agentId: CompanyAgentId;
  trigger: string;
  cronUtc: string;
  scope: string;
};

export const COMPANY_AGENT_SCHEDULES: readonly CompanyAgentSchedule[] = [
  { agentId: "ceo", trigger: "daily-briefing", cronUtc: "0 7 * * *", scope: "company:daily" },
  { agentId: "product", trigger: "feedback-synthesis", cronUtc: "15 7 * * *", scope: "product:daily" },
  { agentId: "design_conversion", trigger: "conversion-audit", cronUtc: "0 9 * * 1", scope: "design:weekly" },
  { agentId: "engineering", trigger: "engineering-maintenance", cronUtc: "30 8 * * 1-5", scope: "engineering:daily" },
  { agentId: "qa_safety", trigger: "safety-regression", cronUtc: "0 6 * * *", scope: "quality:daily" },
  { agentId: "growth", trigger: "growth-review", cronUtc: "0 10 * * 1", scope: "growth:weekly" },
  { agentId: "content_brand", trigger: "content-plan", cronUtc: "30 10 * * 1", scope: "content:weekly" },
  { agentId: "sales_partnerships", trigger: "partner-pipeline", cronUtc: "0 11 * * 1-5", scope: "sales:daily" },
  { agentId: "customer_care", trigger: "support-triage", cronUtc: "*/10 * * * *", scope: "support:queue" },
  { agentId: "finance_risk", trigger: "margin-reconciliation", cronUtc: "30 6 * * *", scope: "finance:daily" },
  { agentId: "reliability_privacy", trigger: "reliability-scan", cronUtc: "*/15 * * * *", scope: "operations:health" },
] as const;
