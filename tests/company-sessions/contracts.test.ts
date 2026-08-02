import { describe, expect, it } from "vitest";
import { createCompanySessionSchema } from "@/lib/company-sessions/contracts";
import { compactContributionBundle } from "@/lib/company-sessions/service";

describe("strategic company session contracts", () => {
  it("starts a global company review without an owner-written mission", () => {
    expect(createCompanySessionSchema.parse({
      mode: "global",
      maxTasks: 5,
      maxDurationMinutes: 90,
    })).toEqual({
      mode: "global",
      maxTasks: 5,
      maxDurationMinutes: 90,
    });
  });

  it("requires a mission for a targeted session", () => {
    expect(createCompanySessionSchema.safeParse({
      mode: "targeted",
      maxTasks: 5,
      maxDurationMinutes: 90,
    }).success).toBe(false);
  });

  it("keeps every invited specialist visible in a bounded CEO briefing", () => {
    const roles = [
      "product", "design_conversion", "engineering", "qa_safety", "growth",
      "content_brand", "sales_partnerships", "customer_care", "finance_risk",
      "reliability_privacy",
    ];
    const bundle = compactContributionBundle(
      roles.map((role) => ({
        author_agent_id: role,
        safe_body: `${role} recommande une priorité mesurable. `.repeat(20),
      })),
      1_400,
    );

    expect(bundle.length).toBeLessThanOrEqual(1_400);
    for (const role of roles) expect(bundle).toContain(`[${role}]`);
  });
});
