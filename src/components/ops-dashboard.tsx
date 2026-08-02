"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  Bot,
  BrainCircuit,
  BriefcaseBusiness,
  Check,
  CheckCircle2,
  ChevronDown,
  Clapperboard,
  CircleDollarSign,
  Clock3,
  Cpu,
  Gauge,
  History,
  ListTodo,
  LayoutDashboard,
  LockKeyhole,
  Pause,
  Play,
  PlugZap,
  Radio,
  Route,
  Send,
  ShieldCheck,
  Sparkles,
  UserRoundCog,
  UsersRound,
  Wifi,
  Workflow,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  modelProfiles,
  type ActivityItem,
  type CeoMessage,
  type CompanyAgent,
  type CompanyPriority,
  type CompanyState,
  type CompanyTask,
  type ModelProfile,
} from "@/content/ops-demo";
import { OpsSystemWorkspace } from "@/components/ops-system-workspace";
import { OpsCompanySessions } from "@/components/ops-company-sessions";
import {
  approvalResponseSchema,
  cockpitEventSchema,
  commandResponseSchema,
  fetchOpsSnapshot,
  opsOperatorAccessResponseSchema,
  opsPresenceResponseSchema,
  pauseResponseSchema,
  postOpsJson,
  type OpsApproval,
  type OpsAccess,
  type OpsEvent,
  type OpsOperatorAccess,
  type OpsPresence,
  type OpsProjectIdentity,
  type OpsSnapshot,
} from "@/lib/cockpit/client-contracts";
import { normalizeActivityEvents } from "@/lib/cockpit/activity-events";
import { OpsSystemLogs } from "@/components/ops-system-logs";
import { OpsVideoStudio } from "@/components/ops-video-studio";

const stateMeta: Record<CompanyState, { label: string; dot: string; badge: string }> = {
  waiting: { label: "En attente", dot: "bg-slate-400", badge: "border-slate-500/30 bg-slate-500/10 text-slate-300" },
  working: { label: "En cours", dot: "bg-sky-400", badge: "border-sky-500/30 bg-sky-500/10 text-sky-200" },
  action: { label: "Action requise", dot: "bg-amber-400", badge: "border-amber-500/30 bg-amber-500/10 text-amber-200" },
  done: { label: "Terminé", dot: "bg-emerald-400", badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" },
  problem: { label: "Problème", dot: "bg-rose-400", badge: "border-rose-500/30 bg-rose-500/10 text-rose-200" },
};

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#090c12]";
const surface = "rounded-2xl border border-white/[0.08] bg-[#10151e] shadow-[0_20px_70px_rgba(0,0,0,0.22)]";

type ConnectionState = "loading" | "connected" | "degraded" | "offline";
type DataSource = "loading" | "live" | "offline";
type SendState = "idle" | "sending" | "waiting" | "error";
type OpsView = "overview" | "work" | "team" | "video" | "health" | "integrations";
type TaskFilter = "all" | "working" | "waiting" | "problem" | "done";
type AgentActivityDetail = OpsSnapshot["agentActivity"][number];

const phaseMeta: Record<AgentActivityDetail["phase"], { label: string; tone: string; dot: string }> = {
  idle: { label: "Disponible", tone: "border-slate-500/30 bg-slate-500/10 text-slate-300", dot: "bg-slate-400" },
  preparing: { label: "Préparation", tone: "border-amber-500/30 bg-amber-500/10 text-amber-200", dot: "bg-amber-400" },
  dispatching: { label: "Transmission à Codex", tone: "border-sky-500/30 bg-sky-500/10 text-sky-200", dot: "bg-sky-400" },
  working: { label: "Travail en cours", tone: "border-sky-500/30 bg-sky-500/10 text-sky-200", dot: "bg-sky-400" },
  verification: { label: "Vérification", tone: "border-violet-500/30 bg-violet-500/10 text-violet-200", dot: "bg-violet-400" },
  completed: { label: "Terminé", tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200", dot: "bg-emerald-400" },
  problem: { label: "Attention requise", tone: "border-rose-500/30 bg-rose-500/10 text-rose-200", dot: "bg-rose-400" },
};

const profileLabels: Record<NonNullable<OpsSnapshot["agents"][number]["modelProfile"]>, ModelProfile> = {
  rapid: "Rapid",
  balanced: "Balanced",
  expert: "Expert",
  critical: "Critical",
};

function toCompanyState(status: OpsSnapshot["agents"][number]["ownerStatus"]): CompanyState {
  return status === "action_required" ? "action" : status;
}

function relativeTime(value: string | null, now: number): string {
  if (!value) return "Aucun signal récent";
  const elapsed = Math.max(0, now - new Date(value).getTime());
  if (elapsed < 5_000) return "À l'instant";
  if (elapsed < 60_000) return `Il y a ${Math.floor(elapsed / 1_000)} s`;
  if (elapsed < 3_600_000) return `Il y a ${Math.floor(elapsed / 60_000)} min`;
  return `Il y a ${Math.floor(elapsed / 3_600_000)} h`;
}

function expiryTime(value: string, now: number): string {
  const remaining = new Date(value).getTime() - now;
  if (remaining <= 0) return "expirée";
  if (remaining < 60_000) return "dans moins d’une minute";
  if (remaining < 3_600_000) return `dans ${Math.ceil(remaining / 60_000)} min`;
  return `dans ${Math.ceil(remaining / 3_600_000)} h`;
}

function opsViewLabel(view: string): string {
  const labels: Record<string, string> = {
    overview: "Accueil",
    work: "Travaux",
    team: "Équipe",
    video: "Studio vidéo",
    health: "Santé",
    integrations: "Système",
  };
  return labels[view] ?? "Cockpit";
}

function safeMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : "REQUEST_FAILED";
  if (code === "SESSION_EXPIRED") return "La session propriétaire a expiré. Recharge la page pour te reconnecter.";
  if (code === "CSRF_UNAVAILABLE") return "La protection de session est absente. Recharge la page avant de réessayer.";
  if (code === "STALE_STATE") return "Les données ont changé. La vue va être actualisée avant une nouvelle tentative.";
  if (code === "SNAPSHOT_UNAVAILABLE") return "La base locale ne répond pas. Aucune donnée de remplacement n’est affichée et le cockpit réessaiera automatiquement.";
  if (code === "INVALID_SNAPSHOT" || code === "INVALID_RESPONSE") return "La réponse locale reçue n'est pas reconnue.";
  return "La commande n'a pas pu être transmise. Rien n'a été relancé automatiquement.";
}

function eventSummary(event: OpsEvent, snapshot: OpsSnapshot): {
  actor: string;
  role: string;
  summary: string;
  detail?: string;
} {
  const activity = snapshot.agentActivity.find((item) =>
    item.events.some((activityEvent) => activityEvent.id === event.id)
    || (event.aggregateType === "run" && item.runId === event.aggregateId),
  );
  const agentId = event.aggregateType === "agent" ? event.aggregateId : activity?.agentId ?? (event.aggregateType === "command" ? "ceo" : null);
  const agent = snapshot.agents.find((item) => item.id === agentId);
  const taskId = typeof event.safePayload.taskId === "string" ? event.safePayload.taskId : activity?.taskId;
  const task = snapshot.tasks.find((item) => item.id === taskId);
  const taskTitle = task?.title ?? activity?.taskTitle ?? "le travail en cours";
  const safeConclusion = typeof event.safePayload.summary === "string"
    ? event.safePayload.summary.slice(0, 4_000)
    : undefined;
  const presentations: Record<string, { summary: string; detail?: string }> = {
    "owner.command.created": {
      summary: "a reçu une nouvelle demande et prépare sa répartition.",
      detail: "La demande est enregistrée. Aucun agent n’est annoncé au travail avant son démarrage réel.",
    },
    "model.routing.selected": {
      summary: `a choisi les ressources adaptées pour « ${taskTitle} ».`,
      detail: "Le niveau de capacité est ajusté à la difficulté et au risque du travail.",
    },
    "agent.run.started": {
      summary: `a commencé « ${taskTitle} ».`,
      detail: "Le travail est réellement en cours.",
    },
    "agent.run.completed": {
      summary: `a terminé « ${taskTitle} ».`,
      detail: safeConclusion ?? "Le travail est terminé, mais sa conclusion n’est pas disponible.",
    },
    "agent.run.conclusion.corrected": {
      summary: `a corrigé la conclusion de « ${taskTitle} ».`,
      detail: safeConclusion ?? "La conclusion historique a été remplacée après vérification du livrable.",
    },
    "agent.run.failed": {
      summary: `n’a pas pu terminer « ${taskTitle} ».`,
      detail: "Le travail nécessite une correction avant de pouvoir reprendre.",
    },
    "agent.run.blocked": {
      summary: `est bloqué sur « ${taskTitle} ».`,
      detail: "Une information, une autorisation ou une dépendance manque pour continuer.",
    },
    "agent.run.reconciliation_required": {
      summary: `demande une vérification sur « ${taskTitle} ».`,
      detail: "Le système ne peut pas confirmer le résultat automatiquement.",
    },
    "agent.verification.queued": {
      summary: `a demandé une vérification indépendante de « ${taskTitle} ».`,
      detail: "Un second agent contrôle le résultat avant sa validation finale.",
    },
    "approval.approved": {
      summary: "a pris en compte une autorisation du propriétaire.",
    },
    "approval.refused": {
      summary: "a pris en compte un refus du propriétaire.",
    },
    "pause.changed": {
      summary: "a mis à jour l’état général de l’entreprise.",
    },
  };
  const presentation = presentations[event.eventType] ?? {
    summary: `a mis à jour le suivi de « ${taskTitle} ».`,
    detail: "Une nouvelle étape opérationnelle a été enregistrée.",
  };
  if (event.eventType === "ops.presence.updated") {
    const presenceActor = typeof event.safePayload.actorId === "string" ? event.safePayload.actorId : "utilisateur";
    const activeView = typeof event.safePayload.activeView === "string" ? event.safePayload.activeView : "cockpit";
    return {
      actor: presenceActor === "owner" ? "Propriétaire" : `Opérateur ${presenceActor}`,
      role: "Présence dans Ops",
      summary: `consulte la vue « ${opsViewLabel(activeView)} ».`,
      detail: "Présence active sur le réseau local.",
    };
  }
  return {
    actor: agent?.displayName ?? "Système de l’entreprise",
    role: agent?.role ?? "Suivi automatique",
    ...presentation,
  };
}

export function OpsDashboard() {
  const [snapshot, setSnapshot] = useState<OpsSnapshot | null>(null);
  const [access, setAccess] = useState<OpsAccess>({ actorId: "owner", role: "owner" });
  const [presence, setPresence] = useState<OpsPresence[]>([]);
  const [operatorAccess, setOperatorAccess] = useState<OpsOperatorAccess | null>(null);
  const [operatorAccessLoading, setOperatorAccessLoading] = useState(false);
  const [mode, setMode] = useState("local");
  const [project, setProject] = useState<OpsProjectIdentity>({ id: "company-os", displayName: "Company OS" });
  const [dataSource, setDataSource] = useState<DataSource>("loading");
  const [connection, setConnection] = useState<ConnectionState>("loading");
  const [requestError, setRequestError] = useState<string | null>(null);
  const [lastUpdateAt, setLastUpdateAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pauseConfirm, setPauseConfirm] = useState(false);
  const [pauseSending, setPauseSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<CeoMessage[]>([]);
  const [sendState, setSendState] = useState<SendState>("idle");
  const [approvalSending, setApprovalSending] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<OpsView>("overview");
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const sequenceRef = useRef("0");
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const agentDialogRef = useRef<HTMLDialogElement>(null);
  const agentDialogHeadingRef = useRef<HTMLHeadingElement>(null);
  const lastAgentTriggerRef = useRef<HTMLButtonElement | null>(null);

  const loadSnapshot = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetchOpsSnapshot(signal);
      setSnapshot(response.snapshot);
      setAccess(response.access);
      setMode(response.mode);
      setProject(response.project);
      setDataSource("live");
      setConnection((current) => current === "degraded" ? "degraded" : "connected");
      setLastUpdateAt(Date.now());
      setRequestError(null);
      sequenceRef.current = response.snapshot.lastSequence;
      setMessages(response.snapshot.messages.map((message) => ({
        id: message.id,
        author: message.sender === "owner" ? "Owner" : "CEO",
        body: message.safeBody,
        time: relativeTime(message.createdAt, Date.now()),
        status: message.status === "demo" ? "Démo" : message.status === "completed" ? "Terminé" : message.status === "dispatched" ? "Transmis" : message.status === "reconciliation_required" ? "À vérifier" : message.status === "failed" ? "Échec" : "En attente",
      })));
    } catch (error) {
      if (signal?.aborted) return;
      setConnection("offline");
      setRequestError(safeMessage(error));
      setDataSource("offline");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const routeSelection = window.setTimeout(() => {
      if (new URLSearchParams(window.location.search).get("view") === "integrations") setActiveView("integrations");
    }, 0);
    const initial = window.setTimeout(() => void loadSnapshot(controller.signal), 0);
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    const recovery = window.setInterval(() => void loadSnapshot(), 15_000);
    return () => {
      controller.abort();
      window.clearTimeout(routeSelection);
      window.clearTimeout(initial);
      window.clearInterval(clock);
      window.clearInterval(recovery);
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [loadSnapshot]);

  useEffect(() => {
    let cancelled = false;
    const syncPresence = async () => {
      if (dataSource !== "live") return;
      try {
        const response = await postOpsJson(
          "/api/ops/presence",
          { activeView },
          opsPresenceResponseSchema,
        );
        if (!cancelled) setPresence(response.presence);
      } catch {
        // Presence is informative and must never block the operational cockpit.
      }
    };
    const initial = window.setTimeout(() => void syncPresence(), 0);
    const heartbeat = window.setInterval(() => void syncPresence(), 10_000);
    return () => {
      cancelled = true;
      window.clearTimeout(initial);
      window.clearInterval(heartbeat);
    };
  }, [activeView, dataSource]);

  useEffect(() => {
    if (dataSource !== "live") return;
    const events = new EventSource(`/api/ops/events?after=${encodeURIComponent(sequenceRef.current)}`);
    const refreshSoon = () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => void loadSnapshot(), 250);
    };
    const onCockpit = (event: MessageEvent<string>) => {
      let raw: unknown;
      try { raw = JSON.parse(event.data); } catch { return; }
      const parsed = cockpitEventSchema.safeParse(raw);
      if (!parsed.success) {
        setConnection("degraded");
        setRequestError("Un événement local non reconnu a été ignoré.");
        return;
      }
      sequenceRef.current = parsed.data.sequence;
      setSnapshot((current) => current ? {
        ...current,
        lastSequence: parsed.data.sequence,
        latestEvents: [...current.latestEvents, parsed.data].slice(-100),
      } : current);
      setLastUpdateAt(Date.now());
      setConnection("connected");
      refreshSoon();
    };
    const onDegraded = () => {
      setConnection("degraded");
      setRequestError("Le flux temps réel est dégradé. La vue continue de se resynchroniser.");
    };
    events.addEventListener("cockpit", onCockpit as EventListener);
    events.addEventListener("degraded", onDegraded);
    events.onopen = () => setConnection("connected");
    events.onerror = onDegraded;
    return () => events.close();
  }, [dataSource, loadSnapshot]);

  useEffect(() => {
    const chat = chatScrollRef.current;
    if (!chat) return;
    chat.scrollTop = chat.scrollHeight;
  }, [messages.length, activeView]);

  useEffect(() => {
    const dialog = agentDialogRef.current;
    if (!dialog || !selectedAgentId) return;
    if (!dialog.open) dialog.showModal();
    const focusFrame = window.requestAnimationFrame(() => agentDialogHeadingRef.current?.focus());
    return () => window.cancelAnimationFrame(focusFrame);
  }, [selectedAgentId]);

  const paused = snapshot ? snapshot.pause.state !== "running" : false;
  const displayAgents = useMemo<CompanyAgent[]>(() => snapshot ? snapshot.agents.map((agent) => {
    return {
      id: agent.id,
      name: agent.displayName,
      role: agent.role,
      state: toCompanyState(agent.ownerStatus),
      task: agent.currentTaskTitle ?? "Aucun travail en cours",
      profile: agent.modelProfile ? profileLabels[agent.modelProfile] : "Rapid",
      lastProgress: relativeTime(agent.heartbeatAt, now),
    };
  }) : [], [snapshot, now]);

  const displayTasks = useMemo<CompanyTask[]>(() => snapshot ? snapshot.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    owner: snapshot.agents.find((agent) => agent.id === task.assignedAgentId)?.displayName ?? task.assignedAgentId,
    state: toCompanyState(task.ownerStatus),
    verifier: task.verifierAgentId ? snapshot.agents.find((agent) => agent.id === task.verifierAgentId)?.displayName ?? task.verifierAgentId : "Non requis",
    result: task.ownerStatus === "done"
      ? task.completionSummary ?? "Le travail est terminé, mais aucune conclusion exploitable n’a été enregistrée."
      : task.intendedOutcome,
    resultLabel: task.ownerStatus === "done" ? "Conclusion" : "Résultat attendu",
  })) : [], [snapshot]);
  const filteredTasks = useMemo(
    () => taskFilter === "all" ? displayTasks : displayTasks.filter((task) => task.state === taskFilter),
    [displayTasks, taskFilter],
  );

  const displayPriorities = useMemo<CompanyPriority[]>(() => snapshot ? snapshot.tasks
    .filter((task) => task.ownerStatus !== "done")
    .slice(0, 5)
    .map((task) => ({
      id: task.id,
      title: task.title,
      owner: snapshot.agents.find((agent) => agent.id === task.assignedAgentId)?.displayName ?? task.assignedAgentId,
      state: toCompanyState(task.ownerStatus),
      due: relativeTime(task.updatedAt, now),
    })) : [], [snapshot, now]);

  const displayActivity = useMemo<ActivityItem[]>(() => snapshot ? normalizeActivityEvents(snapshot.latestEvents).map((event) => {
    const summary = eventSummary(event, snapshot);
    return {
      id: event.id,
      reference: event.sequence,
      actor: summary.actor,
      role: summary.role,
      summary: summary.summary,
      detail: summary.detail,
      time: relativeTime(event.occurredAt, now),
      state: event.eventType.includes("failed") || event.eventType.includes("blocked") ? "problem" : event.eventType.includes("approval") ? "action" : event.eventType.includes("completed") ? "done" : "working",
    };
  }) : [], [snapshot, now]);
  const selectedAgent = displayAgents.find((agent) => agent.id === selectedAgentId) ?? null;
  const selectedAgentActivity = snapshot?.agentActivity.find((activity) => activity.agentId === selectedAgentId) ?? null;

  const displayModelProfiles = useMemo(() => {
    if (!snapshot) return modelProfiles.map((profile) => ({ ...profile, share: "0%" }));
    const total = Math.max(1, snapshot.agents.filter((agent) => agent.modelProfile).length);
    return modelProfiles.map((profile) => {
      const key = profile.name.toLowerCase() as "rapid" | "balanced" | "expert" | "critical";
      const count = snapshot.agents.filter((agent) => agent.modelProfile === key).length;
      return { ...profile, share: `${Math.round((count / total) * 100)}%` };
    });
  }, [snapshot]);

  const workingCount = displayAgents.filter((agent) => agent.state === "working").length;
  const selectedPhase = selectedAgentActivity?.phase
    ?? (selectedAgent?.state === "working" ? "working" : selectedAgent?.state === "problem" ? "problem" : "idle");
  const selectedProgress = phaseProgress(selectedPhase);
  const selectedConclusion = selectedAgentActivity?.events
    .findLast((event) =>
      (event.eventType === "agent.run.completed" || event.eventType === "agent.run.conclusion.corrected")
      && event.detail,
    )
    ?.detail ?? null;
  const activeApproval = snapshot?.approvals[0] ?? null;
  const freshness = lastUpdateAt ? relativeTime(new Date(lastUpdateAt).toISOString(), now) : dataSource === "offline" ? "Indisponible" : "Chargement";

  async function sendToCeo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || sendState === "sending") return;
    const id = crypto.randomUUID();
    setSendState("sending");
    setRequestError(null);
    setMessages((current) => [...current, { id, author: "Owner", body, time: "À l'instant", status: "Envoi…" }]);
    try {
      await postOpsJson("/api/ops/commands", {
        idempotencyKey: id,
        expectedAggregateVersion: snapshot?.commandVersion ?? 0,
        message: body,
      }, commandResponseSchema);
      setMessages((current) => current.map((message) => message.id === id ? { ...message, status: "Reçu · en attente" } : message));
      setDraft("");
      setSendState("waiting");
      await loadSnapshot();
    } catch (error) {
      setMessages((current) => current.map((message) => message.id === id ? { ...message, status: "Échec de l'envoi" } : message));
      setSendState("error");
      setRequestError(safeMessage(error));
    }
  }

  async function togglePause() {
    if (!paused && !pauseConfirm) {
      setPauseConfirm(true);
      return;
    }
    setPauseSending(true);
    setRequestError(null);
    try {
      await postOpsJson("/api/ops/pause", { paused: !paused }, pauseResponseSchema);
      setPauseConfirm(false);
      await loadSnapshot();
    } catch (error) {
      setRequestError(safeMessage(error));
    } finally {
      setPauseSending(false);
    }
  }

  async function decideApproval(approval: OpsApproval, decision: "approved" | "refused") {
    setApprovalSending(approval.id);
    setRequestError(null);
    try {
      await postOpsJson("/api/ops/approvals", {
        approvalId: approval.id,
        actionDigest: approval.actionDigest,
        policyVersion: approval.policyVersion,
        actionVersion: approval.actionVersion,
        decision,
      }, approvalResponseSchema);
      await loadSnapshot();
    } catch (error) {
      setRequestError(safeMessage(error));
      if (error instanceof Error && error.message === "STALE_STATE") await loadSnapshot();
    } finally {
      setApprovalSending(null);
    }
  }

  async function revealOperatorAccess(): Promise<void> {
    setOperatorAccessLoading(true);
    try {
      const response = await fetch("/api/ops/operator-access", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error("OPERATOR_ACCESS_UNAVAILABLE");
      setOperatorAccess(opsOperatorAccessResponseSchema.parse(payload));
    } catch {
      setRequestError("L’accès opérateur n’est pas disponible. Vérifie le mode LAN dans Santé.");
    } finally {
      setOperatorAccessLoading(false);
    }
  }

  function selectView(view: OpsView, targetId: string = view): void {
    setActiveView(view);
    window.requestAnimationFrame(() => {
      document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function openAgentDetail(agentId: string, trigger: HTMLButtonElement): void {
    lastAgentTriggerRef.current = trigger;
    setSelectedAgentId(agentId);
  }

  function closeAgentDetail(): void {
    agentDialogRef.current?.close();
  }

  function handleAgentDialogClosed(): void {
    setSelectedAgentId(null);
    window.requestAnimationFrame(() => lastAgentTriggerRef.current?.focus());
  }

  return (
    <div className="min-h-[100svh] overflow-x-clip bg-[#070a10] font-sans text-slate-100">
      <a href="#main-content" className={`fixed left-4 top-4 z-50 -translate-y-24 rounded-lg bg-white px-4 py-3 text-sm font-bold text-slate-950 transition-transform focus:translate-y-0 ${focusRing}`}>
        Aller au contenu
      </a>

      <CommandNavigation
        activeView={activeView}
        connection={connection}
        dataSource={dataSource}
        onSelect={selectView}
        paused={paused}
        pauseSending={pauseSending}
        pauseConfirm={pauseConfirm}
        onTogglePause={togglePause}
        onCancelPause={() => setPauseConfirm(false)}
        access={access}
        presence={presence}
        project={project}
      />

      <header className="safe-header border-b border-white/[0.08] bg-[#0a0e15] xl:hidden">
        <div className="mx-auto w-[min(100%-2rem,92rem)] py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3 xl:hidden">
              <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-amber-400/25 bg-amber-400/10 text-amber-300">
                <Bot aria-hidden="true" className="size-5" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-white">{project.displayName}</p>
                <p className="truncate text-xs text-slate-400">Cockpit de direction · Local</p>
              </div>
            </div>

            <button
              type="button"
              onClick={togglePause}
              disabled={pauseSending || dataSource !== "live" || access.role !== "owner"}
              className={`inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border px-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${focusRing} ${paused ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/15" : "border-rose-400/30 bg-rose-400/10 text-rose-200 hover:bg-rose-400/15"}`}
              aria-pressed={paused}
            >
              {paused ? <Play aria-hidden="true" className="size-4" /> : <Pause aria-hidden="true" className="size-4" />}
              {access.role !== "owner" ? "Pause · propriétaire" : pauseSending ? "Transmission…" : paused ? "Reprendre" : "Pause générale"}
            </button>
          </div>

          {pauseConfirm && (
            <div role="alert" className="mt-3 flex flex-col gap-3 rounded-xl border border-rose-400/25 bg-rose-400/[0.08] p-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm leading-6 text-rose-100">
                La pause refusera les nouveaux travaux et demandera l’interruption des travaux actifs. Elle n’annule pas une action déjà terminée.
              </p>
              <div className="flex shrink-0 gap-2">
                <button type="button" onClick={() => setPauseConfirm(false)} className={`min-h-11 cursor-pointer rounded-lg border border-white/10 px-4 text-sm font-semibold text-slate-200 hover:bg-white/5 ${focusRing}`}>Annuler</button>
                <button type="button" onClick={togglePause} disabled={pauseSending} className={`min-h-11 cursor-pointer rounded-lg bg-rose-500 px-4 text-sm font-bold text-white hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`}>Confirmer</button>
              </div>
            </div>
          )}

        </div>
      </header>

      <main id="main-content" className="mx-auto w-full max-w-[108rem] px-4 pb-28 pt-6 sm:px-6 md:pb-10 md:pt-8 xl:pl-[17rem] xl:pr-6 xl:py-8">
        {dataSource === "offline" && (
          <div role="status" className="mb-5 rounded-xl border border-amber-400/25 bg-amber-400/[0.08] p-4 text-sm leading-6 text-amber-100">
            <strong className="font-semibold text-amber-300">Données réelles indisponibles.</strong> La base locale ne répond pas : aucune donnée de remplacement n’est affichée et aucune commande ne peut être envoyée.
          </div>
        )}
        {requestError && (
          <div role="alert" className="mb-5 flex items-start gap-3 rounded-xl border border-rose-400/25 bg-rose-400/[0.08] p-4 text-sm leading-6 text-rose-100">
            <AlertCircle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-rose-300" />
            <p className="min-w-0 flex-1">{requestError}</p>
            <button type="button" onClick={() => void loadSnapshot()} className={`min-h-11 shrink-0 cursor-pointer rounded-lg border border-rose-300/25 px-3 font-semibold hover:bg-rose-300/10 ${focusRing}`}>Réessayer</button>
          </div>
        )}
        <section id="integrations" className={`${activeView === "integrations" ? "block" : "hidden"} scroll-mt-24`}>
          <OpsSystemWorkspace />
        </section>

        <section id="health" className={`${activeView === "health" ? "block" : "hidden"} scroll-mt-24`} aria-labelledby="system-health-title">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-300">Santé</p>
              <h1 id="system-health-title" className="mt-2 text-[clamp(1.75rem,1.25rem+2vw,2.75rem)] font-semibold leading-tight tracking-[-0.035em] text-white">
                État du système local
              </h1>
            </div>
            <p className="text-sm text-slate-400">Les indicateurs techniques sont regroupés ici.</p>
          </div>
          <div aria-label="État du système" tabIndex={0} className={`${surface} ops-pulse mt-6 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6`}>
            <HeaderSignal icon={Radio} label="Mode" value={mode} tone="neutral" />
            <HeaderSignal icon={Wifi} label="Flux local" value={connection === "connected" ? "Connecté" : connection === "degraded" ? "Dégradé" : connection === "offline" ? "Hors ligne" : "Connexion…"} tone={connection === "connected" ? "good" : "warn"} />
            <HeaderSignal icon={Clock3} label="Fraîcheur" value={freshness} tone={dataSource === "live" && connection === "connected" ? "good" : "warn"} />
            <HeaderSignal icon={CircleDollarSign} label="Dépense externe" value="£0 / £0" tone="good" />
            <HeaderSignal icon={Cpu} label="Usage modèles" value={`${displayAgents.filter((agent) => agent.state === "working").length} profils actifs`} tone="neutral" />
            <HeaderSignal icon={ShieldCheck} label="Politique" value={paused ? "Pause active" : "Protégé"} tone={paused ? "warn" : "good"} />
          </div>
          <div className={`${surface} mt-5 p-5 md:p-6`}>
            <SectionHeading icon={Gauge} eyebrow="Services essentiels" title={snapshot?.health.codex.status === "connected" && snapshot.health.supervisor.status === "connected" ? "Système stable" : "Attention requise"} id="health-title" />
            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MiniMetric label="Bridge Codex" value={snapshot?.health.bridge.status === "connected" ? "En ligne" : snapshot?.health.bridge.status === "degraded" ? "Dégradé" : "Hors ligne"} tone={snapshot?.health.bridge.status === "connected" ? "good" : "warn"} />
              <MiniMetric label="Base locale" value={dataSource === "live" ? "Disponible" : "Indisponible"} tone={dataSource === "live" ? "good" : "warn"} />
              <MiniMetric label="Travaux incertains" value={String(snapshot?.agents.filter((agent) => agent.status === "uncertain").length ?? 0)} tone={snapshot?.agents.some((agent) => agent.status === "uncertain") ? "warn" : "good"} />
              <MiniMetric label="Décisions ouvertes" value={String(snapshot?.approvals.length ?? 0)} tone={(snapshot?.approvals.length ?? 0) > 0 ? "warn" : "good"} />
            </div>
          </div>
          <div className={`${surface} mt-5 p-5 md:p-6`}>
            <SectionHeading icon={UsersRound} eyebrow="Collaboration LAN" title={`${presence.length} personne${presence.length > 1 ? "s" : ""} en ligne`} id="presence-title" />
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {presence.map((person) => (
                <article key={person.actorId} className="rounded-xl border border-white/[0.07] bg-[#0b1018] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-semibold text-white">{person.actorId === "owner" ? "Propriétaire" : person.actorId}</p>
                    <span className="size-2 rounded-full bg-emerald-400" aria-label="En ligne" />
                  </div>
                  <p className="mt-1 text-xs text-slate-400">{person.role === "owner" ? "Contrôle complet" : "Opérateur"} · {opsViewLabel(person.activeView)}</p>
                </article>
              ))}
              {presence.length === 0 && <p className="text-sm text-slate-400">Aucune présence récente confirmée.</p>}
            </div>
          </div>
          {access.role === "owner" && (
            <div className={`${surface} mt-5 p-5 md:p-6`}>
              <SectionHeading icon={LockKeyhole} eyebrow="Partage sécurisé" title="Accès de l’opérateur" id="operator-access-title" />
              <p className="mt-2 text-sm leading-6 text-slate-400">Ces informations permettent à une personne autorisée de rejoindre Ops sur ton réseau local sans recevoir ton accès propriétaire.</p>
              {!operatorAccess && (
                <button type="button" onClick={() => void revealOperatorAccess()} disabled={operatorAccessLoading} className={`mt-4 min-h-11 cursor-pointer rounded-xl bg-amber-300 px-4 text-sm font-bold text-slate-950 hover:bg-amber-200 disabled:opacity-50 ${focusRing}`}>
                  {operatorAccessLoading ? "Chargement…" : "Afficher l’accès à partager"}
                </button>
              )}
              {operatorAccess?.configured === false && (
                <p className="mt-4 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] p-4 text-sm text-amber-100">Le mode opérateur LAN doit être initialisé puis le serveur web redémarré.</p>
              )}
              {operatorAccess?.configured === true && (
                <div className="mt-4 grid gap-3 lg:grid-cols-3">
                  <AccessValue label="Lien" value={operatorAccess.url} />
                  <AccessValue label="Identifiant" value={operatorAccess.username} />
                  <AccessValue label="Mot de passe" value={operatorAccess.password} secret />
                </div>
              )}
            </div>
          )}
          <div className="mt-5">
            <OpsSystemLogs />
          </div>
        </section>

        <section id="overview" aria-labelledby="overview-title" className={`${activeView === "overview" ? "block" : "hidden"} scroll-mt-24`}>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-300">Vue d’ensemble</p>
              <h1 id="overview-title" className="mt-2 text-[clamp(1.75rem,1.25rem+2vw,2.75rem)] font-semibold leading-tight tracking-[-0.035em] text-white">
                Voici ce qui mérite ton attention.
              </h1>
            </div>
            <p className="flex items-center gap-2 text-sm text-slate-400"><Activity aria-hidden="true" className="size-4 text-emerald-400" /> 12 agents · {workingCount} en cours</p>
          </div>

          <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(22rem,0.65fr)]">
            <OpsCompanySessions />
            <CeoConversationPanel
              messages={messages}
              connection={connection}
              chatScrollRef={chatScrollRef}
              draft={draft}
              onDraftChange={setDraft}
              onSubmit={sendToCeo}
              dataSource={dataSource}
              sendState={sendState}
            />
          </div>

          <div className="mt-5 min-w-0">
            <div className="grid min-w-0 items-start gap-5 xl:grid-cols-2">
              <article className="rounded-2xl border border-amber-400/25 bg-[linear-gradient(135deg,rgba(245,158,11,0.12),rgba(16,21,30,0.92)_55%)] p-5 xl:col-span-2">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-amber-400/15 text-amber-300"><AlertCircle aria-hidden="true" className="size-5" /></span>
                    <div className="min-w-0">
                      <p className="text-xs font-bold uppercase tracking-[0.16em] text-amber-300">{activeApproval ? "Action requise" : "Situation"}</p>
                      <h2 className="mt-1 text-xl font-semibold text-white">{activeApproval ? "Une approbation attend ta décision" : "Aucune décision urgente"}</h2>
                      <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">{activeApproval ? `Demande ${activeApproval.riskClass} de ${activeApproval.requestedByAgentId}, liée à un travail suivi.` : "Le CEO peut poursuivre les travaux actuellement autorisés."}</p>
                    </div>
                  </div>
                  <button type="button" onClick={() => selectView("work", "approvals")} className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl bg-amber-300 px-4 text-sm font-bold text-slate-950 hover:bg-amber-200 ${focusRing}`}>
                    {activeApproval ? "Voir la décision" : "Voir les approbations"} <ArrowUpRight aria-hidden="true" className="size-4" />
                  </button>
                </div>
              </article>

              <section className={`${surface} p-5 md:p-6`} aria-labelledby="priorities-title">
                <SectionHeading icon={ListTodo} eyebrow="Direction" title={`${displayPriorities.length} priorité${displayPriorities.length > 1 ? "s" : ""} du CEO`} id="priorities-title" />
                <ol className="mt-5 divide-y divide-white/[0.07]">
                  {displayPriorities.map((priority, index) => (
                    <li key={priority.id} className="grid min-w-0 gap-2 py-4 first:pt-0 last:pb-0 sm:grid-cols-[2rem_minmax(0,1fr)_auto] sm:items-center">
                      <span className="text-sm font-bold tabular-nums text-slate-600">0{index + 1}</span>
                      <div className="min-w-0">
                        <p className="break-words text-sm font-semibold text-slate-100">{priority.title}</p>
                        <p className="mt-1 text-xs text-slate-400">{priority.owner} · {priority.due}</p>
                      </div>
                      <StateBadge state={priority.state} />
                    </li>
                  ))}
                </ol>
              </section>

              <section className="grid gap-5">
                <div className={`${surface} p-5`}>
                  <SectionHeading icon={Activity} eyebrow="En direct" title="Activité récente" id="activity-title" compact />
                  <ul className="mt-4 space-y-4">
                    {displayActivity.slice(0, 3).map((item) => (
                      <li key={item.id} className="flex gap-3 text-sm">
                        <span className={`mt-2 size-2 shrink-0 rounded-full ${stateMeta[item.state].dot}`} />
                        <div className="min-w-0">
                          <p className="font-semibold text-white">{item.actor}</p>
                          <p className="text-xs text-slate-500">{item.role}</p>
                          <p className="mt-1 break-words leading-5 text-slate-300">{item.summary}</p>
                          {item.detail && <p className="mt-1 line-clamp-2 break-words text-xs leading-5 text-slate-400">{item.detail}</p>}
                          <p className="mt-1 text-xs text-slate-500">{item.time}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              </section>
            </div>

          </div>
        </section>

        <section id="team" className={`${activeView === "team" ? "block" : "hidden"} scroll-mt-24`} aria-labelledby="agents-title">
          <div className={`${surface} p-5 md:p-6`}>
            <SectionHeading icon={UsersRound} eyebrow="Équipe" title="Agents de la société" id="agents-title" trailing={`${workingCount} en cours`} />
            <p className="mt-2 text-sm text-slate-400">Sélectionne un agent pour suivre son activité opérationnelle en direct.</p>
            <div className="mt-5 grid max-h-[calc(100svh-17rem)] grid-cols-[repeat(auto-fit,minmax(min(15rem,100%),1fr))] gap-3 overflow-y-auto overscroll-contain pr-1 [scrollbar-gutter:stable]">
              {displayAgents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  selected={agent.id === selectedAgentId}
                  onSelect={openAgentDetail}
                />
              ))}
            </div>
          </div>
        </section>

        <section id="video" className={`${activeView === "video" ? "block" : "hidden"} scroll-mt-24`}>
          <OpsVideoStudio access={access} />
        </section>

        <div id="work" className={`${activeView === "work" ? "grid" : "hidden"} scroll-mt-24 items-start gap-5 lg:grid-cols-2`}>
          <section className={`${surface} p-5 md:p-6`} aria-labelledby="tasks-title">
            <SectionHeading icon={Workflow} eyebrow="Exécution" title="Travaux" id="tasks-title" trailing={`${displayTasks.length} suivis`} />
            <div className="mt-4 flex flex-wrap gap-2" aria-label="Filtrer les travaux">
              {([
                ["all", "Tous"],
                ["working", "Actifs"],
                ["waiting", "En attente"],
                ["problem", "Problèmes"],
                ["done", "Terminés"],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={taskFilter === value}
                  onClick={() => setTaskFilter(value)}
                  className={`min-h-11 cursor-pointer rounded-lg border px-3 text-xs font-semibold transition-colors ${focusRing} ${taskFilter === value ? "border-amber-300/40 bg-amber-300/10 text-amber-200" : "border-white/10 text-slate-400 hover:bg-white/[0.04] hover:text-white"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="mt-5 max-h-[calc(100svh-22rem)] space-y-3 overflow-y-auto overscroll-contain pr-1 [scrollbar-gutter:stable]">
              {filteredTasks.map((task) => (
                <details key={task.id} className="group rounded-xl border border-white/[0.08] bg-[#0b1018]">
                  <summary className={`flex min-h-14 cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden ${focusRing}`}>
                    <span className={`size-2.5 shrink-0 rounded-full ${stateMeta[task.state].dot}`} />
                    <span className="min-w-0 flex-1"><span className="block break-words text-sm font-semibold text-white">{task.title}</span><span className="text-xs text-slate-500">{task.id} · {task.owner}</span></span>
                    <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-slate-500 transition-transform group-open:rotate-180" />
                  </summary>
                  <div className="border-t border-white/[0.07] px-4 py-4 text-sm leading-6 text-slate-300">
                    <p><span className="text-slate-500">Vérificateur :</span> {task.verifier}</p>
                    <div className={`mt-3 rounded-lg border p-3 ${task.state === "done" ? "border-emerald-400/20 bg-emerald-400/[0.05]" : "border-white/[0.07] bg-white/[0.02]"}`}>
                      <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{task.resultLabel ?? "Résultat"}</p>
                      <p className="mt-1 whitespace-pre-wrap break-words text-slate-300">{task.result}</p>
                    </div>
                  </div>
                </details>
              ))}
              {filteredTasks.length === 0 && (
                <div className="rounded-xl border border-dashed border-white/10 px-4 py-5 text-sm text-slate-400" role="status">
                  Aucun travail dans cette vue. Le filtre peut être changé sans perdre le contexte actuel.
                </div>
              )}
            </div>
          </section>

          <section id="approvals" className={`${surface} scroll-mt-6 p-5 md:p-6`} aria-labelledby="approvals-title">
            <SectionHeading icon={ShieldCheck} eyebrow="Ton autorité" title="Approbations" id="approvals-title" trailing={`${snapshot?.approvals.length ?? 0} ouverte${snapshot?.approvals.length === 1 ? "" : "s"}`} />
            {activeApproval ? (
              <article className="mt-5 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] p-4 md:p-5">
                <p className="text-xs font-bold text-amber-300">{activeApproval.id.slice(0, 8)} · expire {expiryTime(activeApproval.expiresAt, now)}</p>
                <h3 className="mt-2 text-lg font-semibold text-white">Décision {activeApproval.riskClass}</h3>
                <dl className="mt-4 space-y-3 text-sm leading-6">
                  <div><dt className="font-semibold text-slate-200">Travail concerné</dt><dd className="text-slate-400">{snapshot?.tasks.find((task) => task.id === activeApproval.taskId)?.title ?? activeApproval.taskId}</dd></div>
                  <div><dt className="font-semibold text-slate-200">Demandé par</dt><dd className="text-slate-400">{snapshot?.agents.find((agent) => agent.id === activeApproval.requestedByAgentId)?.displayName ?? activeApproval.requestedByAgentId}</dd></div>
                  <div><dt className="font-semibold text-slate-200">Ce qui va se passer</dt><dd className="text-slate-400">{activeApproval.ownerExplanation.willHappen}</dd></div>
                  <div><dt className="font-semibold text-slate-200">Ce qui ne va pas se passer</dt><dd className="text-slate-400">{activeApproval.ownerExplanation.willNotHappen}</dd></div>
                  <div><dt className="font-semibold text-slate-200">Réversibilité</dt><dd className="text-slate-400">{activeApproval.ownerExplanation.reversible}</dd></div>
                  <div><dt className="font-semibold text-slate-200">Si tu refuses</dt><dd className="text-slate-400">{activeApproval.ownerExplanation.refusalEffect}</dd></div>
                </dl>
                <details className="group mt-4 rounded-lg border border-white/10 bg-black/10">
                  <summary className={`flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-xs font-semibold text-slate-400 [&::-webkit-details-marker]:hidden ${focusRing}`}>Détails de vérification <ChevronDown aria-hidden="true" className="ml-auto size-4 transition-transform group-open:rotate-180" /></summary>
                  <dl className="border-t border-white/[0.07] px-3 py-3 text-xs leading-5 text-slate-500">
                    <div><dt className="inline">Empreinte : </dt><dd className="inline break-all font-mono">{activeApproval.actionDigest}</dd></div>
                    <div><dt className="inline">Versions : </dt><dd className="inline">politique {activeApproval.policyVersion}, action {activeApproval.actionVersion}</dd></div>
                  </dl>
                </details>
                <div className="mt-5 grid gap-2 sm:grid-cols-2">
                  <button type="button" onClick={() => void decideApproval(activeApproval, "refused")} disabled={approvalSending === activeApproval.id || access.role !== "owner"} className={`min-h-11 cursor-pointer rounded-xl border border-white/15 px-4 text-sm font-semibold text-slate-200 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`}>Refuser</button>
                  <button type="button" onClick={() => void decideApproval(activeApproval, "approved")} disabled={approvalSending === activeApproval.id || access.role !== "owner"} className={`inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl bg-amber-300 px-4 text-sm font-bold text-slate-950 hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`}><Check aria-hidden="true" className="size-4" /> {access.role !== "owner" ? "Propriétaire requis" : approvalSending === activeApproval.id ? "Transmission…" : "Approuver"}</button>
                </div>
              </article>
            ) : (
              <div role="status" className="mt-5 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.06] p-5">
                <CheckCircle2 aria-hidden="true" className="size-6 text-emerald-400" />
                <p className="mt-3 font-semibold text-white">Aucune approbation en attente.</p>
                <p className="mt-1 text-sm text-slate-400">Les nouvelles demandes apparaîtront ici via le flux temps réel.</p>
              </div>
            )}
          </section>
        </div>

        <section id="orchestrator" className={`${activeView === "team" ? "block" : "hidden"} mt-5 scroll-mt-24`} aria-labelledby="orchestrator-title">
          <div className={`${surface} p-5 md:p-6`}>
            <SectionHeading icon={BrainCircuit} eyebrow="Routage intelligent" title="Orchestrateur de modèles" id="orchestrator-title" trailing="Automatique · v1" />
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-400">Le CEO choisit le résultat attendu et l’agent responsable. L’orchestrateur choisit ensuite le profil le plus adapté selon le risque, la complexité, le contexte, l’urgence et le budget.</p>
            <div className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(min(13rem,100%),1fr))] gap-3">
              {displayModelProfiles.map((profile) => (
                <article key={profile.name} className="rounded-xl border border-white/[0.08] bg-[#0b1018] p-4">
                  <div className="flex items-center justify-between gap-3"><p className="font-semibold text-white">{profile.name}</p><span className="text-sm font-bold tabular-nums text-amber-300">{profile.share}</span></div>
                  <p className="mt-2 text-xs leading-5 text-slate-400">{profile.use}</p>
                  <div className="mt-4 h-1.5 rounded-full bg-white/[0.06]"><div className="h-full rounded-full bg-amber-300" style={{ width: profile.share }} /></div>
                </article>
              ))}
            </div>
            <details className="group mt-4 rounded-xl border border-white/[0.08] bg-[#0b1018]">
              <summary className={`flex min-h-12 cursor-pointer list-none items-center gap-3 px-4 text-sm font-semibold text-slate-200 [&::-webkit-details-marker]:hidden ${focusRing}`}><Route aria-hidden="true" className="size-4 text-amber-300" /><span className="flex-1">Pourquoi le CEO utilise actuellement Expert</span><ChevronDown aria-hidden="true" className="size-4 transition-transform group-open:rotate-180" /></summary>
              <div className="border-t border-white/[0.07] px-4 py-4 text-sm leading-6 text-slate-400">Architecture complexe, risque de reprise élevé et contexte long. Le prochain recours autorisé est Critical avec un vérificateur distinct. Aucun changement automatique n’est permis si l’état d’un travail est incertain.</div>
            </details>
          </div>
        </section>

        <section id="activity" className={`${activeView === "overview" ? "block" : "hidden"} mt-5 scroll-mt-24 pb-[max(1.5rem,env(safe-area-inset-bottom))]`} aria-labelledby="audit-title">
          <details className={`group ${surface}`}>
            <summary className={`flex min-h-14 cursor-pointer list-none items-center gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden ${focusRing}`}>
              <History aria-hidden="true" className="size-4 shrink-0 text-slate-500" />
              <span className="min-w-0 flex-1">
                <span className="block text-[0.68rem] font-bold uppercase tracking-[0.16em] text-slate-500">Traçabilité</span>
                <span id="audit-title" className="mt-1 block text-lg font-semibold text-white">Journal d’activité</span>
              </span>
              <span className="hidden rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-semibold text-slate-400 sm:inline-flex">30 jours</span>
              <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-slate-500 transition-transform group-open:rotate-180" />
            </summary>
            <div className="max-h-[55svh] space-y-1 overflow-y-auto border-t border-white/[0.07] px-5 pb-5 overscroll-contain [scrollbar-gutter:stable]">
              {displayActivity.map((item) => (
                <article key={item.id} className="grid min-w-0 gap-2 border-b border-white/[0.06] py-4 last:border-0 sm:grid-cols-[minmax(0,1fr)_8rem] sm:items-start">
                  <div className="min-w-0">
                    <p className="font-semibold text-white">{item.actor}</p>
                    <p className="text-xs text-slate-500">{item.role}</p>
                    <p className="mt-2 break-words text-sm text-slate-300">{item.summary}</p>
                    {item.detail && <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-slate-400">{item.detail}</p>}
                    <details className="group mt-2">
                      <summary className={`flex min-h-11 cursor-pointer list-none items-center gap-2 text-xs font-semibold text-slate-500 hover:text-slate-300 [&::-webkit-details-marker]:hidden ${focusRing}`}>Détails techniques <ChevronDown aria-hidden="true" className="size-3.5 transition-transform group-open:rotate-180" /></summary>
                      <p className="break-all rounded-lg bg-black/15 px-3 py-2 font-mono text-[0.68rem] text-slate-500">Événement {item.reference ?? item.id}</p>
                    </details>
                  </div>
                  <span className="text-xs text-slate-500 sm:text-right">{item.time}</span>
                </article>
              ))}
              <p className="border-t border-white/[0.07] pt-4 text-sm leading-6 text-slate-500">Le journal ne contient ni devis client, ni adresse email, ni secret, ni raisonnement caché des modèles. Seuls les événements opérationnels structurés et nettoyés sont affichés.</p>
            </div>
          </details>
        </section>
      </main>

      <dialog
        ref={agentDialogRef}
        id="agent-activity-dialog"
        aria-labelledby="agent-activity-title"
        onClose={handleAgentDialogClosed}
        onCancel={(event) => {
          event.preventDefault();
          closeAgentDetail();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeAgentDetail();
        }}
        className="agent-activity-dialog fixed inset-0 m-0 ml-auto h-[100dvh] max-h-none w-full max-w-none border-0 bg-transparent p-0 text-slate-100 backdrop:bg-black/70 backdrop:backdrop-blur-sm lg:inset-y-4 lg:left-auto lg:right-4 lg:h-[calc(100dvh-2rem)] lg:w-[min(31rem,calc(100vw-2rem))]"
      >
        <section className="flex h-full min-h-0 flex-col overflow-hidden border-white/[0.1] bg-[#0d121b] shadow-[-24px_0_80px_rgba(0,0,0,0.5)] lg:rounded-2xl lg:border">
          <header className="shrink-0 border-b border-white/[0.08] px-5 pb-4 pt-[max(1.25rem,env(safe-area-inset-top))] sm:px-6 lg:pt-5">
            <div className="flex items-start gap-3">
              <span className={`relative grid size-11 shrink-0 place-items-center rounded-xl ${selectedPhase === "working" ? "bg-sky-400/15 text-sky-300" : "bg-white/[0.05] text-slate-300"}`}>
                <Bot aria-hidden="true" className="size-5" />
                {selectedPhase === "working" && <span className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-[#0d121b] bg-sky-400" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-slate-500">Activité de l’agent</p>
                <h2 ref={agentDialogHeadingRef} tabIndex={-1} id="agent-activity-title" className="mt-1 break-words text-xl font-semibold text-white outline-none">
                  {selectedAgent?.name ?? "Agent interne"}
                </h2>
                <p className="mt-1 text-sm text-slate-400">{selectedAgent?.role ?? "Équipe interne"}</p>
              </div>
              <button type="button" onClick={closeAgentDetail} aria-label="Fermer l’activité de l’agent" className={`grid size-11 shrink-0 cursor-pointer place-items-center rounded-xl border border-white/10 text-slate-400 hover:bg-white/[0.05] hover:text-white ${focusRing}`}>
                <X aria-hidden="true" className="size-5" />
              </button>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className={`inline-flex min-h-8 items-center gap-2 rounded-full border px-3 text-xs font-semibold ${phaseMeta[selectedPhase].tone}`}>
                <span className={`size-2 rounded-full ${phaseMeta[selectedPhase].dot} ${selectedPhase === "working" ? "agent-live-dot" : ""}`} />
                {phaseMeta[selectedPhase].label}
              </span>
              <span className="inline-flex min-h-8 items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 text-xs text-slate-400">
                <Activity aria-hidden="true" className="size-3.5" />
                {connection === "connected" ? "Actualisation en direct" : "Resynchronisation périodique"}
              </span>
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 [scrollbar-gutter:stable] sm:px-6">
            <dl className="grid grid-cols-2 gap-3">
              <AgentDetailMetric label="Démarré" value={relativeTime(selectedAgentActivity?.startedAt ?? null, now)} />
              <AgentDetailMetric label="Dernier signal" value={relativeTime(selectedAgentActivity?.lastSignalAt ?? null, now)} />
              <AgentDetailMetric label="Profil" value={selectedAgent?.profile ?? "Non attribué"} />
              <AgentDetailMetric label="État" value={selectedAgent ? stateMeta[selectedAgent.state].label : "Indisponible"} />
            </dl>

            <section className="mt-4 rounded-xl border border-sky-400/15 bg-sky-400/[0.035] p-4" aria-label="Progression du travail">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-white">Progression</p>
                <span className="text-sm font-bold tabular-nums text-sky-300">{selectedProgress}%</span>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/[0.07]">
                <div className="h-full rounded-full bg-sky-400 transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${selectedProgress}%` }} />
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-400">{phaseExplanation(selectedPhase)}</p>
            </section>

            <section className="mt-5 rounded-xl border border-white/[0.08] bg-white/[0.025] p-4" aria-labelledby="agent-current-task-title">
              <p className="text-[0.68rem] font-bold uppercase tracking-[0.14em] text-slate-500">Travail actuel</p>
              <h3 id="agent-current-task-title" className="mt-2 break-words text-base font-semibold text-white">
                {selectedAgentActivity?.taskTitle ?? selectedAgent?.task ?? "Aucune tâche active"}
              </h3>
              {selectedAgentActivity?.intendedOutcome && (
                <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-400">{selectedAgentActivity.intendedOutcome}</p>
              )}
            </section>

            {selectedConclusion && (
              <section className="mt-5 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.05] p-4" aria-labelledby="agent-conclusion-title">
                <p className="text-[0.68rem] font-bold uppercase tracking-[0.14em] text-emerald-300">Résultat final</p>
                <h3 id="agent-conclusion-title" className="mt-2 text-base font-semibold text-white">Conclusion de l’agent</h3>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-300">{selectedConclusion}</p>
              </section>
            )}

            <section className="mt-6" aria-labelledby="agent-timeline-title">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[0.68rem] font-bold uppercase tracking-[0.14em] text-sky-300">En direct</p>
                  <h3 id="agent-timeline-title" className="mt-1 text-lg font-semibold text-white">Étapes du travail</h3>
                </div>
                <span className="text-xs tabular-nums text-slate-500">{selectedAgentActivity?.events.length ?? 0}/20</span>
              </div>

              {selectedAgentActivity?.events.length ? (
                <ol className="mt-4 space-y-0" aria-live="polite">
                  {[...selectedAgentActivity.events].reverse().map((event, index) => (
                    <li key={event.id} className="relative grid grid-cols-[1rem_minmax(0,1fr)] gap-3 pb-5 last:pb-0">
                      {index < selectedAgentActivity.events.length - 1 && <span aria-hidden="true" className="absolute bottom-0 left-[0.22rem] top-4 w-px bg-white/10" />}
                      <span aria-hidden="true" className={`relative mt-1 size-2.5 rounded-full ring-4 ring-[#0d121b] ${timelineToneClass(event.tone)}`} />
                      <div className="min-w-0">
                        <p className="break-words text-sm font-semibold text-slate-200">{timelineEventPresentation(event.eventType, event.detail, selectedAgentActivity.taskTitle).title}</p>
                        <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-slate-400 [overflow-wrap:anywhere]">{timelineEventPresentation(event.eventType, event.detail, selectedAgentActivity.taskTitle).explanation}</p>
                        <p className="mt-1 text-xs text-slate-500">{relativeTime(event.occurredAt, now)}</p>
                        <details className="group mt-2">
                          <summary className={`flex min-h-11 cursor-pointer list-none items-center gap-2 text-xs font-semibold text-slate-500 hover:text-slate-300 [&::-webkit-details-marker]:hidden ${focusRing}`}>Détails techniques <ChevronDown aria-hidden="true" className="size-3.5 transition-transform group-open:rotate-180" /></summary>
                          <p className="break-all rounded-lg bg-black/15 px-3 py-2 font-mono text-[0.68rem] text-slate-500">{event.eventType} · {event.sequence}</p>
                        </details>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="mt-4 rounded-xl border border-dashed border-sky-400/20 bg-sky-400/[0.04] p-4 text-sm leading-6 text-slate-400" role="status">
                  {selectedPhase === "working"
                    ? "L’agent travaille dans Codex — aucun nouveau signal opérationnel pour le moment."
                    : "Aucun événement opérationnel récent pour cet agent."}
                </div>
              )}
            </section>

            <p className="mt-6 border-t border-white/[0.07] pt-4 text-xs leading-5 text-slate-500">
              Cette vue exclut les raisonnements internes, les messages bruts, les secrets et les données client.
            </p>
          </div>
        </section>
      </dialog>
    </div>
  );
}

function CommandNavigation({
  activeView,
  connection,
  dataSource,
  onSelect,
  paused,
  pauseSending,
  pauseConfirm,
  onTogglePause,
  onCancelPause,
  access,
  presence,
  project,
}: {
  activeView: OpsView;
  connection: ConnectionState;
  dataSource: DataSource;
  onSelect: (view: OpsView, targetId?: string) => void;
  paused: boolean;
  pauseSending: boolean;
  pauseConfirm: boolean;
  onTogglePause: () => Promise<void>;
  onCancelPause: () => void;
  access: OpsAccess;
  presence: OpsPresence[];
  project: OpsProjectIdentity;
}) {
  const destinations: Array<{ id: OpsView; label: string; icon: LucideIcon }> = [
    { id: "overview", label: "Accueil", icon: LayoutDashboard },
    { id: "work", label: "Travaux", icon: BriefcaseBusiness },
    { id: "team", label: "Équipe", icon: UsersRound },
    { id: "video", label: "Vidéos", icon: Clapperboard },
    { id: "health", label: "Santé", icon: Gauge },
    { id: "integrations", label: "Système", icon: PlugZap },
  ];
  return (
    <nav
      aria-label="Navigation du cockpit"
      className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-white/[0.08] bg-[#0a0e15]/95 px-2 pt-2 backdrop-blur md:sticky md:top-0 md:bottom-auto md:border-b md:border-t-0 md:px-4 md:py-2 xl:fixed xl:inset-y-0 xl:left-0 xl:right-auto xl:flex xl:w-64 xl:flex-col xl:border-b-0 xl:border-r xl:p-4"
    >
      <div className="hidden xl:flex xl:items-center xl:gap-3 xl:px-2 xl:py-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-amber-300/25 bg-amber-300/10 text-amber-200">
          <Bot aria-hidden="true" className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-white">{project.displayName}</p>
          <p className="truncate text-xs text-slate-400">Command Center · Local</p>
        </div>
      </div>
      <div className="grid grid-cols-6 gap-1 md:flex md:justify-center xl:mt-6 xl:flex-col xl:justify-start">
        {destinations.map(({ id, label, icon: Icon }) => {
          const selected = activeView === id;
          return (
            <button
              key={id}
              type="button"
              aria-current={selected ? "page" : undefined}
              onClick={() => onSelect(id)}
              className={`group flex min-h-12 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl px-2 text-[0.7rem] font-semibold transition-colors md:min-w-28 md:flex-row md:gap-2 md:text-sm xl:w-full xl:justify-start xl:px-3 ${focusRing} ${selected ? "bg-amber-300/12 text-amber-200" : "text-slate-500 hover:bg-white/[0.04] hover:text-slate-200"}`}
            >
              <Icon aria-hidden="true" className="size-4" />
              {label}
            </button>
          );
        })}
      </div>
      <div className="mt-auto hidden xl:block">
        <button
          type="button"
          onClick={() => void onTogglePause()}
          disabled={pauseSending || dataSource !== "live" || access.role !== "owner"}
          className={`flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border px-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${focusRing} ${paused ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/15" : "border-rose-400/30 bg-rose-400/10 text-rose-200 hover:bg-rose-400/15"}`}
          aria-pressed={paused}
        >
          {paused ? <Play aria-hidden="true" className="size-4" /> : <Pause aria-hidden="true" className="size-4" />}
          {access.role !== "owner" ? "Pause · propriétaire" : pauseSending ? "Transmission…" : paused ? "Reprendre" : "Pause générale"}
        </button>
        {pauseConfirm && (
          <div role="alert" className="mt-2 rounded-xl border border-rose-400/25 bg-rose-400/[0.08] p-3">
            <p className="text-xs leading-5 text-rose-100">Aucun nouveau travail ne démarrera.</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button type="button" onClick={onCancelPause} className={`min-h-11 cursor-pointer rounded-lg border border-white/10 px-2 text-xs font-semibold text-slate-200 hover:bg-white/5 ${focusRing}`}>Annuler</button>
              <button type="button" onClick={() => void onTogglePause()} disabled={pauseSending} className={`min-h-11 cursor-pointer rounded-lg bg-rose-500 px-2 text-xs font-bold text-white hover:bg-rose-400 disabled:opacity-50 ${focusRing}`}>Confirmer</button>
            </div>
          </div>
        )}
      </div>
      <div className="mt-3 hidden rounded-xl border border-white/[0.07] bg-white/[0.025] p-3 xl:block">
        <p className="text-[0.68rem] font-bold uppercase tracking-[0.14em] text-slate-500">Environnement</p>
        <div className="mt-2 flex items-center justify-between gap-3 text-xs">
          <span className="text-slate-400">{dataSource === "offline" ? "Hors ligne" : `${presence.length || 1} en ligne`}</span>
          <span className={`size-2 rounded-full ${connection === "connected" ? "bg-emerald-400" : "bg-amber-400"}`} aria-hidden="true" />
          <span className="sr-only">{connection === "connected" ? "Connecté" : "Connexion dégradée"}</span>
        </div>
      </div>
    </nav>
  );
}

function CeoConversationPanel({
  messages,
  connection,
  chatScrollRef,
  draft,
  onDraftChange,
  onSubmit,
  dataSource,
  sendState,
}: {
  messages: CeoMessage[];
  connection: ConnectionState;
  chatScrollRef: { current: HTMLDivElement | null };
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  dataSource: DataSource;
  sendState: SendState;
}) {
  return (
    <section id="ceo" className={`${surface} mt-6 flex h-[32rem] min-w-0 flex-col overflow-hidden p-4 md:p-5 xl:h-auto xl:min-h-[28rem] xl:max-h-[32rem] xl:self-stretch`} aria-labelledby="ceo-title">
      <div className="flex shrink-0 items-center gap-3 border-b border-white/[0.08] pb-4">
        <span className="relative grid size-11 shrink-0 place-items-center rounded-xl bg-amber-400/10 text-amber-300">
          <UserRoundCog aria-hidden="true" className="size-5" />
          <span className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-[#10151e] bg-emerald-400" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="ceo-title" className="text-base font-semibold text-white">Conversation avec le CEO</h2>
          <p className="text-xs text-slate-400">Ton interlocuteur principal · {connection === "connected" ? "en ligne" : "connexion dégradée"}</p>
        </div>
        <LockKeyhole aria-label="Conversation privée propriétaire-CEO" className="size-4 text-slate-500" />
      </div>

      <div ref={chatScrollRef} className="my-3 min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-2 [scrollbar-gutter:stable]" aria-live="polite">
        {messages.map((message) => (
          <div key={message.id} className={`flex ${message.author === "Owner" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[96%] rounded-2xl px-4 py-3 text-sm leading-6 ${message.author === "Owner" ? "rounded-br-md bg-amber-300 text-slate-950" : "rounded-bl-md border border-white/[0.08] bg-white/[0.04] text-slate-200"}`}>
              <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.body}</p>
              <p className={`mt-1 text-[0.7rem] ${message.author === "Owner" ? "text-slate-700" : "text-slate-500"}`}>{message.time}{message.status ? ` · ${message.status}` : ""}</p>
            </div>
          </div>
        ))}
      </div>

      <form onSubmit={onSubmit} className="shrink-0 border-t border-white/[0.08] bg-[#10151e] pt-3">
        <label htmlFor="ceo-message" className="text-xs font-semibold text-slate-300">Message au CEO</label>
        <textarea
          id="ceo-message"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          rows={2}
          maxLength={1200}
          placeholder="Donne une priorité ou demande un point de situation…"
          className={`mt-2 w-full resize-y rounded-xl border border-white/10 bg-[#090d14] px-4 py-3 text-base text-white placeholder:text-slate-600 hover:border-white/20 ${focusRing}`}
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-slate-500">{dataSource === "live" ? "Transmission locale sécurisée" : "Envoi désactivé hors connexion"}</p>
          <button type="submit" disabled={!draft.trim() || sendState === "sending" || dataSource !== "live"} className={`inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl bg-white px-4 text-sm font-bold text-slate-950 hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}>
            {sendState === "sending" ? "Envoi…" : "Envoyer au CEO"} <Send aria-hidden="true" className="size-4" />
          </button>
        </div>
      </form>
    </section>
  );
}

function AccessValue({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) {
  const [revealed, setRevealed] = useState(!secret);
  return (
    <div className="min-w-0 rounded-xl border border-white/[0.07] bg-[#0b1018] p-4">
      <p className="text-xs font-semibold text-slate-500">{label}</p>
      <p className="mt-2 break-all font-mono text-sm text-slate-200">{revealed ? value : "••••••••••••••••"}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {secret && (
          <button type="button" onClick={() => setRevealed((current) => !current)} className={`min-h-11 cursor-pointer rounded-lg border border-white/10 px-3 text-xs font-semibold text-slate-300 hover:bg-white/[0.04] ${focusRing}`}>
            {revealed ? "Masquer" : "Afficher"}
          </button>
        )}
        <button type="button" onClick={() => void navigator.clipboard.writeText(value)} className={`min-h-11 cursor-pointer rounded-lg border border-white/10 px-3 text-xs font-semibold text-slate-300 hover:bg-white/[0.04] ${focusRing}`}>
          Copier
        </button>
      </div>
    </div>
  );
}

function HeaderSignal({ icon: Icon, label, value, tone }: { icon: LucideIcon; label: string; value: string; tone: "neutral" | "good" | "warn" }) {
  const color = tone === "good" ? "text-emerald-300" : tone === "warn" ? "text-amber-300" : "text-slate-200";
  return <div className="min-w-0 rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-3"><p className="flex items-center gap-1.5 text-[0.68rem] font-semibold uppercase tracking-wide text-slate-500"><Icon aria-hidden="true" className="size-3.5" />{label}</p><p className={`mt-1 truncate text-xs font-semibold tabular-nums ${color}`}>{value}</p></div>;
}

function SectionHeading({ icon: Icon, eyebrow, title, id, trailing, compact = false }: { icon: LucideIcon; eyebrow: string; title: string; id: string; trailing?: string; compact?: boolean }) {
  return <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="flex items-center gap-2 text-[0.68rem] font-bold uppercase tracking-[0.16em] text-slate-500"><Icon aria-hidden="true" className="size-3.5" />{eyebrow}</p><h2 id={id} className={`mt-1 font-semibold tracking-tight text-white ${compact ? "text-lg" : "text-xl md:text-2xl"}`}>{title}</h2></div>{trailing && <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-semibold text-slate-400">{trailing}</span>}</div>;
}

function StateBadge({ state }: { state: CompanyState }) {
  const meta = stateMeta[state];
  return <span className={`inline-flex min-h-7 w-fit items-center gap-2 rounded-full border px-2.5 text-[0.7rem] font-semibold ${meta.badge}`}><span className={`size-1.5 rounded-full ${meta.dot}`} />{meta.label}</span>;
}

function MiniMetric({ label, value, tone }: { label: string; value: string; tone: "good" | "warn" }) {
  return <div className="min-w-0 rounded-xl border border-white/[0.07] bg-[#0b1018] p-3"><p className="text-xs leading-5 text-slate-500">{label}</p><p className={`mt-1 break-words text-sm font-semibold ${tone === "good" ? "text-emerald-300" : "text-amber-300"}`}>{value}</p></div>;
}

function AgentCard({
  agent,
  selected,
  onSelect,
}: {
  agent: CompanyAgent;
  selected: boolean;
  onSelect: (agentId: string, trigger: HTMLButtonElement) => void;
}) {
  const active = agent.state === "working";
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-controls="agent-activity-dialog"
      aria-pressed={selected}
      aria-label={`Voir l’activité de ${agent.name} — ${stateMeta[agent.state].label}`}
      onClick={(event) => onSelect(agent.id, event.currentTarget)}
      className={`agent-card relative min-h-44 min-w-0 cursor-pointer overflow-clip rounded-xl border p-4 text-left transition-[border-color,background-color,box-shadow,transform] duration-200 active:scale-[0.99] ${focusRing} ${
        active
          ? "agent-card-active border-sky-400/45 bg-[linear-gradient(145deg,rgba(56,189,248,0.12),rgba(11,16,24,0.98)_58%)] shadow-[0_0_0_1px_rgba(56,189,248,0.08),0_14px_45px_rgba(14,165,233,0.12)] hover:border-sky-300/70"
          : "border-white/[0.08] bg-[#0b1018] hover:border-white/20 hover:bg-[#0e141e]"
      }`}
    >
      {active && <span aria-hidden="true" className="agent-card-sheen absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-sky-300 to-transparent" />}
      <div className="flex items-start gap-3">
        <span className={`grid size-10 shrink-0 place-items-center rounded-lg ${active ? "bg-sky-400/15 text-sky-300" : "bg-white/[0.05] text-slate-300"}`}><Bot aria-hidden="true" className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <h3 className="break-words text-sm font-semibold text-white">{agent.name}</h3>
            {active ? (
              <span className="inline-flex min-h-7 items-center gap-2 rounded-full border border-sky-400/30 bg-sky-400/10 px-2.5 text-[0.68rem] font-bold text-sky-200">
                <span className="agent-live-dot size-2 rounded-full bg-sky-400" aria-hidden="true" />
                En cours
              </span>
            ) : (
              <>
                <span className={`size-2 rounded-full ${stateMeta[agent.state].dot}`} aria-hidden="true" />
                <span className="sr-only">{stateMeta[agent.state].label}</span>
              </>
            )}
          </div>
          <p className="mt-0.5 text-xs text-slate-500">{agent.role}</p>
        </div>
      </div>
      <p className="mt-4 break-words text-sm leading-5 text-slate-300">{agent.task}</p>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] pt-3">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-300"><Sparkles aria-hidden="true" className="size-3.5" />{agent.profile}</span>
        <span className="text-xs text-slate-500">{agent.lastProgress}</span>
      </div>
      <span className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-slate-400">
        Voir l’activité <ArrowUpRight aria-hidden="true" className="size-3.5" />
      </span>
    </button>
  );
}

function AgentDetailMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-white/[0.07] bg-white/[0.025] p-3">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-1 break-words text-sm font-semibold text-slate-200">{value}</dd>
    </div>
  );
}

function phaseProgress(phase: AgentActivityDetail["phase"]): number {
  const progress: Record<AgentActivityDetail["phase"], number> = {
    idle: 0,
    preparing: 15,
    dispatching: 30,
    working: 60,
    verification: 85,
    completed: 100,
    problem: 0,
  };
  return progress[phase];
}

function phaseExplanation(phase: AgentActivityDetail["phase"]): string {
  const explanations: Record<AgentActivityDetail["phase"], string> = {
    idle: "Cet agent est disponible et n’a aucun travail actif.",
    preparing: "Le travail est enregistré et ses ressources sont en préparation.",
    dispatching: "La demande est transmise à l’espace de travail de l’agent.",
    working: "L’agent réalise actuellement le travail demandé.",
    verification: "Le résultat est contrôlé avant sa validation finale.",
    completed: "Le travail est terminé et sa conclusion est disponible.",
    problem: "Le travail ne peut pas continuer sans correction ou intervention.",
  };
  return explanations[phase];
}

function timelineEventPresentation(
  eventType: string,
  detail: string | null,
  taskTitle: string | null,
): { title: string; explanation: string } {
  const work = taskTitle ? `« ${taskTitle} »` : "ce travail";
  const presentations: Record<string, { title: string; explanation: string }> = {
    "owner.command.created": {
      title: "Demande reçue",
      explanation: "Le directeur général a reçu la demande du propriétaire et prépare sa répartition.",
    },
    "model.routing.selected": {
      title: "Ressources choisies",
      explanation: `Le niveau de capacité adapté à ${work} a été sélectionné.`,
    },
    "agent.run.started": {
      title: "Travail commencé",
      explanation: `L’agent a réellement commencé ${work}.`,
    },
    "agent.run.completed": {
      title: "Travail terminé",
      explanation: detail ?? `L’agent a terminé ${work}, mais aucune conclusion exploitable n’est disponible.`,
    },
    "agent.run.conclusion.corrected": {
      title: "Conclusion corrigée",
      explanation: detail ?? `La conclusion de ${work} a été corrigée après vérification du livrable.`,
    },
    "agent.run.failed": {
      title: "Travail interrompu",
      explanation: `${work} n’a pas pu être terminé et nécessite une correction.`,
    },
    "agent.run.blocked": {
      title: "Information ou autorisation nécessaire",
      explanation: `${work} est en pause jusqu’à la résolution du blocage.`,
    },
    "agent.run.reconciliation_required": {
      title: "Résultat à confirmer",
      explanation: `Le système demande une vérification humaine avant de confirmer ${work}.`,
    },
    "agent.run.orphaned": {
      title: "Suivi à rétablir",
      explanation: `Le système doit rattacher ${work} à un runtime actif avant de continuer.`,
    },
    "agent.verification.queued": {
      title: "Vérification indépendante demandée",
      explanation: `Un second agent va contrôler le résultat de ${work}.`,
    },
    "approval.approved": {
      title: "Autorisation reçue",
      explanation: "Le propriétaire a autorisé l’étape concernée.",
    },
    "approval.refused": {
      title: "Autorisation refusée",
      explanation: "L’étape concernée ne sera pas exécutée.",
    },
  };
  return presentations[eventType] ?? {
    title: "Suivi mis à jour",
    explanation: `Une nouvelle étape de ${work} a été enregistrée.`,
  };
}

function timelineToneClass(tone: AgentActivityDetail["events"][number]["tone"]): string {
  if (tone === "problem") return "bg-rose-400";
  if (tone === "success") return "bg-emerald-400";
  if (tone === "working") return "bg-sky-400";
  return "bg-slate-400";
}
