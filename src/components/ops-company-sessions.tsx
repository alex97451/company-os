"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  BrainCircuit, CheckCircle2, ChevronRight, CircleStop, FileCheck2, LockKeyhole,
  MessageSquareMore, Pause, Play, RotateCcw, Sparkles, UsersRound,
} from "lucide-react";
import { z } from "zod";
import {
  companySessionsResponseSchema,
  companySessionViewSchema,
  type CompanySessionView,
} from "@/lib/company-sessions/contracts";
import { postOpsJson } from "@/lib/cockpit/client-contracts";

const sessionResponseSchema = z.object({
  session: companySessionViewSchema,
  localOnly: z.literal(true),
  realExecution: z.literal(true),
}).strict();

const ACTIVE_STATES = new Set<CompanySessionView["state"]>([
  "starting", "council", "planning", "executing", "waiting_approval",
  "verifying", "blocked", "paused", "stopping",
]);

const agentLabels: Record<string, { name: string; role: string }> = {
  ceo: { name: "Direction générale", role: "Arbitre les priorités et décide du plan" },
  product: { name: "Produit", role: "Transforme les besoins en priorités utiles" },
  design_conversion: { name: "Design & conversion", role: "Clarifie l’expérience et améliore la conversion" },
  engineering: { name: "Développement full-stack", role: "Construit le SaaS et son infrastructure" },
  qa_safety: { name: "Qualité & sécurité des rapports", role: "Vérifie les résultats avant validation" },
  growth: { name: "Marketing & croissance", role: "Prépare l’acquisition et les expériences" },
  content_brand: { name: "Contenu & marque", role: "Produit les contenus et protège la cohérence" },
  sales_partnerships: { name: "Partenariats", role: "Développe les opportunités commerciales" },
  customer_care: { name: "Expérience client", role: "Améliore le support et les parcours clients" },
  finance_risk: { name: "Finance & risques", role: "Protège la marge, le budget et la solvabilité" },
  reliability_privacy: { name: "Fiabilité & vie privée", role: "Protège les données et la continuité" },
};

const stateLabels: Record<CompanySessionView["state"], string> = {
  starting: "Démarrage confirmé",
  council: "Conseil stratégique en cours",
  planning: "Arbitrage de la direction",
  executing: "Plan en cours d’exécution",
  waiting_approval: "Décision du propriétaire requise",
  verifying: "Livrables en vérification",
  blocked: "Bloquée — intervention requise",
  completed: "Terminée",
  paused: "En pause",
  stopping: "Arrêt en cours de confirmation",
  stopped: "Arrêtée",
  failed: "Échec",
};

const stageOrder: Array<{ id: CompanySessionView["stage"]; label: string }> = [
  { id: "round_1", label: "Propositions" },
  { id: "ceo_synthesis", label: "Synthèse" },
  { id: "round_2", label: "Contre-analyse" },
  { id: "ceo_decision", label: "Décision" },
  { id: "execution", label: "Exécution" },
  { id: "final_report", label: "Rapport final" },
];

export function OpsCompanySessions() {
  const [sessions, setSessions] = useState<CompanySessionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"global" | "targeted">("global");
  const [mission, setMission] = useState("");
  const [expectedOutcome, setExpectedOutcome] = useState("");
  const [ownerFocus, setOwnerFocus] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/ops/sessions", {
        cache: "no-store", credentials: "same-origin", signal,
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(response.status === 401 ? "SESSION_EXPIRED" : "SESSIONS_UNAVAILABLE");
      setSessions(companySessionsResponseSchema.parse(payload).sessions);
      setError(null);
    } catch (cause) {
      if (signal?.aborted) return;
      setError(sessionError(cause));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  const active = useMemo(() => sessions.find((session) => ACTIVE_STATES.has(session.state)) ?? null, [sessions]);
  const selected = active ?? sessions[0] ?? null;

  useEffect(() => {
    const controller = new AbortController();
    const initial = window.setTimeout(() => void load(controller.signal), 0);
    return () => {
      window.clearTimeout(initial);
      controller.abort();
    };
  }, [load]);

  useEffect(() => {
    const interval = window.setInterval(() => void load(), active ? 2_000 : 10_000);
    return () => window.clearInterval(interval);
  }, [active, load]);

  async function start(event: FormEvent) {
    event.preventDefault();
    if ((mode === "targeted" && !mission.trim()) || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await postOpsJson("/api/ops/sessions", {
        mode,
        ...(mode === "targeted" ? {
          mission: mission.trim(),
          ...(expectedOutcome.trim() ? { expectedOutcome: expectedOutcome.trim() } : {}),
        } : {}),
        ...(ownerFocus.trim() ? { ownerFocus: ownerFocus.trim() } : {}),
        maxTasks: 5,
        maxDurationMinutes: 90,
      }, sessionResponseSchema);
      setSessions((current) => [response.session, ...current.filter((item) => item.id !== response.session.id)]);
      setMission("");
      setExpectedOutcome("");
      setOwnerFocus("");
    } catch (cause) {
      setError(sessionError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function control(action: "pause" | "resume" | "stop") {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await postOpsJson(`/api/ops/sessions/${selected.id}/control`, {
        action, expectedVersion: selected.version,
      }, sessionResponseSchema);
      setSessions((current) => current.map((item) => item.id === response.session.id ? response.session : item));
    } catch (cause) {
      setError(sessionError(cause));
      await load();
    } finally {
      setBusy(false);
    }
  }

  const currentStage = selected ? stageOrder.findIndex((stage) => stage.id === selected.stage) : -1;
  const completedContributions = selected?.contributions.filter((item) => item.status === "completed") ?? [];

  return (
    <section className="mt-6 overflow-clip rounded-2xl border border-violet-400/20 bg-[linear-gradient(145deg,rgba(139,92,246,0.10),rgba(16,21,30,0.96)_45%)] shadow-[0_20px_70px_rgba(0,0,0,0.22)]" aria-labelledby="company-session-title">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/[0.07] p-4 md:px-5 md:py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-violet-300/20 bg-violet-300/10 text-violet-200">
            <BrainCircuit aria-hidden="true" className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-violet-300">Pilotage autonome</p>
            <h2 id="company-session-title" className="mt-1 text-xl font-semibold text-white md:text-2xl">Faire avancer l’entreprise avec toute l’équipe</h2>
            <p className="mt-1 max-w-3xl text-sm leading-5 text-slate-400">
              Le CEO consulte les responsables, choisit les priorités et fait vérifier les travaux retenus.
            </p>
          </div>
        </div>
        <span className="inline-flex min-h-9 items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/[0.07] px-3 text-xs font-semibold text-emerald-200">
          <LockKeyhole aria-hidden="true" className="size-3.5" /> Ops local uniquement
        </span>
      </div>

      {error && (
        <div role="alert" className="mx-5 mt-5 rounded-xl border border-rose-400/25 bg-rose-400/[0.08] p-4 text-sm leading-6 text-rose-100 md:mx-6">
          {error}
        </div>
      )}

      {!active && (
        <form onSubmit={start} className="grid gap-4 p-4 md:p-5 lg:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)]">
          <fieldset className="min-w-0">
            <legend className="text-sm font-semibold text-white">Type de session</legend>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <ModeButton
                selected={mode === "global"}
                onClick={() => setMode("global")}
                icon={UsersRound}
                title="Bilan autonome"
                description="Toute l’équipe examine l’existant et propose les prochaines actions pour faire progresser l’entreprise."
              />
              <ModeButton
                selected={mode === "targeted"}
                onClick={() => setMode("targeted")}
                icon={Sparkles}
                title="Mission ciblée"
                description="L’équipe utile est choisie automatiquement à partir de la mission."
              />
            </div>
          </fieldset>
          <div className="min-w-0 space-y-4">
            {mode === "global" ? (
              <>
                <div className="rounded-xl border border-violet-300/20 bg-violet-300/[0.055] p-4">
                  <p className="text-sm font-semibold text-white">Aucune mission à rédiger</p>
                  <p className="mt-1 text-sm leading-5 text-slate-300">
                    État des lieux réel, conseil des 10 responsables, décision du CEO, puis tâches locales vérifiées.
                  </p>
                  <details className="group mt-2">
                    <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-xs font-semibold text-violet-200 [&::-webkit-details-marker]:hidden">
                      Voir le déroulement
                      <ChevronRight aria-hidden="true" className="size-3.5 transition-transform group-open:rotate-90" />
                    </summary>
                    <ol className="grid gap-3 border-t border-white/[0.07] pt-3 sm:grid-cols-3" aria-label="Déroulement du bilan autonome">
                      <ReviewStep icon={BrainCircuit} number="1" title="État des lieux" description="Ce qui existe, fonctionne ou bloque." />
                      <ReviewStep icon={UsersRound} number="2" title="Conseil complet" description="10 responsables discutent avec le CEO." />
                      <ReviewStep icon={FileCheck2} number="3" title="Actions vérifiées" description="Jusqu’à 5 tâches et un rapport final." />
                    </ol>
                  </details>
                </div>
                <label className="block text-sm font-semibold text-white">
                  Point d’attention pour ce bilan <span className="font-normal text-slate-500">(facultatif)</span>
                  <input value={ownerFocus} onChange={(event) => setOwnerFocus(event.target.value)} maxLength={1_000} className="mt-2 min-h-12 w-full rounded-xl border border-white/10 bg-[#090d14] px-4 text-base text-white outline-none placeholder:text-slate-600 focus:border-violet-300 focus:ring-2 focus:ring-violet-300/20" placeholder="Ex. Prioriser ce qui peut améliorer les ventes sans augmenter les risques." />
                </label>
              </>
            ) : (
              <>
                <label className="block text-sm font-semibold text-white">
                  Mission à accomplir
                  <textarea
                    value={mission}
                    onChange={(event) => setMission(event.target.value)}
                    required
                    maxLength={2_000}
                    rows={3}
                    placeholder="Ex. Définir et exécuter la meilleure stratégie pour lancer le SaaS au Royaume-Uni."
                    className="mt-2 min-h-28 w-full resize-y rounded-xl border border-white/10 bg-[#090d14] px-4 py-3 text-base leading-6 text-white outline-none placeholder:text-slate-600 focus:border-violet-300 focus:ring-2 focus:ring-violet-300/20"
                  />
                </label>
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="block text-sm font-semibold text-white">
                    Résultat attendu <span className="font-normal text-slate-500">(facultatif)</span>
                    <input value={expectedOutcome} onChange={(event) => setExpectedOutcome(event.target.value)} maxLength={2_000} className="mt-2 min-h-12 w-full rounded-xl border border-white/10 bg-[#090d14] px-4 text-base text-white outline-none placeholder:text-slate-600 focus:border-violet-300 focus:ring-2 focus:ring-violet-300/20" placeholder="Ex. Un plan priorisé et ses livrables." />
                  </label>
                  <label className="block text-sm font-semibold text-white">
                    Priorité propriétaire <span className="font-normal text-slate-500">(facultatif)</span>
                    <input value={ownerFocus} onChange={(event) => setOwnerFocus(event.target.value)} maxLength={1_000} className="mt-2 min-h-12 w-full rounded-xl border border-white/10 bg-[#090d14] px-4 text-base text-white outline-none placeholder:text-slate-600 focus:border-violet-300 focus:ring-2 focus:ring-violet-300/20" placeholder="Ex. Aller vite sans dette de sécurité." />
                  </label>
                </div>
              </>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs leading-5 text-slate-500">
                {mode === "global" ? "Toute l’équipe + CEO, 2 tours, 5 tâches maximum, 0 € de dépense externe." : "Équipe choisie selon la mission, 2 tours, 5 tâches maximum, 0 € de dépense externe."}
              </p>
              <button disabled={busy || loading || (mode === "targeted" && !mission.trim())} type="submit" className="inline-flex min-h-12 cursor-pointer items-center gap-2 rounded-xl bg-violet-300 px-5 text-sm font-bold text-slate-950 transition-colors hover:bg-violet-200 disabled:cursor-not-allowed disabled:opacity-45">
                <Play aria-hidden="true" className="size-4" /> {busy ? "Démarrage…" : mode === "global" ? "Lancer le bilan autonome" : "Lancer la mission"}
              </button>
            </div>
          </div>
        </form>
      )}

      {selected && (
        <div className="p-5 md:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`inline-flex min-h-8 items-center gap-2 rounded-full border px-3 text-xs font-bold ${statusTone(selected.state)}`}>
                  <span className="size-2 rounded-full bg-current" aria-hidden="true" />
                  {stateLabels[selected.state]}
                </span>
                <span className="text-xs text-slate-500">{selected.mode === "global" ? "Bilan autonome" : "Mission ciblée"}</span>
              </div>
              <h3 className="mt-3 max-w-4xl break-words text-lg font-semibold text-white">{selected.mission}</h3>
            </div>
            {ACTIVE_STATES.has(selected.state) && (
              <div className="flex flex-wrap gap-2">
                {selected.state === "paused" || selected.state === "blocked" ? (
                  <button disabled={busy} onClick={() => void control("resume")} type="button" className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-emerald-300/25 bg-emerald-300/10 px-4 text-sm font-semibold text-emerald-200 hover:bg-emerald-300/15 disabled:opacity-45">
                    <RotateCcw aria-hidden="true" className="size-4" /> Reprendre
                  </button>
                ) : (
                  <button disabled={busy || selected.state === "stopping"} onClick={() => void control("pause")} type="button" className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-white/10 px-4 text-sm font-semibold text-slate-200 hover:bg-white/[0.05] disabled:opacity-45">
                    <Pause aria-hidden="true" className="size-4" /> Pause
                  </button>
                )}
                <button disabled={busy || selected.state === "stopping"} onClick={() => void control("stop")} type="button" className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-rose-300/25 bg-rose-300/[0.06] px-4 text-sm font-semibold text-rose-200 hover:bg-rose-300/10 disabled:opacity-45">
                  <CircleStop aria-hidden="true" className="size-4" /> Arrêter
                </button>
              </div>
            )}
          </div>

          <ol className="mt-6 grid gap-2 sm:grid-cols-3 xl:grid-cols-6" aria-label="Étapes confirmées de la session">
            {stageOrder.map((stage, index) => {
              const confirmed = index < currentStage || selected.state === "completed";
              const current = index === currentStage && selected.state !== "completed";
              return (
                <li key={stage.id} className={`min-w-0 rounded-xl border p-3 ${confirmed ? "border-emerald-400/20 bg-emerald-400/[0.05]" : current ? "border-violet-300/30 bg-violet-300/[0.08]" : "border-white/[0.07] bg-black/10"}`}>
                  <p className="flex items-center gap-2 text-xs font-semibold">
                    {confirmed ? <CheckCircle2 aria-hidden="true" className="size-4 shrink-0 text-emerald-300" /> : <span className={`size-2 shrink-0 rounded-full ${current ? "bg-violet-300" : "bg-slate-700"}`} />}
                    <span className={confirmed ? "text-emerald-200" : current ? "text-violet-200" : "text-slate-500"}>{stage.label}</span>
                  </p>
                </li>
              );
            })}
          </ol>

          <div className="mt-6 grid min-w-0 gap-5 xl:grid-cols-[minmax(16rem,0.65fr)_minmax(0,1.35fr)]">
            <section className="min-w-0 rounded-xl border border-white/[0.07] bg-black/10 p-4" aria-labelledby="session-team-title">
              <h4 id="session-team-title" className="flex items-center gap-2 text-sm font-semibold text-white"><UsersRound aria-hidden="true" className="size-4 text-violet-300" /> Équipe mobilisée</h4>
              <ul className="mt-4 space-y-3">
                {selected.participants.map((participant) => {
                  const label = agentLabels[participant.agentId] ?? { name: participant.agentId, role: "Agent interne" };
                  return (
                    <li key={participant.agentId} className="flex min-w-0 items-start gap-3">
                      <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${participant.status === "working" ? "bg-sky-400 ring-4 ring-sky-400/10" : participant.status === "contributed" ? "bg-emerald-400" : "bg-slate-600"}`} />
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-200">{label.name}</p>
                        <p className="mt-0.5 text-xs leading-5 text-slate-500">{label.role}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>

            <section className="min-w-0 rounded-xl border border-white/[0.07] bg-black/10 p-4" aria-labelledby="session-discussion-title">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 id="session-discussion-title" className="flex items-center gap-2 text-sm font-semibold text-white"><MessageSquareMore aria-hidden="true" className="size-4 text-violet-300" /> Discussion stratégique</h4>
                <span className="text-xs text-slate-500">{completedContributions.length} contribution{completedContributions.length > 1 ? "s" : ""} confirmée{completedContributions.length > 1 ? "s" : ""}</span>
              </div>
              {completedContributions.length ? (
                <ol className="mt-4 max-h-[32rem] space-y-3 overflow-y-auto pr-1" aria-live="polite">
                  {completedContributions.map((contribution) => {
                    const label = agentLabels[contribution.authorAgentId] ?? { name: contribution.authorAgentId, role: "Agent interne" };
                    return (
                      <li key={contribution.id} className="rounded-xl border border-white/[0.07] bg-[#0c1119] p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm font-semibold text-white">{label.name}</p>
                          <span className="text-xs text-slate-500">Tour {contribution.round} · {contribution.kind === "objection" ? "contre-analyse" : contribution.kind.includes("ceo") ? "arbitrage" : "proposition"}</span>
                        </div>
                        <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-300 [overflow-wrap:anywhere]">{contribution.body}</p>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <div className="mt-4 rounded-xl border border-dashed border-violet-300/20 bg-violet-300/[0.035] p-4 text-sm leading-6 text-slate-400">
                  Les contributions apparaîtront ici dès que les agents auront réellement terminé leur tour.
                </div>
              )}
            </section>
          </div>

          {selected.deliverables.length > 0 && (
            <section className="mt-5 rounded-xl border border-emerald-400/15 bg-emerald-400/[0.035] p-4" aria-labelledby="session-deliverables-title">
              <h4 id="session-deliverables-title" className="flex items-center gap-2 text-sm font-semibold text-white"><FileCheck2 aria-hidden="true" className="size-4 text-emerald-300" /> Livrables</h4>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {selected.deliverables.map((deliverable) => (
                  <article key={deliverable.id} className="min-w-0 rounded-xl border border-white/[0.07] bg-[#0c1119] p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h5 className="min-w-0 break-words text-sm font-semibold text-white">{deliverable.title}</h5>
                      <span className="rounded-full border border-emerald-400/20 bg-emerald-400/[0.07] px-2.5 py-1 text-[0.68rem] font-bold text-emerald-200">{deliverable.status === "verified" ? "Vérifié" : deliverable.status === "blocked" ? "Bloqué" : "Prêt"}</span>
                    </div>
                    <p className="mt-2 line-clamp-4 whitespace-pre-wrap break-words text-sm leading-6 text-slate-400">{deliverable.summary}</p>
                    {deliverable.relativePath && <p className="mt-3 break-all font-mono text-xs text-slate-500">{deliverable.relativePath}</p>}
                  </article>
                ))}
              </div>
            </section>
          )}

          {selected.finalReport && (
            <details className="group mt-5 rounded-xl border border-violet-300/20 bg-violet-300/[0.035]" open>
              <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold text-white [&::-webkit-details-marker]:hidden">
                <FileCheck2 aria-hidden="true" className="size-4 text-violet-300" /> Rapport final
              </summary>
              <pre className="max-h-[34rem] overflow-auto whitespace-pre-wrap break-words border-t border-white/[0.07] p-4 font-sans text-sm leading-6 text-slate-300 [overflow-wrap:anywhere]">{selected.finalReport}</pre>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

function ModeButton({
  selected, onClick, icon: Icon, title, description,
}: {
  selected: boolean;
  onClick: () => void;
  icon: typeof UsersRound;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`min-h-20 cursor-pointer rounded-xl border p-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 ${selected ? "border-violet-300/40 bg-violet-300/10" : "border-white/[0.08] bg-black/10 hover:border-white/20"}`}
    >
      <span className="flex items-center gap-2 text-sm font-semibold text-white"><Icon aria-hidden="true" className="size-4 text-violet-300" /> {title}</span>
      <span className="mt-2 block text-xs leading-5 text-slate-400">{description}</span>
    </button>
  );
}

function ReviewStep({
  icon: Icon, number, title, description,
}: {
  icon: typeof UsersRound;
  number: string;
  title: string;
  description: string;
}) {
  return (
    <li className="min-w-0 rounded-lg border border-white/[0.07] bg-black/10 p-3">
      <div className="flex items-center gap-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-violet-300/10 text-xs font-bold text-violet-200">{number}</span>
        <Icon aria-hidden="true" className="size-4 shrink-0 text-violet-300" />
      </div>
      <p className="mt-3 text-xs font-semibold text-white">{title}</p>
      <p className="mt-1 text-xs leading-5 text-slate-400">{description}</p>
    </li>
  );
}

function statusTone(state: CompanySessionView["state"]): string {
  if (state === "completed") return "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-200";
  if (state === "blocked" || state === "failed") return "border-rose-400/25 bg-rose-400/[0.08] text-rose-200";
  if (state === "paused" || state === "stopping" || state === "waiting_approval") return "border-amber-400/25 bg-amber-400/[0.08] text-amber-200";
  return "border-violet-300/25 bg-violet-300/[0.08] text-violet-200";
}

function sessionError(error: unknown): string {
  const code = error instanceof Error ? error.message : "SESSIONS_UNAVAILABLE";
  const messages: Record<string, string> = {
    SESSION_EXPIRED: "La session propriétaire a expiré. Reconnecte-toi à Ops.",
    SESSIONS_UNAVAILABLE: "Les sessions autonomes ne sont pas accessibles dans la base locale.",
    REQUEST_FAILED: "La commande locale a échoué. Aucun travail externe n’a été lancé.",
    STALE_STATE: "La session a changé entre-temps. Les données ont été actualisées.",
    COMPANY_SESSION_ALREADY_ACTIVE: "Une session est déjà active pour ce projet. Termine-la ou arrête-la avant d’en lancer une autre.",
    COMPANY_SESSION_REAL_CODEX_REQUIRED: "Le pont Codex réel doit être actif. Le mode démo n’est pas accepté pour une session autonome.",
    COMPANY_SESSION_RUNTIME_NOT_READY: "Le superviseur ou le pont Codex local n’est pas prêt. Vérifie l’état du système puis réessaie.",
    COMPANY_SESSION_COCKPIT_PAUSED: "L’entreprise est actuellement en pause générale.",
  };
  return messages[code] ?? "La session n’a pas pu être modifiée. Aucun statut simulé n’a été créé.";
}
