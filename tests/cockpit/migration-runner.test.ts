import { describe, expect, it } from "vitest";

// The migration runner remains plain ESM so `node` can execute it without a
// TypeScript runtime during database setup.
// @ts-expect-error The operational .mjs module intentionally has no declaration file.
import { classifyBaseline, unwrapTransaction } from "../../scripts/apply-cockpit-migration.mjs";

describe("cockpit migration runner", () => {
  it("classifies only fully verified schemas as complete", () => {
    expect(classifyBaseline([true, true, true])).toBe("complete");
    expect(classifyBaseline([false, false, false])).toBe("absent");
    expect(classifyBaseline([true, false, true])).toBe("partial");
  });

  it("rejects empty or malformed baseline evidence", () => {
    expect(() => classifyBaseline([])).toThrow("non-empty boolean array");
    expect(() => classifyBaseline([true, "yes"])).toThrow("non-empty boolean array");
  });

  it("moves the SQL transaction boundary into the runner", () => {
    expect(unwrapTransaction("BEGIN;\nSELECT 1;\nCOMMIT;\n", "test.sql")).toBe("SELECT 1;");
    expect(() => unwrapTransaction("SELECT 1;", "test.sql")).toThrow("exactly one outer");
    expect(() =>
      unwrapTransaction("BEGIN;\nBEGIN;\nSELECT 1;\nCOMMIT;\nCOMMIT;", "test.sql"),
    ).toThrow("nested transaction control");
  });
});
