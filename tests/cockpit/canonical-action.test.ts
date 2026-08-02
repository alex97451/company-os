import { describe, expect, it } from "vitest";
import { canonicalizeAction, digestCanonicalAction } from "@/lib/cockpit/canonical-action";

const action = {
  target: "ads:uk:campaign-draft",
  operation: "publish",
  parameters: {
    audience: { country: "GB", age: [25, 34] },
    creativeIds: ["creative-2", "creative-1"],
  },
  maximumImpact: { amountUsdMicros: 0, affectedRecords: 1, description: "Publishes one draft with no spend." },
  policyVersion: 2,
  actionVersion: 1,
};

describe("canonical owner approvals", () => {
  it("produces the same SHA-256 digest regardless of object key order", () => {
    const reordered = {
      actionVersion: 1,
      policyVersion: 2,
      maximumImpact: { description: "Publishes one draft with no spend.", affectedRecords: 1, amountUsdMicros: 0 },
      parameters: { creativeIds: ["creative-2", "creative-1"], audience: { age: [25, 34], country: "GB" } },
      operation: "publish",
      target: "ads:uk:campaign-draft",
    };
    expect(digestCanonicalAction(reordered)).toBe(digestCanonicalAction(action));
    expect(digestCanonicalAction(action)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("binds parameters, array order and maximum impact", () => {
    expect(digestCanonicalAction({ ...action, operation: "archive" })).not.toBe(digestCanonicalAction(action));
    expect(digestCanonicalAction({ ...action, parameters: { ...action.parameters, creativeIds: ["creative-1", "creative-2"] } }))
      .not.toBe(digestCanonicalAction(action));
    expect(digestCanonicalAction({ ...action, maximumImpact: { ...action.maximumImpact, amountUsdMicros: 1 } }))
      .not.toBe(digestCanonicalAction(action));
  });

  it("canonicalizes nested keys and rejects undeclared executable fields", () => {
    expect(canonicalizeAction(action)).toContain('"audience":{"age":[25,34],"country":"GB"}');
    expect(() => canonicalizeAction({ ...action, shellCommand: "not approved" })).toThrow();
  });
});
