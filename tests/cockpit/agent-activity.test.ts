import { describe, expect, it } from "vitest";
import {
  buildAgentActivities,
  phaseForActivity,
  type ActivityEventSource,
  type AgentActivitySource,
} from "@/lib/cockpit/agent-activity";

const now = new Date("2026-07-29T20:00:00.000Z");
const engineering: AgentActivitySource = {
  agentId: "engineering",
  agentStatus: "working",
  taskId: "11111111-1111-4111-8111-111111111111",
  taskTitle: "Améliorer le cockpit",
  intendedOutcome: "Afficher une activité opérationnelle sûre.",
  taskStatus: "working",
  runId: "22222222-2222-4222-8222-222222222222",
  runState: "working",
  modelProfile: "expert",
  startedAt: new Date("2026-07-29T19:58:00.000Z"),
  lastSignalAt: new Date("2026-07-29T19:59:00.000Z"),
};

function runEvent(overrides: Partial<ActivityEventSource> = {}): ActivityEventSource {
  return {
    sequence: "12",
    id: "33333333-3333-4333-8333-333333333333",
    eventType: "agent.run.started",
    aggregateType: "run",
    aggregateId: engineering.runId!,
    safePayload: { transport: "app_server" },
    occurredAt: now,
    ...overrides,
  };
}

describe("agent activity projection", () => {
  it("correlates run events with their authoritative agent and updates the latest signal", () => {
    const product: AgentActivitySource = {
      ...engineering,
      agentId: "product",
      runId: "44444444-4444-4444-8444-444444444444",
    };

    const activities = buildAgentActivities([engineering, product], [runEvent()]);

    expect(activities.find((activity) => activity.agentId === "engineering")?.events).toHaveLength(1);
    expect(activities.find((activity) => activity.agentId === "engineering")?.lastSignalAt).toEqual(now);
    expect(activities.find((activity) => activity.agentId === "product")?.events).toHaveLength(0);
  });

  it("does not copy arbitrary operational payload fields into the owner projection", () => {
    const activity = buildAgentActivities([engineering], [runEvent({
      safePayload: {
        transport: "app_server",
        threadId: "must-not-reach-the-client",
        internalDiagnostic: "must-not-reach-the-client",
      },
    })])[0];

    expect(JSON.stringify(activity)).not.toContain("must-not-reach-the-client");
    expect(activity?.events[0]).toEqual(expect.objectContaining({
      eventType: "agent.run.started",
      detail: null,
    }));
  });

  it("allows only the policy-checked completion summary as event detail", () => {
    const activity = buildAgentActivities([engineering], [runEvent({
      eventType: "agent.run.completed",
      safePayload: { summary: "Tests locaux terminés.", demo: false },
    })])[0];

    expect(activity?.events[0]?.detail).toBe("Tests locaux terminés.");
  });

  it("shows a corrected historical conclusion as the authoritative detail", () => {
    const activity = buildAgentActivities([engineering], [runEvent({
      eventType: "agent.run.conclusion.corrected",
      safePayload: { summary: "Livrable maintenant vérifié dans le dépôt." },
    })])[0];

    expect(activity?.events[0]).toMatchObject({
      tone: "success",
      detail: "Livrable maintenant vérifié dans le dépôt.",
    });
  });

  it("limits each timeline to twenty newest events", () => {
    const events = Array.from({ length: 25 }, (_, index) => runEvent({
      sequence: String(index + 1),
      id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
      occurredAt: new Date(now.getTime() + index * 1_000),
    }));

    const activity = buildAgentActivities([engineering], events)[0];

    expect(activity?.events).toHaveLength(20);
    expect(activity?.events[0]?.sequence).toBe("6");
    expect(activity?.events.at(-1)?.sequence).toBe("25");
  });

  it("maps uncertain and reconciliation states to an explicit problem phase", () => {
    expect(phaseForActivity({ agentStatus: "uncertain", taskStatus: "problem", runState: "reconciliation_required" })).toBe("problem");
  });
});
