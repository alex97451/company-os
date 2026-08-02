import { describe, expect, it } from "vitest";
import { parseSpecialistResult } from "@/lib/codex/postgres-agent-run-outbox";

describe("specialist result contract", () => {
  it("accepts an evidenced completed deliverable", () => {
    expect(parseSpecialistResult(JSON.stringify({
      status: "completed",
      summary: "The duplicate activity identities are fixed and covered by regression tests.",
      evidence: ["tests/cockpit/activity-events.test.ts passed"],
    }))).toMatchObject({ status: "completed" });
  });

  it("keeps a sandbox failure blocked instead of completed", () => {
    expect(parseSpecialistResult(JSON.stringify({
      status: "blocked",
      summary: "Windows denied repository writes; no file was modified.",
      evidence: ["apply_patch returned access denied"],
    }))).toMatchObject({ status: "blocked" });
  });

  it("rejects an unstructured conclusion that cannot prove its outcome", () => {
    expect(() => parseSpecialistResult("No file was modified because access was denied."))
      .toThrow();
  });
});
