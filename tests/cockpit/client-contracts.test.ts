import { describe, expect, it } from "vitest";
import { cockpitEventSchema, snapshotResponseSchema } from "@/lib/cockpit/client-contracts";

const now = "2026-07-20T10:00:00.000Z";
const event = {
  sequence: "42",
  id: "11111111-1111-4111-8111-111111111111",
  eventType: "owner.command.created",
  aggregateType: "command",
  aggregateId: "22222222-2222-4222-8222-222222222222",
  safePayload: { commandType: "owner.message" },
  occurredAt: now,
};

describe("cockpit client contracts", () => {
  it("accepts the serialized snapshot returned by the ops API", () => {
    const result = snapshotResponseSchema.safeParse({
      mode: "demo",
      project: { id: "company-os", displayName: "Company OS" },
      access: { actorId: "owner", role: "owner" },
      snapshot: {
        agents: [{
          id: "ceo",
          displayName: "Directeur général",
          role: "Coordonne l’entreprise et répartit les priorités",
          status: "working",
          currentTaskId: null,
          currentTaskTitle: null,
          modelProfile: "expert",
          heartbeatAt: now,
          ownerStatus: "working",
        }],
        agentActivity: [{
          agentId: "ceo",
          taskId: null,
          runId: null,
          taskTitle: null,
          intendedOutcome: null,
          phase: "working",
          startedAt: null,
          lastSignalAt: now,
          modelProfile: "expert",
          events: [{
            sequence: "42",
            id: event.id,
            eventType: event.eventType,
            occurredAt: now,
            tone: "working",
            detail: null,
          }],
        }],
        tasks: [],
        messages: [{
          id: "55555555-5555-4555-8555-555555555555",
          sender: "ceo",
          commandId: "22222222-2222-4222-8222-222222222222",
          safeBody: "Réponse visible du CEO.",
          status: "completed",
          createdAt: now,
        }],
        approvals: [{
          id: "33333333-3333-4333-8333-333333333333",
          taskId: "44444444-4444-4444-8444-444444444444",
          requestedByAgentId: "ceo",
          actionDigest: "a".repeat(64),
          policyVersion: 1,
          actionVersion: 1,
          riskClass: "production",
          expiresAt: "2026-07-21T10:00:00.000Z",
          createdAt: now,
          ownerExplanation: {
            willHappen: "Le prototype local sera mis à jour.",
            willNotHappen: "Aucune mise en production ne sera lancée.",
            refusalEffect: "Le travail restera en attente.",
            reversible: "Oui, avant toute publication.",
          },
        }],
        pause: { state: "running", reason: null, version: 1, changedBy: "owner", changedAt: now },
        health: {
          database: { status: "connected", heartbeatAt: now },
          supervisor: { component: "supervisor", status: "connected", detailCode: null, heartbeatAt: now },
          bridge: { component: "bridge", status: "connected", detailCode: null, heartbeatAt: now },
          codex: { component: "codex", status: "connected", detailCode: null, heartbeatAt: now },
        },
        latestEvents: [event],
        lastSequence: "42",
        commandVersion: 1,
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects malformed or unbounded event shapes", () => {
    expect(cockpitEventSchema.safeParse({ ...event, sequence: "not-a-sequence" }).success).toBe(false);
    expect(cockpitEventSchema.safeParse({ ...event, hiddenReasoning: "must not pass" }).success).toBe(false);
  });

  it("requires all four owner-facing approval explanations", () => {
    const explanation = {
      willHappen: "Action locale.",
      willNotHappen: "Aucun envoi externe.",
      refusalEffect: "Le travail attendra.",
    };
    const approval = {
      id: "33333333-3333-4333-8333-333333333333",
      taskId: "44444444-4444-4444-8444-444444444444",
      requestedByAgentId: "ceo",
      actionDigest: "a".repeat(64),
      policyVersion: 1,
      actionVersion: 1,
      riskClass: "production",
      expiresAt: "2026-07-21T10:00:00.000Z",
      createdAt: now,
      ownerExplanation: explanation,
    };

    const snapshot = {
      mode: "demo",
      project: { id: "company-os", displayName: "Company OS" },
      access: { actorId: "owner", role: "owner" },
      snapshot: {
        agents: [], agentActivity: [], tasks: [], approvals: [approval], messages: [],
        pause: { state: "running", reason: null, version: 1, changedBy: "owner", changedAt: now },
        latestEvents: [], lastSequence: "0",
      },
    };
    expect(snapshotResponseSchema.safeParse(snapshot).success).toBe(false);
  });
});
