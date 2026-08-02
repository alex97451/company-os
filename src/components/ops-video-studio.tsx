"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Clapperboard, Copy, Download, Film, LoaderCircle, PlayCircle, ShieldCheck, Sparkles, XCircle } from "lucide-react";
import { postOpsJson, type OpsAccess } from "@/lib/cockpit/client-contracts";
import { videoJobResponseSchema, videoJobsResponseSchema, type VideoJob } from "@/lib/videos/contracts";

const surface = "rounded-2xl border border-white/[0.08] bg-[#10151e] shadow-[0_20px_70px_rgba(0,0,0,0.22)]";
const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#090c12]";

const stateLabels: Record<VideoJob["state"], string> = {
  queued: "En attente",
  briefing: "Brief en cours",
  voice: "Voix locale",
  rendering: "Rendu vidéo",
  quality_check: "Contrôle qualité",
  completed: "Prête",
  failed: "Échec",
  cancelled: "Annulée",
};

export function OpsVideoStudio({ access }: { access: OpsAccess }) {
  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [language, setLanguage] = useState<"fr" | "en">("fr");
  const [goal, setGoal] = useState<"awareness" | "education" | "conversion">("awareness");
  const [template, setTemplate] = useState<"problem_reveal_solution" | "quick_list" | "before_after">("problem_reveal_solution");
  const [durationSeconds, setDurationSeconds] = useState(30);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/ops/videos", { credentials: "same-origin", cache: "no-store" });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error("VIDEO_LIST_FAILED");
      const parsed = videoJobsResponseSchema.parse(payload);
      setJobs(parsed.jobs);
      setSelectedId((current) => current && parsed.jobs.some((job) => job.id === current) ? current : parsed.jobs[0]?.id ?? null);
      setNotice(null);
    } catch {
      setNotice("Le Studio vidéo ne répond pas encore. Vérifie que le projet et son worker vidéo sont démarrés.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 1_500);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refresh]);

  const selected = useMemo(() => jobs.find((job) => job.id === selectedId) ?? null, [jobs, selectedId]);
  const active = jobs.some((job) => ["queued", "briefing", "voice", "rendering", "quality_check"].includes(job.state));

  async function create(event: FormEvent) {
    event.preventDefault();
    if (sending || subject.trim().length < 3) return;
    setSending(true);
    setNotice(null);
    try {
      const result = await postOpsJson("/api/ops/videos", { subject, language, goal, template, durationSeconds }, videoJobResponseSchema);
      setJobs((current) => [result.job, ...current.filter((job) => job.id !== result.job.id)]);
      setSelectedId(result.job.id);
      setSubject("");
    } catch (error) {
      setNotice(videoErrorMessage(error));
    } finally {
      setSending(false);
    }
  }

  async function cancel(job: VideoJob) {
    setSending(true);
    try {
      const result = await postOpsJson(`/api/ops/videos/${job.id}/control`, { action: "cancel" }, videoJobResponseSchema);
      setJobs((current) => current.map((entry) => entry.id === result.job.id ? result.job : entry));
    } catch (error) {
      setNotice(videoErrorMessage(error));
    } finally {
      setSending(false);
    }
  }

  async function retry(job: VideoJob) {
    setSending(true);
    setNotice(null);
    try {
      const result = await postOpsJson(`/api/ops/videos/${job.id}/control`, { action: "retry" }, videoJobResponseSchema);
      setJobs((current) => current.map((entry) => entry.id === result.job.id ? result.job : entry));
    } catch (error) {
      setNotice(videoErrorMessage(error));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="grid min-h-0 gap-5 xl:grid-cols-[minmax(19rem,0.78fr)_minmax(24rem,1.22fr)]">
      <section className={`${surface} min-w-0 p-5 md:p-6`} aria-labelledby="video-create-title">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-amber-300/10 text-amber-200"><Clapperboard aria-hidden="true" className="size-5" /></span>
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-300">À la demande</p>
            <h1 id="video-create-title" className="mt-1 text-2xl font-semibold text-white">Studio vidéo</h1>
            <p className="mt-2 text-sm leading-6 text-slate-400">L’agent prépare puis Remotion fabrique un vrai MP4 vertical. Rien n’est publié automatiquement.</p>
          </div>
        </div>

        <form onSubmit={create} className="mt-6 space-y-4">
          <label className="block text-sm font-semibold text-slate-200">Sujet de la vidéo
            <textarea value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={2_000} rows={4} placeholder="Ex. Montrer pourquoi il faut vérifier un devis avant de payer l’acompte…" className={`mt-2 w-full resize-y rounded-xl border border-white/10 bg-[#090d14] px-4 py-3 text-sm leading-6 text-white placeholder:text-slate-600 ${focusRing}`} />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Langue"><select value={language} onChange={(event) => setLanguage(event.target.value as "fr" | "en")} className={inputClass}><option value="fr">Français</option><option value="en">Anglais</option></select></Field>
            <Field label="Durée"><select value={durationSeconds} onChange={(event) => setDurationSeconds(Number(event.target.value))} className={inputClass}><option value={15}>15 secondes</option><option value={30}>30 secondes</option><option value={45}>45 secondes</option><option value={60}>60 secondes</option></select></Field>
            <Field label="Objectif"><select value={goal} onChange={(event) => setGoal(event.target.value as typeof goal)} className={inputClass}><option value="awareness">Faire connaître</option><option value="education">Expliquer</option><option value="conversion">Faire agir</option></select></Field>
            <Field label="Structure"><select value={template} onChange={(event) => setTemplate(event.target.value as typeof template)} className={inputClass}><option value="problem_reveal_solution">Problème → solution</option><option value="quick_list">Liste rapide</option><option value="before_after">Avant / après</option></select></Field>
          </div>
          {notice && <p role="alert" className="rounded-xl border border-rose-400/25 bg-rose-400/[0.07] px-4 py-3 text-sm leading-5 text-rose-100">{notice}</p>}
          <button type="submit" disabled={sending || active || access.role !== "owner" || subject.trim().length < 3} className={`inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-amber-300 px-4 text-sm font-bold text-slate-950 transition-colors hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-45 ${focusRing}`}>
            {sending ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <Sparkles aria-hidden="true" className="size-4" />}
            {access.role !== "owner" ? "Création réservée au propriétaire" : active ? "Une vidéo est déjà en production" : "Créer la vidéo"}
          </button>
        </form>

        <div className="mt-6 border-t border-white/[0.07] pt-5">
          <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-semibold text-white">Historique</h2><span className="text-xs text-slate-500">{jobs.length} vidéo{jobs.length > 1 ? "s" : ""}</span></div>
          <div className="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
            {loading ? <p className="text-sm text-slate-500">Chargement réel…</p> : jobs.length === 0 ? <p className="rounded-xl border border-dashed border-white/10 p-4 text-sm leading-6 text-slate-500">Aucune vidéo pour ce projet. La première apparaîtra ici dès son lancement.</p> : jobs.map((job) => (
              <button key={job.id} type="button" onClick={() => setSelectedId(job.id)} className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${focusRing} ${selectedId === job.id ? "border-amber-300/35 bg-amber-300/[0.06]" : "border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.04]"}`}>
                <span className="flex items-center justify-between gap-3"><strong className="line-clamp-1 text-sm text-white">{job.subject}</strong><span className={`shrink-0 text-xs font-semibold ${job.state === "completed" ? "text-emerald-300" : job.state === "failed" ? "text-rose-300" : "text-sky-300"}`}>{stateLabels[job.state]}</span></span>
                <span className="mt-1 block text-xs text-slate-500">{job.durationSeconds} s · {job.language.toUpperCase()} · {new Date(job.createdAt).toLocaleString("fr-FR")}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className={`${surface} min-w-0 overflow-hidden p-5 md:p-6`} aria-labelledby="video-preview-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="text-xs font-bold uppercase tracking-[0.18em] text-sky-300">Aperçu privé</p><h2 id="video-preview-title" className="mt-1 text-xl font-semibold text-white">Regarder le résultat</h2></div>
          {selected && <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-slate-300">{stateLabels[selected.state]}</span>}
        </div>
        {!selected ? (
          <div className="mt-6 grid min-h-[32rem] place-items-center rounded-2xl border border-dashed border-white/10 bg-[#080c12] p-8 text-center"><div><Film aria-hidden="true" className="mx-auto size-10 text-slate-600" /><p className="mt-4 text-sm text-slate-400">Sélectionne une vidéo ou lance une nouvelle production.</p></div></div>
        ) : (
          <div className="mt-5 grid items-start gap-5 lg:grid-cols-[minmax(15rem,0.82fr)_minmax(16rem,1fr)]">
            <div className="mx-auto w-full max-w-[21rem] overflow-hidden rounded-[1.75rem] border border-white/10 bg-black shadow-[0_30px_80px_rgba(0,0,0,.45)]" style={{ aspectRatio: "9 / 16" }}>
              {selected.state === "completed" ? (
                <video key={selected.updatedAt} controls playsInline preload="metadata" poster={`/api/ops/videos/${selected.id}/media/thumbnail`} className="h-full w-full object-contain" aria-label={`Vidéo terminée : ${selected.subject}`}>
                  <source src={`/api/ops/videos/${selected.id}/media/video`} type="video/mp4" />
                </video>
              ) : (
                <div className="flex h-full flex-col items-center justify-center px-8 text-center">
                  {selected.state === "failed" || selected.state === "cancelled" ? <XCircle aria-hidden="true" className="size-11 text-rose-300" /> : <PlayCircle aria-hidden="true" className="size-11 text-sky-300" />}
                  <p className="mt-5 text-lg font-semibold text-white">{selected.stageLabel}</p>
                  <p className="mt-2 text-sm leading-6 text-slate-500">{selected.state === "failed" ? `Code : ${selected.errorCode ?? "VIDEO_FAILED"}` : "Le lecteur apparaîtra uniquement quand le MP4 aura réussi tous les contrôles."}</p>
                </div>
              )}
            </div>
            <div className="min-w-0 space-y-4">
              <div>
                <div className="flex items-center justify-between gap-3 text-xs"><span className="font-semibold text-slate-300">Progression réelle</span><strong className="tabular-nums text-sky-300">{selected.progress} %</strong></div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/[0.08]"><div className="h-full rounded-full bg-gradient-to-r from-sky-400 to-amber-300 transition-[width] duration-500" style={{ width: `${selected.progress}%` }} /></div>
                <p className="mt-2 text-sm leading-5 text-slate-400">{selected.stageLabel}</p>
              </div>
              {selected.selectedHook && <Info title="Accroche retenue" text={selected.selectedHook} />}
              {selected.heuristicScore !== null && <div className="rounded-xl border border-amber-300/15 bg-amber-300/[0.04] p-4"><p className="text-xs font-bold uppercase tracking-wide text-amber-300">Potentiel estimé</p><p className="mt-1 text-2xl font-semibold text-white">{selected.heuristicScore}/100</p><p className="mt-1 text-xs leading-5 text-slate-500">Heuristique de clarté, accroche et rythme — aucune viralité n’est garantie.</p></div>}
              {selected.qualityReport && <div className="rounded-xl border border-emerald-400/15 bg-emerald-400/[0.04] p-4"><p className="flex items-center gap-2 text-sm font-semibold text-emerald-200"><ShieldCheck aria-hidden="true" className="size-4" /> Contrôle qualité réussi</p><ul className="mt-3 space-y-2">{selected.qualityReport.checks.map((check) => <li key={check.id} className="flex gap-2 text-xs leading-5 text-slate-400"><CheckCircle2 aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-emerald-400" /><span><strong className="text-slate-300">{check.label}</strong> · {check.detail}</span></li>)}</ul></div>}
              {selected.caption && <div className="rounded-xl border border-white/[0.08] bg-white/[0.025] p-4"><div className="flex items-center justify-between gap-3"><p className="text-sm font-semibold text-white">Légende prête</p><button type="button" onClick={() => void navigator.clipboard.writeText(`${selected.caption}\n\n${selected.hashtags.join(" ")}`)} className={`inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-white/10 px-2.5 text-xs text-slate-300 hover:bg-white/5 ${focusRing}`}><Copy aria-hidden="true" className="size-3.5" /> Copier</button></div><p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-400">{selected.caption}</p><p className="mt-2 break-words text-xs leading-5 text-sky-300">{selected.hashtags.join(" ")}</p></div>}
              <div className="grid gap-2 sm:grid-cols-2">
                {selected.hasVideo && <a href={`/api/ops/videos/${selected.id}/media/video?download=1`} className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-white px-3 text-sm font-bold text-slate-950 hover:bg-slate-200 ${focusRing}`}><Download aria-hidden="true" className="size-4" /> Télécharger MP4</a>}
                {selected.hasThumbnail && <a href={`/api/ops/videos/${selected.id}/media/thumbnail?download=1`} className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/10 px-3 text-sm font-semibold text-slate-200 hover:bg-white/5 ${focusRing}`}><Download aria-hidden="true" className="size-4" /> Miniature</a>}
                {["queued", "briefing", "voice", "rendering", "quality_check"].includes(selected.state) && access.role === "owner" && <button type="button" onClick={() => void cancel(selected)} disabled={sending} className={`min-h-11 rounded-xl border border-rose-400/25 px-3 text-sm font-semibold text-rose-200 hover:bg-rose-400/[0.06] disabled:opacity-50 sm:col-span-2 ${focusRing}`}>Annuler la production</button>}
                {selected.state === "failed" && selected.canRetry && access.role === "owner" && <button type="button" onClick={() => void retry(selected)} disabled={sending} className={`min-h-11 rounded-xl bg-amber-300 px-3 text-sm font-bold text-slate-950 hover:bg-amber-200 disabled:opacity-50 sm:col-span-2 ${focusRing}`}>Relancer cette production</button>}
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

const inputClass = `mt-2 min-h-11 w-full rounded-xl border border-white/10 bg-[#090d14] px-3 text-sm text-white ${focusRing}`;
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="text-sm font-semibold text-slate-200">{label}{children}</label>; }
function Info({ title, text }: { title: string; text: string }) { return <div className="rounded-xl border border-sky-400/15 bg-sky-400/[0.04] p-4"><p className="text-xs font-bold uppercase tracking-wide text-sky-300">{title}</p><p className="mt-2 text-base font-semibold leading-6 text-white">{text}</p></div>; }
function videoErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : "VIDEO_CREATE_FAILED";
  if (code === "VIDEO_JOB_ALREADY_ACTIVE") return "Une vidéo est déjà en production pour ce projet.";
  if (code === "ACTIVE_AGENT_INSTANCE_REQUIRED") return "L’agent vidéo n’est pas encore connecté. Redémarre le runtime de ce projet.";
  if (code === "OWNER_ROLE_REQUIRED") return "Seul le propriétaire peut lancer une vidéo.";
  return `La demande n’a pas démarré (${code}).`;
}
