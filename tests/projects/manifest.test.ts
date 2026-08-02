import { describe, expect, it } from "vitest";
import { normalizeProjectId, registerCompanyProjectSchema } from "@/lib/projects/manifest";

describe("company project manifest input", () => {
  it("normalizes a human-readable project identifier", () => {
    expect(normalizeProjectId("  Mon Projet Été_2026  ")).toBe("mon-projet-ete-2026");
  });

  it("accepts a human-readable identifier at the API boundary", () => {
    const input = registerCompanyProjectSchema.parse({
      id: "Mon Projet Été",
      displayName: "Mon Projet Été",
      kind: "saas",
      workspacePath: "C:\\Users\\alexe\\Documents\\Codex\\mon-projet",
    });

    expect(input.id).toBe("mon-projet-ete");
  });
});
