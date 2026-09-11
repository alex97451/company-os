import type {
  CockpitAgentStatus,
  CockpitRunStatus,
  CockpitTaskStatus,
  ModelProfile,
  SafeOperationalValue,
} from "./domain";
import { findOwnerMessagePolicyViolation } from "./owner-message-policy";

export type AgentActivityPhase =
  | "idle"
  | "preparing"
  | "dispatching"
  | "working"
  | "verification"
  | "completed"
  | "problem";

export type AgentActivityTone = "neutral" | "working" | "success" | "problem";
export type AgentActivityKind = "waiting" | "real" | "simulation" | "failure";
export type AgentActivityDecisionKind =
  | "resources_selected"
  | "owner_approved"
  | "owner_refused"
  | "verification_requested"
  | "verification_approved"
  | "verification_changes_requested"
  | "verification_blocked";

export type AgentActivitySource = {
  agentId: string;
  agentStatus: CockpitAgentStatus;
  taskId: string | null;
  taskTitle: string | null;
  intendedOutcome: string | null;
  taskStatus: CockpitTaskStatus | null;
  runId: string | null;
  runState: CockpitRunStatus | null;
  modelProfile: ModelProfile | null;
  startedAt: Date | null;
  lastSignalAt: Date | null;
  conclusion: string | null;
  deliverables: string[];
  isSimulation: boolean;
};

export type ActivityEventSource = {
  sequence: string;
  id: string;
  eventType: string;
  aggregateType: "agent" | "command" | "task" | "run" | "approval" | "budget" | "pause" | "system";
  aggregateId: string;
  safePayload: Record<string, SafeOperationalValue>;
  occurredAt: Date;
};

export type AgentActivityTimelineEvent = {
  sequence: string;
  id: string;
  eventType: string;
  occurredAt: Date;
  tone: AgentActivityTone;
  detail: string | null;
};

export type AgentActivityDecision = {
  id: string;
  kind: AgentActivityDecisionKind;
  label: string;
  occurredAt: Date;
};

export type AgentActivity = {
  agentId: string;
  taskId: string | null;
  runId: string | null;
  taskTitle: string | null;
  intendedOutcome: string | null;
  phase: AgentActivityPhase;
  activityKind: AgentActivityKind;
  currentStep: string;
  startedAt: Date | null;
  lastSignalAt: Date | null;
  modelProfile: ModelProfile | null;
  conclusion: string | null;
  deliverables: string[];
  decisions: AgentActivityDecision[];
  events: AgentActivityTimelineEvent[];
};

export function buildAgentActivities(
  sources: readonly AgentActivitySource[],
  events: readonly ActivityEventSource[],
  eventLimit = 20,
): AgentActivity[] {
  const limit = Math.min(Math.max(Math.trunc(eventLimit), 1), 20);

  return sources.map((source) => {
    const relatedEventSources = events
      .filter((event) => eventBelongsToAgentActivity(event, source))
      .slice(-limit);
    const relatedEvents = relatedEventSources.map((event) => ({
      sequence: event.sequence,
      id: event.id,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      tone: toneForEvent(event.eventType),
      detail: safeDetailForEvent(event),
    }));
    const latestEventAt = relatedEvents.at(-1)?.occurredAt ?? null;
    const phase = phaseForActivity(source);
    const eventConclusion = [...relatedEventSources]
      .reverse()
      .map(safeDetailForEvent)
      .find((detail): detail is string => Boolean(detail));
    const eventDeliverables = [...relatedEventSources]
      .reverse()
      .map(safeDeliverablesForEvent)
      .find((items) => items.length > 0);
    const decisions = relatedEventSources
      .map(decisionForEvent)
      .filter((decision): decision is AgentActivityDecision => decision !== null);

    return {
      agentId: source.agentId,
      taskId: source.taskId,
      runId: source.runId,
      taskTitle: source.taskTitle,
      intendedOutcome: source.intendedOutcome,
      phase,
      activityKind: activityKindForActivity(source, phase),
      currentStep: currentStepForActivity(source, phase),
      startedAt: source.startedAt,
      lastSignalAt: newestDate(source.lastSignalAt, latestEventAt),
      modelProfile: source.modelProfile,
      conclusion: eventConclusion ?? safeOwnerText(source.conclusion, 4_000),
      deliverables: eventDeliverables ?? safeDeliverables(source.deliverables),
      decisions,
      events: relatedEvents,
    };
  });
}

export function phaseForActivity(source: Pick<AgentActivitySource, "agentStatus" | "taskStatus" | "runState">): AgentActivityPhase {
  if (source.runState) {
    switch (source.runState) {
      case "queued": return "preparing";
      case "dispatching": return "dispatching";
      case "working": case "interruption_requested": return "working";
      case "verification": return "verification";
      case "completed": return source.taskStatus === "verification" ? "verification" : "completed";
      case "failed": case "blocked": case "reconciliation_required": case "orphaned": return "problem";
    }
  }
  if (source.taskStatus === "verification") return "verification";
  if (source.taskStatus === "done") return "completed";
  if (source.taskStatus === "problem" || source.agentStatus === "problem" || source.agentStatus === "uncertain") return "problem";
  if (source.agentStatus === "working") return "working";
  if (source.taskStatus === "queued" || source.taskStatus === "action_required") return "preparing";
  return "idle";
}

function eventBelongsToAgentActivity(event: ActivityEventSource, source: AgentActivitySource): boolean {
  if (event.aggregateType === "agent") return event.aggregateId === source.agentId;
  if (event.aggregateType === "run") return Boolean(source.runId && event.aggregateId === source.runId);
  if (event.aggregateType === "task") return Boolean(source.taskId && event.aggregateId === source.taskId);
  if (event.aggregateType === "approval") return Boolean(source.taskId && event.safePayload.taskId === source.taskId);
  return source.agentId === "ceo" && event.aggregateType === "command";
}

function toneForEvent(eventType: string): AgentActivityTone {
  if (eventType.includes("failed") || eventType.includes("reconciliation") || eventType.includes("orphaned")) return "problem";
  if (eventType.includes("completed") || eventType.includes("approved") || eventType.includes("conclusion.corrected")) return "success";
  if (eventType.includes("started") || eventType.includes("selected") || eventType.includes("queued")) return "working";
  return "neutral";
}

function safeDetailForEvent(event: ActivityEventSource): string | null {
  if (!["agent.run.completed", "agent.run.conclusion.corrected", "agent.run.blocked"].includes(event.eventType)) return null;
  const summary = event.safePayload.summary;
  return typeof summary === "string" ? safeOwnerText(summary, 4_000) : null;
}

function safeDeliverablesForEvent(event: ActivityEventSource): string[] {
  if (!["agent.run.completed", "agent.run.conclusion.corrected", "agent.run.blocked"].includes(event.eventType)) return [];
  return safeDeliverables(event.safePayload.evidence);
}

function safeDeliverables(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => safeOwnerText(item, 500))
    .filter((item): item is string => item !== null)
    .slice(0, 12);
}

function safeOwnerText(value: string | null, limit: number): string | null {
  if (!value) return null;
  const trimmed = value.trim().slice(0, limit);
  if (!trimmed || findOwnerMessagePolicyViolation(trimmed)) return null;
  return trimmed;
}

function activityKindForActivity(source: AgentActivitySource, phase: AgentActivityPhase): AgentActivityKind {
  if (phase === "problem") return "failure";
  if (source.isSimulation) return "simulation";
  if (source.runState && !["queued", "dispatching"].includes(source.runState)) return "real";
  return "waiting";
}

function currentStepForActivity(source: AgentActivitySource, phase: AgentActivityPhase): string {
  if (source.taskStatus === "action_required") return "Une décision ou une autorisation est nécessaire pour continuer.";
  if (source.taskStatus === "paused") return "Le travail est en pause et n’avance pas actuellement.";
  if (phase === "preparing") return "Le travail est enregistré et attend son démarrage.";
  if (phase === "dispatching") return "Le travail est transmis au moteur local.";
  if (phase === "working") return "Le livrable demandé est en cours de réalisation.";
  if (phase === "verification") return "Le résultat est contrôlé avant sa validation finale.";
  if (phase === "completed") return "Le travail est terminé et sa conclusion est enregistrée.";
  if (phase === "problem") {
    if (source.runState === "reconciliation_required" || source.runState === "orphaned") {
      return "Le résultat doit être confirmé avant toute reprise.";
    }
    return "Le travail est bloqué ou a échoué et demande une intervention.";
  }
  return "L’agent est disponible et n’a aucun travail actif.";
}

function decisionForEvent(event: ActivityEventSource): AgentActivityDecision | null {
  const presentation: Partial<Record<string, { kind: AgentActivityDecisionKind; label: string }>> = {
    "model.routing.selected": { kind: "resources_selected", label: "Les ressources adaptées à ce travail ont été sélectionnées." },
    "approval.approved": { kind: "owner_approved", label: "Le propriétaire a autorisé l’étape sensible demandée." },
    "approval.refused": { kind: "owner_refused", label: "Le propriétaire a refusé l’étape sensible demandée." },
    "agent.verification.queued": { kind: "verification_requested", label: "Une vérification indépendante a été demandée." },
  };
  const direct = presentation[event.eventType];
  if (direct) return { id: event.id, ...direct, occurredAt: event.occurredAt };
  if (event.eventType !== "agent.run.completed") return null;
  const verdict = event.safePayload.verdict;
  if (verdict === "approved") {
    return { id: event.id, kind: "verification_approved", label: "La vérification indépendante a approuvé le résultat.", occurredAt: event.occurredAt };
  }
  if (verdict === "changes_required") {
    return { id: event.id, kind: "verification_changes_requested", label: "La vérification indépendante demande des corrections.", occurredAt: event.occurredAt };
  }
  if (verdict === "blocked") {
    return { id: event.id, kind: "verification_blocked", label: "La vérification indépendante a confirmé un blocage.", occurredAt: event.occurredAt };
  }
  return null;
}

function newestDate(left: Date | null, right: Date | null): Date | null {
  if (!left) return right;
  if (!right) return left;
  return left.getTime() >= right.getTime() ? left : right;
}
