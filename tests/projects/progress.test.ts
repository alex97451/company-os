import { describe, expect, it } from "vitest";
import { advanceProjectProgress, createValidatedProjectProgress, failProjectProgress } from "@/lib/projects/progress";

describe("project initialization progress", () => {
  it("starts with only the read-only validation steps complete", () => {
    const progress = createValidatedProjectProgress();

    expect(progress.state).toBe("validated");
    expect(progress.steps.map(({ id, status }) => [id, status])).toEqual([
      ["folder_check", "complete"],
      ["workspace_analysis", "complete"],
      ["local_files", "pending"],
      ["database", "pending"],
      ["storage", "pending"],
      ["team", "pending"],
      ["cockpit", "pending"],
    ]);
  });

  it("advances one verified resource at a time and marks the active failure", () => {
    const starting = advanceProjectProgress(
      createValidatedProjectProgress(),
      "workspace_analysis",
      "Dossier analysé.",
      "local_files",
      "Préparation locale.",
    );
    const failed = failProjectProgress(starting, "La préparation locale n’a pas abouti.");

    expect(starting.state).toBe("starting");
    expect(starting.steps.find((step) => step.id === "local_files")).toMatchObject({ status: "active", message: "Préparation locale." });
    expect(failed.state).toBe("error");
    expect(failed.steps.find((step) => step.id === "local_files")).toMatchObject({ status: "error", message: "La préparation locale n’a pas abouti." });
    expect(failed.steps.find((step) => step.id === "database")?.status).toBe("pending");
  });
});
