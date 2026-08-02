import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_ROUTER_CONFIG, ROUTER_VERSION, routeModel } from "@/lib/cockpit/model-orchestrator";

const taskId = "4e04499a-d66c-4fea-9766-c8eb24bdfbc9";

function input(overrides: Record<string, unknown> = {}) {
  return {
    taskId,
    accountableAgentId: "engineering",
    riskClass: "read",
    complexity: 1,
    contextTokens: 2_000,
    urgency: "normal",
    remainingBudgetUsdMicros: 1_000_000,
    estimatedCostUsdMicros: 10_000,
    ...overrides,
  };
}

describe("deterministic model orchestrator", () => {
  it("routes a small routine task to Rapid with an auditable score", () => {
    expect(routeModel(input())).toEqual({
      routerVersion: ROUTER_VERSION,
      taskId,
      profile: "rapid",
      model: "gpt-5.6-terra",
      reasoningEffort: "low",
      score: 2,
      factors: { risk: 0, complexity: 0, context: 0, urgency: 2, budget: 0 },
      requiresDistinctVerifier: false,
      overridden: false,
      fallbackReason: null,
    });
  });

  it("promotes complex, large-context work to Critical", () => {
    const decision = routeModel(input({ complexity: 5, contextTokens: 100_000, urgency: "high", riskClass: "write_safe" }));
    expect(decision.profile).toBe("critical");
    expect(decision.score).toBe(90);
    expect(decision.requiresDistinctVerifier).toBe(true);
  });

  it("never routes owner-gated risk below Expert", () => {
    const decision = routeModel(input({ riskClass: "financial", remainingBudgetUsdMicros: 0 }));
    expect(decision.profile).toBe("expert");
    expect(decision.requiresDistinctVerifier).toBe(true);
    expect(decision.fallbackReason).toContain("exceeds the remaining budget");
  });

  it("allows an audited profile override only to an allowlisted model", () => {
    const overridden = routeModel(input({ manualProfile: "expert", manualModel: "gpt-5.6-sol" }));
    expect(overridden).toMatchObject({ profile: "expert", model: "gpt-5.6-sol", overridden: true });
    expect(() => routeModel(input({ manualProfile: "rapid", manualModel: "gpt-5.6-sol" })))
      .toThrow("MODEL_NOT_ALLOWLISTED_FOR_PROFILE");
  });

  it("does not let a manual override bypass the high-risk floor", () => {
    expect(() => routeModel(input({ riskClass: "production", manualProfile: "rapid" })))
      .toThrow("PROFILE_BELOW_RISK_FLOOR");
  });

  it("accepts a configurable allowlist without changing router rules", () => {
    const config = structuredClone(DEFAULT_MODEL_ROUTER_CONFIG);
    config.profiles.rapid = [{ model: "local-demo-model", reasoningEffort: "low" }];
    expect(routeModel(input(), config).model).toBe("local-demo-model");
  });

  it("rejects untrusted boundary fields and invalid sizes", () => {
    expect(() => routeModel(input({ contextTokens: -1 }))).toThrow();
    expect(() => routeModel({ ...input(), hiddenPrompt: "must not persist" })).toThrow();
  });
});
