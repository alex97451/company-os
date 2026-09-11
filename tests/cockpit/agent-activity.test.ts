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
  conclusion: null,
  deliverables: [],
  isSimulation: false,
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
      safePayload: {
        summary: "Tests locaux terminés.",
        evidence: ["La suite de tests locale est validée."],
        demo: false,
      },
    })])[0];

    expect(activity?.events[0]?.detail).toBe("Tests locaux terminés.");
    expect(activity?.conclusion).toBe("Tests locaux terminés.");
    expect(activity?.deliverables).toEqual(["La suite de tests locale est validée."]);
    expect(activity?.activityKind).toBe("real");
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

  it("distinguishes waiting, simulation and failure without guessing from the interface", () => {
    const waiting: AgentActivitySource = {
      ...engineering,
      agentStatus: "waiting",
      taskStatus: "queued",
      runState: "queued",
      isSimulation: false,
    };
    const simulation: AgentActivitySource = { ...engineering, isSimulation: true };
    const failure: AgentActivitySource = {
      ...engineering,
      agentStatus: "problem",
      taskStatus: "problem",
      runState: "blocked",
      isSimulation: true,
    };

    expect(buildAgentActivities([waiting], [])[0]).toMatchObject({ activityKind: "waiting" });
    expect(buildAgentActivities([simulation], [])[0]).toMatchObject({ activityKind: "simulation" });
    expect(buildAgentActivities([failure], [])[0]).toMatchObject({
      activityKind: "failure",
      currentStep: "Le travail est bloqué ou a échoué et demande une intervention.",
    });
  });

  it("projects only task-correlated owner decisions in plain French", () => {
    const unrelatedTaskId = "55555555-5555-4555-8555-555555555555";
    const events = [
      runEvent({ eventType: "model.routing.selected" }),
      runEvent({
        id: "66666666-6666-4666-8666-666666666666",
        eventType: "approval.approved",
        aggregateType: "approval",
        aggregateId: "77777777-7777-4777-8777-777777777777",
        safePayload: { taskId: engineering.taskId },
      }),
      runEvent({
        id: "88888888-8888-4888-8888-888888888888",
        eventType: "approval.refused",
        aggregateType: "approval",
        aggregateId: "99999999-9999-4999-8999-999999999999",
        safePayload: { taskId: unrelatedTaskId },
      }),
    ];

    expect(buildAgentActivities([engineering], events)[0]?.decisions).toEqual([
      expect.objectContaining({ kind: "resources_selected" }),
      expect.objectContaining({ kind: "owner_approved" }),
    ]);
  });

  it("drops sensitive historical evidence from the owner projection", () => {
    const activity = buildAgentActivities([{
      ...engineering,
      conclusion: "Travail terminé.",
      deliverables: ["contact@example.com", "Contrôle local terminé."],
    }], [])[0];

    expect(activity?.deliverables).toEqual(["Contrôle local terminé."]);
    expect(JSON.stringify(activity)).not.toContain("contact@example.com");
  });
});
