import { describe, expect, it } from "vitest";
import { parseCeoDelegations } from "@/lib/orchestration";
import { findOwnerMessagePolicyViolation } from "@/lib/cockpit/owner-message-policy";

const validTask = {
  agentId: "engineering",
  verifierAgentId: "qa_safety",
  title: "Validate the local cockpit",
  intendedOutcome: "A tested local-only release candidate",
  riskClass: "write_safe",
  complexity: 4,
  contextTokens: 8_000,
  urgency: "normal",
  estimatedCostUsdMicros: 20_000,
};

describe("CEO delegation control channel", () => {
  it("strips one valid final control block from owner-visible text", () => {
    const response = `Je lance la validation locale.\n\n\`\`\`company-delegations\n${JSON.stringify({ version: 1, tasks: [validTask] })}\n\`\`\``;
    const parsed = parseCeoDelegations(response);
    expect(parsed.visibleText).toBe("Je lance la validation locale.");
    expect(parsed.delegation.tasks[0]?.agentId).toBe("engineering");
    expect(parsed.visibleText).not.toContain("company-delegations");
  });

  it.each([
    "Texte ```company-delegations\n{}\n``` puis autre texte",
    "```company-delegations\n{\"version\":1,\"tasks\":[]}\n```",
    "Un\n```company-delegations\n{\"version\":1,\"tasks\":[]}\n```\nDeux\n```company-delegations\n{\"version\":1,\"tasks\":[]}\n```",
  ])("fails closed for a misplaced, empty-visible, or duplicate control block", (response) => {
    expect(() => parseCeoDelegations(response)).toThrow();
  });
});

describe("owner-safe credential policy", () => {
  it.each([
    "ghp_abcdefghijklmnopqrstuvwxyz123456",
    "github_pat_abcdefghijklmnopqrstuvwxyz_123456789",
    "AKIAABCDEFGHIJKLMNOP",
    "eyJabcdefghijk.abcdefghijk.abcdefghijk",
  ])("rejects common credential formats before persistence", (value) => {
    expect(findOwnerMessagePolicyViolation(`credential ${value}`)).toBe("credential");
  });
});
