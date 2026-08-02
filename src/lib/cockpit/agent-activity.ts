import type {
  CockpitAgentStatus,
  CockpitRunStatus,
  CockpitTaskStatus,
  ModelProfile,
  SafeOperationalValue,
} from "./domain";

export type AgentActivityPhase =
  | "idle"
  | "preparing"
  | "dispatching"
  | "working"
  | "verification"
  | "completed"
  | "problem";

export type AgentActivityTone = "neutral" | "working" | "success" | "problem";

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

export type AgentActivity = {
  agentId: string;
  taskId: string | null;
  runId: string | null;
  taskTitle: string | null;
  intendedOutcome: string | null;
  phase: AgentActivityPhase;
  startedAt: Date | null;
  lastSignalAt: Date | null;
  modelProfile: ModelProfile | null;
  events: AgentActivityTimelineEvent[];
};

export function buildAgentActivities(
  sources: readonly AgentActivitySource[],
  events: readonly ActivityEventSource[],
  eventLimit = 20,
): AgentActivity[] {
  const limit = Math.min(Math.max(Math.trunc(eventLimit), 1), 20);

  return sources.map((source) => {
    const relatedEvents = events
      .filter((event) => eventBelongsToAgentActivity(event, source))
      .slice(-limit)
      .map((event) => ({
        sequence: event.sequence,
        id: event.id,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        tone: toneForEvent(event.eventType),
        detail: safeDetailForEvent(event),
      }));
    const latestEventAt = relatedEvents.at(-1)?.occurredAt ?? null;

    return {
      agentId: source.agentId,
      taskId: source.taskId,
      runId: source.runId,
      taskTitle: source.taskTitle,
      intendedOutcome: source.intendedOutcome,
      phase: phaseForActivity(source),
      startedAt: source.startedAt,
      lastSignalAt: newestDate(source.lastSignalAt, latestEventAt),
      modelProfile: source.modelProfile,
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
  return source.agentId === "ceo" && event.aggregateType === "command";
}

function toneForEvent(eventType: string): AgentActivityTone {
  if (eventType.includes("failed") || eventType.includes("reconciliation") || eventType.includes("orphaned")) return "problem";
  if (eventType.includes("completed") || eventType.includes("approved") || eventType.includes("conclusion.corrected")) return "success";
  if (eventType.includes("started") || eventType.includes("selected") || eventType.includes("queued")) return "working";
  return "neutral";
}

function safeDetailForEvent(event: ActivityEventSource): string | null {
  if (event.eventType !== "agent.run.completed" && event.eventType !== "agent.run.conclusion.corrected") return null;
  const summary = event.safePayload.summary;
  return typeof summary === "string" ? summary.slice(0, 4_000) : null;
}

function newestDate(left: Date | null, right: Date | null): Date | null {
  if (!left) return right;
  if (!right) return left;
  return left.getTime() >= right.getTime() ? left : right;
}
