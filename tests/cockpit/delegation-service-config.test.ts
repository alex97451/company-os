import { describe, expect, it } from "vitest";
import { buildModelRouterConfig } from "@/lib/orchestration/delegation-service";

const rows = [
  { profile: "rapid", model: "gpt-5.6-terra", reasoningEffort: "low" },
  { profile: "balanced", model: "gpt-5.6-terra", reasoningEffort: "medium" },
  { profile: "expert", model: "gpt-5.6-sol", reasoningEffort: "high" },
  { profile: "critical", model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
];

describe("delegation model allowlist config", () => {
  it("removes the database profile discriminator from router choices", () => {
    expect(buildModelRouterConfig(rows, {})).toEqual({
      version: "company-os-model-router-v1",
      profiles: {
        rapid: [{ model: "gpt-5.6-terra", reasoningEffort: "low" }],
        balanced: [{ model: "gpt-5.6-terra", reasoningEffort: "medium" }],
        expert: [{ model: "gpt-5.6-sol", reasoningEffort: "high" }],
        critical: [{ model: "gpt-5.6-sol", reasoningEffort: "xhigh" }],
      },
    });
  });

  it("rejects an environment override outside its profile allowlist", () => {
    expect(() => buildModelRouterConfig(rows, { OPS_MODEL_RAPID: "gpt-5.6-sol" }))
      .toThrow("ENV_MODEL_NOT_ALLOWLISTED");
  });
});
