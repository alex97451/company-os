import { z } from "zod";
import { modelProfileSchema, reasoningEffortSchema, routerInputSchema, type ModelProfile, type RouterInput } from "./domain";

export const ROUTER_VERSION = "company-os-model-router-v1" as const;

const modelChoiceSchema = z.object({
  model: z.string().trim().min(1).max(100),
  reasoningEffort: reasoningEffortSchema,
}).strict();

export const modelRouterConfigSchema = z.object({
  version: z.literal(ROUTER_VERSION),
  profiles: z.record(modelProfileSchema, z.array(modelChoiceSchema).min(1).max(10)),
}).strict();

export type ModelRouterConfig = z.infer<typeof modelRouterConfigSchema>;

export const DEFAULT_MODEL_ROUTER_CONFIG: ModelRouterConfig = {
  version: ROUTER_VERSION,
  profiles: {
    rapid: [{ model: "gpt-5.6-terra", reasoningEffort: "low" }],
    balanced: [{ model: "gpt-5.6-terra", reasoningEffort: "medium" }],
    expert: [{ model: "gpt-5.6-sol", reasoningEffort: "high" }],
    critical: [{ model: "gpt-5.6-sol", reasoningEffort: "xhigh" }],
  },
};

const RISK_SCORE = { read: 0, draft: 8, write_safe: 16, financial: 34, advertising: 34, production: 40 } as const;
const URGENCY_SCORE = { low: 0, normal: 2, high: 4, immediate: 6 } as const;
const PROFILE_ORDER: readonly ModelProfile[] = ["rapid", "balanced", "expert", "critical"];

export type RoutingFactorScores = {
  risk: number;
  complexity: number;
  context: number;
  urgency: number;
  budget: number;
};

export type ModelRoutingDecision = {
  routerVersion: typeof ROUTER_VERSION;
  taskId: string;
  profile: ModelProfile;
  model: string;
  reasoningEffort: z.infer<typeof reasoningEffortSchema>;
  score: number;
  factors: RoutingFactorScores;
  requiresDistinctVerifier: boolean;
  overridden: boolean;
  fallbackReason: string | null;
};

function contextScore(tokens: number): number {
  if (tokens <= 8_000) return 0;
  if (tokens <= 32_000) return 10;
  if (tokens <= 96_000) return 20;
  return 30;
}

function budgetScore(input: RouterInput): number {
  if (input.estimatedCostUsdMicros === 0) return 0;
  if (input.remainingBudgetUsdMicros < input.estimatedCostUsdMicros) return -16;
  const ratio = input.remainingBudgetUsdMicros / input.estimatedCostUsdMicros;
  if (ratio < 2) return -12;
  if (ratio < 5) return -6;
  return 0;
}

function automaticProfile(score: number, riskClass: RouterInput["riskClass"]): ModelProfile {
  let profile: ModelProfile = score >= 80 ? "critical" : score >= 55 ? "expert" : score >= 25 ? "balanced" : "rapid";
  if (["financial", "advertising", "production"].includes(riskClass) && PROFILE_ORDER.indexOf(profile) < PROFILE_ORDER.indexOf("expert")) {
    profile = "expert";
  }
  return profile;
}

export function routeModel(rawInput: unknown, rawConfig: unknown = DEFAULT_MODEL_ROUTER_CONFIG): ModelRoutingDecision {
  const input = routerInputSchema.parse(rawInput);
  const config = modelRouterConfigSchema.parse(rawConfig);
  const factors: RoutingFactorScores = {
    risk: RISK_SCORE[input.riskClass],
    complexity: (input.complexity - 1) * 10,
    context: contextScore(input.contextTokens),
    urgency: URGENCY_SCORE[input.urgency],
    budget: budgetScore(input),
  };
  const score = Object.values(factors).reduce((total, factor) => total + factor, 0);
  const computedProfile = automaticProfile(score, input.riskClass);
  const profile = input.manualProfile ?? computedProfile;
  if (
    ["financial", "advertising", "production"].includes(input.riskClass)
    && PROFILE_ORDER.indexOf(profile) < PROFILE_ORDER.indexOf("expert")
  ) {
    throw new Error("PROFILE_BELOW_RISK_FLOOR");
  }
  const choices = config.profiles[profile];
  const chosen = input.manualModel
    ? choices.find((candidate) => candidate.model === input.manualModel)
    : choices[0];
  if (!chosen) throw new Error("MODEL_NOT_ALLOWLISTED_FOR_PROFILE");

  return {
    routerVersion: config.version,
    taskId: input.taskId,
    profile,
    model: chosen.model,
    reasoningEffort: chosen.reasoningEffort,
    score,
    factors,
    requiresDistinctVerifier: profile === "critical" || ["financial", "advertising", "production"].includes(input.riskClass),
    overridden: input.manualProfile !== undefined || input.manualModel !== undefined,
    fallbackReason: input.remainingBudgetUsdMicros < input.estimatedCostUsdMicros
      ? "Estimated model usage exceeds the remaining budget; the policy gateway must reserve or reject execution."
      : null,
  };
}
