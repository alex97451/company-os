import { describe, expect, it } from "vitest";
import { agentStatusForOwner, runStatusForOwner, taskStatusForOwner } from "@/lib/cockpit/domain";

describe("owner-facing cockpit state", () => {
  it("keeps uncertainty visible as a problem instead of pretending work stopped", () => {
    expect(agentStatusForOwner("uncertain")).toBe("problem");
    expect(runStatusForOwner("reconciliation_required")).toBe("problem");
    expect(runStatusForOwner("orphaned")).toBe("problem");
  });

  it("maps technical workflow states to the five owner states", () => {
    expect(taskStatusForOwner("verification")).toBe("working");
    expect(taskStatusForOwner("action_required")).toBe("action_required");
    expect(runStatusForOwner("completed")).toBe("done");
    expect(agentStatusForOwner("paused")).toBe("waiting");
  });
});
