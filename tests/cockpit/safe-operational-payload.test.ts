import { describe, expect, it } from "vitest";
import { safeOperationalPayloadSchema } from "@/lib/cockpit/domain";

describe("safe operational payload", () => {
  it("preserves the existing operational payload vocabulary", () => {
    const payload = {
      version: 1,
      taskId: "task-1",
      contextTokens: 8_000,
      maxOutputTokens: 4_000,
      factors: { risk: 0, context: 1 },
      safePayload: { message: "Prepare a local-only brief." },
    };

    expect(safeOperationalPayloadSchema.parse(payload)).toEqual(payload);
  });

  it.each([
    [{ rawQuote: "customer text" }, ["rawQuote"]],
    [{ envelope: { original_upload: "object-key" } }, ["envelope", "original_upload"]],
    [{ items: [{ customerEmail: "customer@example.com" }] }, ["items", 0, "customerEmail"]],
    [{ integration: { webhookSecret: "value" } }, ["integration", "webhookSecret"]],
    [{ sessionToken: "value" }, ["sessionToken"]],
    [{ auth: { password: "value" } }, ["auth", "password"]],
    [{ credentials: { account: "value" } }, ["credentials"]],
  ])("rejects sensitive keys recursively", (payload, expectedPath) => {
    const result = safeOperationalPayloadSchema.safeParse(payload);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: expectedPath }),
      ]));
    }
  });
});
