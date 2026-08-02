import { z } from "zod";

export const companyAgentIdSchema = z.enum([
  "ceo",
  "product",
  "design_conversion",
  "engineering",
  "qa_safety",
  "growth",
  "content_brand",
  "sales_partnerships",
  "customer_care",
  "finance_risk",
  "reliability_privacy",
]);

export const autonomyLevelSchema = z.enum(["observe", "draft", "stage", "operate", "restricted"]);
export const riskClassSchema = z.enum(["read", "draft", "write_safe", "financial", "advertising", "production"]);

export type CompanyAgentId = z.infer<typeof companyAgentIdSchema>;
export type AutonomyLevel = z.infer<typeof autonomyLevelSchema>;
export type RiskClass = z.infer<typeof riskClassSchema>;

export type CompanyAgentDefinition = {
  id: CompanyAgentId;
  name: string;
  mission: string;
  level: AutonomyLevel;
  allowedTools: readonly string[];
  allowedScopes: readonly string[];
  allowedRisks: readonly RiskClass[];
  maxCallsPerRun: number;
  maxCallsPerDay: number;
  maxCostUsdMicrosPerDay: number;
};

const aggregateReadScopes = ["analytics:aggregate", "tasks:scoped", "memory:redacted"] as const;

export const COMPANY_AGENTS: Readonly<Record<CompanyAgentId, CompanyAgentDefinition>> = {
  ceo: agent("ceo", "CEO / General Manager", "Prioritize sustainable revenue, trust and solvency.", "draft", ["kpi.read", "task.create", "briefing.write"], aggregateReadScopes, ["read", "draft"], 10, 20, 500_000),
  product: agent("product", "Product Manager", "Turn funnel and support evidence into a focused roadmap.", "draft", ["analytics.read", "support.trends.read", "backlog.write"], ["analytics:aggregate", "support:aggregate", "tasks:product"], ["read", "draft"], 10, 20, 500_000),
  design_conversion: agent("design_conversion", "Design & Conversion", "Improve clarity, accessibility, trust and conversion.", "stage", ["ui.read", "analytics.read", "artifact.write", "staging.preview"], ["repo:project:ui", "analytics:aggregate", "artifacts:design", "staging:web"], ["read", "draft", "write_safe"], 10, 20, 750_000),
  engineering: agent("engineering", "CTO / Engineering", "Build a secure, tested and reversible product.", "stage", ["repo.read", "repo.branch.write", "tests.run", "staging.deploy"], ["repo:project", "staging:web", "staging:worker"], ["read", "draft", "write_safe", "production"], 20, 40, 2_000_000),
  qa_safety: agent("qa_safety", "QA & Safety", "Block regressions and unsupported claims.", "stage", ["repo.diff.read", "tests.run", "staging.read", "verdict.write"], ["repo:project", "staging:web", "fixtures:redacted", "artifacts:verdict"], ["read", "draft", "write_safe"], 20, 30, 500_000),
  growth: agent("growth", "Growth & Marketing", "Prepare measurable UK-first acquisition work.", "draft", ["analytics.read", "research.public", "creative.write", "experiment.write", "ads.manage"], ["analytics:aggregate", "research:public", "artifacts:growth", "ads:bounded"], ["read", "draft", "advertising"], 10, 20, 1_000_000),
  content_brand: agent("content_brand", "Content & Brand", "Maintain accurate, useful EN/FR education and lifecycle copy.", "draft", ["product_facts.read", "content.write", "localization.check"], ["facts:approved", "artifacts:content", "locales:en-fr"], ["read", "draft"], 10, 20, 750_000),
  sales_partnerships: agent("sales_partnerships", "Sales & Partnerships", "Develop ethical partner opportunities without spam.", "draft", ["research.public", "outreach.draft", "crm.note.write", "outreach.send"], ["research:public", "artifacts:sales", "crm:prospects", "outreach:bounded"], ["read", "draft", "write_safe"], 10, 20, 500_000),
  customer_care: agent("customer_care", "Customer Care", "Resolve routine issues consistently and surface product themes.", "operate", ["case.read", "faq.read", "reply.template.send", "recovery.create", "refund.issue"], ["support:assigned", "faq:approved", "recovery:bounded", "payments:bounded"], ["read", "draft", "write_safe", "financial"], 10, 20, 500_000),
  finance_risk: agent("finance_risk", "Finance & Revenue Risk", "Protect margin, pricing integrity and acquisition ceilings.", "observe", ["payments.aggregate.read", "costs.read", "analytics.read", "alert.write", "payment.move"], ["payments:aggregate", "costs:aggregate", "analytics:aggregate", "artifacts:finance", "payments:bounded"], ["read", "draft", "financial"], 10, 20, 250_000),
  reliability_privacy: agent("reliability_privacy", "Reliability, Security & Privacy", "Meet availability, recovery and deletion promises.", "operate", ["telemetry.read", "job.retry", "purge.run", "incident.write", "production.change"], ["telemetry:aggregate", "jobs:failed", "storage:expired", "artifacts:incident", "production:bounded"], ["read", "draft", "write_safe", "production"], 10, 20, 250_000),
};

function agent(
  id: CompanyAgentId,
  name: string,
  mission: string,
  level: AutonomyLevel,
  allowedTools: readonly string[],
  allowedScopes: readonly string[],
  allowedRisks: readonly RiskClass[],
  maxCallsPerRun: number,
  maxCallsPerDay: number,
  maxCostUsdMicrosPerDay: number,
): CompanyAgentDefinition {
  return { id, name, mission, level, allowedTools, allowedScopes, allowedRisks, maxCallsPerRun, maxCallsPerDay, maxCostUsdMicrosPerDay };
}

export function getCompanyAgent(id: CompanyAgentId): CompanyAgentDefinition {
  return COMPANY_AGENTS[id];
}
