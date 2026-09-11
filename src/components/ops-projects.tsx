"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { Boxes, CheckCircle2, ClipboardCheck, ExternalLink, FolderLock, LoaderCircle, Play, Plus, Radio, Server, Square, Trash2, TriangleAlert } from "lucide-react";

type ProjectStatus = "registered" | "online" | "offline" | "blocked" | "error";
type ProjectKind = "saas" | "web_app" | "api" | "library" | "generic";
type ProjectDiscovery = {
  version: 1;
  analyzedAt: string;
  canonicalPath: string;
  existingProjectId: string | null;
  writable: true;
  technologies: string[];
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "none";
  scripts: string[];
  documentation: { readme: boolean; agentInstructions: boolean; docsDirectory: boolean; markdownFiles: number };
  git: { state: "clean" | "changes" | "not_repository" | "unavailable"; branch: string | null; changedFiles: number };
  suggestedKind: ProjectKind;
  commands: { verify: string; start: string; stop: string };
};
type ProjectInitialization = {
  version: 1;
  state: "validated" | "starting" | "ready" | "error";
  updatedAt: string;
  steps: Array<{
    id: "folder_check" | "workspace_analysis" | "local_files" | "database" | "storage" | "team" | "cockpit";
    status: "pending" | "active" | "complete" | "error";
    message: string;
  }>;
};
type ProjectInitialReviewBasis = "technologies" | "commands" | "documentation" | "git" | "operational_readiness";
type ProjectInitialReview = {
  version: 1;
  state: "queued" | "running" | "completed" | "error";
  commandId: string | null;
  triggeredAt: string;
  updatedAt: string;
  completedAt: string | null;
  conclusion: string | null;
  limits: string[];
  priorities: Array<{
    id: "P1" | "P2" | "P3";
    title: string;
    observation: string;
    basis: ProjectInitialReviewBasis[];
    acceptanceCriteria: string[];
  }>;
  errorCode: string | null;
};
type Project = {
  id: string;
  displayName: string;
  kind: ProjectKind;
  workspacePath: string | null;
  isolationMode: "dedicated_runtime";
  status: ProjectStatus;
  current: boolean;
  lastHeartbeatAt: string | null;
  lastErrorCode: string | null;
  runtimeState: "starting" | "online" | "stopping" | "offline" | "error" | null;
  webPort: number | null;
  cockpitUrl: string | null;
  initializedAt: string | null;
  discovery: ProjectDiscovery | null;
  initialization: ProjectInitialization | null;
  initialReview: ProjectInitialReview | null;
};

const statusMeta: Record<ProjectStatus, { label: string; className: string }> = {
  online: { label: "En ligne", className: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200" },
  registered: { label: "Enregistré", className: "border-sky-400/25 bg-sky-400/10 text-sky-200" },
  offline: { label: "Hors ligne", className: "border-slate-500/25 bg-slate-500/10 text-slate-300" },
  blocked: { label: "Bloqué", className: "border-amber-400/25 bg-amber-400/10 text-amber-200" },
  error: { label: "Erreur", className: "border-rose-400/25 bg-rose-400/10 text-rose-200" },
};

export function OpsProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [allowedRoots, setAllowedRoots] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<{ requestedPath: string; discovery: ProjectDiscovery } | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/ops/projects", { cache: "no-store" });
      const data = await response.json() as { projects?: Project[]; policy?: { allowedRoots?: string[] }; error?: string };
      if (!response.ok || !data.projects) throw new Error(data.error ?? "PROJECTS_UNAVAILABLE");
      setProjects(data.projects);
      setAllowedRoots(data.policy?.allowedRoots ?? []);
      setNotice(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "PROJECTS_UNAVAILABLE");
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const polling = window.setInterval(() => void load(), 5_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(polling);
    };
  }, [load]);

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const workspacePath = String(form.get("workspacePath") ?? "");
    setBusy(true);
    setNotice(null);
    try {
      if (!preflight || preflight.requestedPath !== workspacePath) {
        const response = await fetch("/api/ops/projects/preflight", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-company-os-csrf": readCookie("company_os_ops_csrf") },
          body: JSON.stringify({ workspacePath }),
        });
        const data = await response.json() as { discovery?: ProjectDiscovery; error?: string };
        if (!response.ok || !data.discovery) throw new Error(data.error ?? "PROJECT_PREFLIGHT_FAILED");
        setPreflight({ requestedPath: workspacePath, discovery: data.discovery });
        setNotice("Analyse terminée sans modifier le dossier. Vérifie le résumé puis confirme l’initialisation.");
        return;
      }
      const response = await fetch("/api/ops/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-company-os-csrf": readCookie("company_os_ops_csrf") },
        body: JSON.stringify({
          id: String(form.get("id") ?? ""),
          displayName: String(form.get("displayName") ?? ""),
          kind: String(form.get("kind") ?? "generic"),
          workspacePath,
        }),
      });
      const data = await response.json() as { error?: string; issues?: Array<{ path?: Array<string | number> }> };
      if (!response.ok) {
        const invalidField = data.issues?.[0]?.path?.[0];
        throw new Error(invalidField ? `INVALID_INPUT_${String(invalidField).toUpperCase()}` : (data.error ?? "PROJECT_REGISTER_FAILED"));
      }
      event.currentTarget.reset();
      setPreflight(null);
      setNotice("Le dossier est préparé. Ops affiche maintenant chaque ressource réellement vérifiée jusqu’au démarrage du cockpit.");
      await load();
    } catch (error) {
      setNotice(projectErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function changeRuntime(project: Project, action: "start" | "stop") {
    setBusy(true);
    setNotice(action === "start" ? "Initialisation et démarrage en cours…" : "Arrêt du runtime en cours…");
    try {
      const response = await fetch(`/api/ops/projects/${encodeURIComponent(project.id)}/runtime`, {
        method: action === "start" ? "POST" : "DELETE",
        headers: { "x-company-os-csrf": readCookie("company_os_ops_csrf") },
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? `PROJECT_RUNTIME_${action.toUpperCase()}_FAILED`);
      setNotice(action === "start"
        ? `${project.displayName} est préparé. Le runtime confirme maintenant son démarrage.`
        : `${project.displayName} est arrêté.`);
      await load();
    } catch (error) {
      setNotice(projectErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(project: Project) {
    if (!window.confirm(`Retirer ${project.displayName} du registre ? Aucun fichier du projet ne sera supprimé.`)) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/ops/projects/${encodeURIComponent(project.id)}`, {
        method: "DELETE",
        headers: { "x-company-os-csrf": readCookie("company_os_ops_csrf") },
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "PROJECT_DISCONNECT_FAILED");
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "PROJECT_DISCONNECT_FAILED");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="projects-title" className="rounded-2xl border border-white/[0.08] bg-[#10151e] p-5 shadow-[0_20px_70px_rgba(0,0,0,0.22)] md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="flex items-center gap-2 text-[0.68rem] font-bold uppercase tracking-[0.16em] text-slate-500"><Boxes className="size-4" />Company OS générique</p>
          <h2 id="projects-title" className="mt-2 text-2xl font-semibold tracking-tight text-white md:text-3xl">Projets connectés</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">Un cockpit central, avec un runtime, une mémoire, des secrets et des permissions isolés pour chaque projet.</p>
        </div>
        <span className="inline-flex min-h-9 items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/[0.07] px-3 text-xs font-semibold text-emerald-200">
          <FolderLock className="size-4" /> Isolation dédiée
        </span>
      </div>

      {notice && <p role="status" className="mt-4 rounded-xl border border-white/10 bg-black/15 px-4 py-3 text-sm text-slate-200">{notice}</p>}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {projects.map((project) => {
          const meta = project.runtimeState === "starting"
            ? { label: "Démarrage", className: "border-amber-400/25 bg-amber-400/10 text-amber-200" }
            : project.runtimeState === "stopping"
              ? { label: "Arrêt", className: "border-amber-400/25 bg-amber-400/10 text-amber-200" }
              : statusMeta[project.status];
          return (
            <article key={project.id} className="rounded-2xl border border-white/[0.08] bg-[#0b1018] p-4 md:p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-semibold text-white">{project.displayName}</h3>
                    {project.current && <span className="rounded-full bg-amber-300/10 px-2 py-0.5 text-[0.68rem] font-bold text-amber-200">Projet courant</span>}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{project.id} · {project.kind} · runtime dédié</p>
                </div>
                <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${meta.className}`}>
                  {project.status === "online" ? <CheckCircle2 className="size-3.5" /> : <Radio className="size-3.5" />}{meta.label}
                </span>
              </div>
              <dl className="mt-4 space-y-2 text-xs leading-5">
                <div><dt className="text-slate-500">Dossier autorisé</dt><dd className="break-all text-slate-300">{project.workspacePath ?? "Non défini"}</dd></div>
                <div><dt className="text-slate-500">Initialisation</dt><dd className="text-slate-300">{initializationLabel(project)}</dd></div>
                <div><dt className="text-slate-500">Dernier signal du runtime</dt><dd className="text-slate-300">{project.lastHeartbeatAt ? new Date(project.lastHeartbeatAt).toLocaleString("fr-FR") : "Aucun signal reçu"}</dd></div>
              </dl>
              {project.discovery && <DiscoverySummary discovery={project.discovery} compact />}
              {project.initialization && <InitializationProgress initialization={project.initialization} />}
              {!project.current && (project.initialization || project.initialReview) && (
                <InitialReview review={project.initialReview} initialization={project.initialization} />
              )}
              {!project.current && <div className="mt-4 flex flex-wrap gap-2">
                {project.status === "online" && project.cockpitUrl && (
                  <a href={project.cockpitUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-300 px-3 text-sm font-bold text-slate-950 transition-colors hover:bg-emerald-200">
                    <ExternalLink className="size-4" /> Ouvrir son cockpit
                  </a>
                )}
                {project.status === "online" || project.runtimeState === "starting" ? (
                  <button type="button" disabled={busy} onClick={() => void changeRuntime(project, "stop")} className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-amber-400/20 px-3 text-sm font-semibold text-amber-200 transition-colors hover:bg-amber-400/10 disabled:cursor-not-allowed disabled:opacity-40"><Square className="size-4" /> Arrêter</button>
                ) : (
                  <button type="button" disabled={busy} onClick={() => void changeRuntime(project, "start")} className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl bg-amber-300 px-3 text-sm font-bold text-slate-950 transition-colors hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-40"><Play className="size-4" /> {project.initializedAt ? "Redémarrer" : "Initialiser"}</button>
                )}
                {project.status !== "online" && project.runtimeState !== "starting" && (
                  <button type="button" disabled={busy} onClick={() => void disconnect(project)} className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-rose-400/20 px-3 text-sm font-semibold text-rose-200 transition-colors hover:bg-rose-400/10 disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="size-4" /> Retirer</button>
                )}
              </div>}
              {project.lastErrorCode && <p className="mt-3 rounded-lg border border-rose-400/20 bg-rose-400/[0.05] px-3 py-2 text-xs leading-5 text-rose-200">{projectErrorMessage(new Error(project.lastErrorCode))}</p>}
            </article>
          );
        })}
      </div>

      <details className="group mt-6 rounded-2xl border border-amber-300/20 bg-amber-300/[0.035]">
        <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 px-4 py-3 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 [&::-webkit-details-marker]:hidden">
          <Plus className="size-4 text-amber-200" />
          <span className="flex-1">Connecter un nouveau projet</span>
        </summary>
        <form
          onSubmit={register}
          onInput={(event) => {
            const target = event.target as HTMLInputElement;
            if (target.name === "workspacePath" && preflight && target.value !== preflight.requestedPath) setPreflight(null);
          }}
          className="grid gap-4 border-t border-white/[0.07] p-4 sm:grid-cols-2"
        >
          <ProjectField name="id" label="Identifiant" placeholder="mon-nouveau-projet" />
          <ProjectField name="displayName" label="Nom affiché" placeholder="Mon nouveau projet" />
          <label className="text-xs font-semibold text-slate-300">Type
            <select name="kind" defaultValue="generic" className="mt-2 min-h-11 w-full rounded-xl border border-white/10 bg-[#070b11] px-3 text-base font-normal text-white focus:border-amber-300 focus:outline-none">
              <option value="saas">SaaS</option><option value="web_app">Application web</option><option value="api">API</option><option value="library">Bibliothèque</option><option value="generic">Générique</option>
            </select>
          </label>
          <ProjectField name="workspacePath" label="Chemin absolu du projet" placeholder={allowedRoots[0] ? `${allowedRoots[0]}\\mon-projet` : "C:\\chemin\\autorisé\\projet"} />
          <div className="sm:col-span-2 rounded-xl border border-sky-400/20 bg-sky-400/[0.05] p-3 text-xs leading-5 text-sky-100">
            La première étape analyse le dossier sans le modifier. Après ta confirmation, Company OS ajoute uniquement ses fichiers absents, puis vérifie séparément la base, le stockage, l’équipe et le cockpit local.
          </div>
          {preflight && <div className="sm:col-span-2"><DiscoverySummary discovery={preflight.discovery} /></div>}
          <button type="submit" disabled={busy} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-amber-300 px-4 text-sm font-bold text-slate-950 hover:bg-amber-200 disabled:opacity-50 sm:w-fit">
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Server className="size-4" />} {preflight ? "Confirmer et initialiser" : "Analyser le dossier"}
          </button>
        </form>
      </details>
    </section>
  );
}

function DiscoverySummary({ discovery, compact = false }: { discovery: ProjectDiscovery; compact?: boolean }) {
  const gitLabel = discovery.git.state === "clean"
    ? "Git propre"
    : discovery.git.state === "changes"
      ? `${discovery.git.changedFiles} changement${discovery.git.changedFiles > 1 ? "s" : ""} Git conservé${discovery.git.changedFiles > 1 ? "s" : ""}`
      : discovery.git.state === "not_repository"
        ? "Pas de dépôt Git"
        : "État Git indisponible";
  return (
    <div className={`${compact ? "mt-4" : ""} rounded-xl border border-emerald-400/20 bg-emerald-400/[0.05] p-3 text-xs leading-5 text-slate-300`}>
      <p className="font-semibold text-emerald-100">Dossier analysé et accessible en écriture</p>
      <div className="mt-2 grid gap-x-5 gap-y-1 sm:grid-cols-2">
        <p><span className="text-slate-500">Technologies :</span> {discovery.technologies.join(", ") || "Aucune reconnue"}</p>
        <p><span className="text-slate-500">Commandes :</span> {discovery.scripts.length > 0 ? discovery.scripts.slice(0, 6).join(", ") : "Aucune détectée"}</p>
        <p><span className="text-slate-500">Documentation :</span> {discovery.documentation.markdownFiles} fichier{discovery.documentation.markdownFiles > 1 ? "s" : ""} Markdown</p>
        <p><span className="text-slate-500">Git :</span> {gitLabel}{discovery.git.branch ? ` · ${discovery.git.branch}` : ""}</p>
      </div>
      {!compact && <p className="mt-2 break-all text-slate-500">Chemin vérifié : {discovery.canonicalPath}</p>}
      {!compact && discovery.existingProjectId && <p className="mt-2 text-amber-100">Une initialisation existante sera reprise pour « {discovery.existingProjectId} ».</p>}
    </div>
  );
}

function InitializationProgress({ initialization }: { initialization: ProjectInitialization }) {
  return (
    <ol className="mt-4 space-y-2" aria-label="Progression de l’initialisation">
      {initialization.steps.map((step) => (
        <li key={step.id} className="flex gap-2 text-xs leading-5">
          {step.status === "complete"
            ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-300" />
            : step.status === "active"
              ? <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-amber-300" />
              : step.status === "error"
                ? <Radio className="mt-0.5 size-4 shrink-0 text-rose-300" />
                : <Radio className="mt-0.5 size-4 shrink-0 text-slate-600" />}
          <span className={step.status === "pending" ? "text-slate-500" : step.status === "error" ? "text-rose-200" : "text-slate-300"}>{step.message}</span>
        </li>
      ))}
    </ol>
  );
}

const reviewBasisLabels: Record<ProjectInitialReviewBasis, string> = {
  technologies: "technologies détectées",
  commands: "commandes disponibles",
  documentation: "documentation repérée",
  git: "état Git observé",
  operational_readiness: "mise en ligne vérifiée",
};

function InitialReview({
  review,
  initialization,
}: {
  review: ProjectInitialReview | null;
  initialization: ProjectInitialization | null;
}) {
  if (!review) {
    const verified = initialization?.state === "ready";
    return (
      <div className="mt-4 rounded-xl border border-white/[0.08] bg-white/[0.025] p-3 text-xs leading-5 text-slate-400">
        <p className="flex items-center gap-2 font-semibold text-slate-200"><ClipboardCheck className="size-4" /> Premier état des lieux CEO</p>
        <p className="mt-1">{verified
          ? "La mise en ligne est vérifiée. Le déclenchement idempotent du bilan attend son enregistrement."
          : "Le bilan démarrera seulement après la vérification réelle du cockpit, du superviseur et de Codex."}</p>
      </div>
    );
  }

  if (review.state === "queued" || review.state === "running") {
    return (
      <div className="mt-4 rounded-xl border border-amber-300/20 bg-amber-300/[0.04] p-3 text-xs leading-5 text-slate-300" aria-label="État du premier bilan CEO">
        <p className="flex items-center gap-2 font-semibold text-amber-100"><LoaderCircle className="size-4 animate-spin" /> Premier état des lieux CEO</p>
        <p className="mt-1">{review.state === "queued"
          ? "Le diagnostic vérifié attend sa prise en charge par le CEO."
          : "Le CEO prépare la conclusion et trois priorités; aucune action externe n’est autorisée."}</p>
        <p className="mt-1 text-slate-500">Même suivi conservé en cas de redémarrage · dernière évolution {new Date(review.updatedAt).toLocaleString("fr-FR")}</p>
      </div>
    );
  }

  return (
    <section className={`mt-4 rounded-xl border p-3 text-xs leading-5 ${review.state === "completed" ? "border-emerald-400/20 bg-emerald-400/[0.04]" : "border-rose-400/20 bg-rose-400/[0.04]"}`} aria-label="Résultat du premier bilan CEO">
      <p className={`flex items-center gap-2 font-semibold ${review.state === "completed" ? "text-emerald-100" : "text-rose-100"}`}>
        {review.state === "completed" ? <CheckCircle2 className="size-4" /> : <TriangleAlert className="size-4" />}
        Premier état des lieux CEO · {review.state === "completed" ? "terminé" : "non abouti"}
      </p>
      {review.conclusion && <p className="mt-2 text-sm leading-6 text-slate-200">{review.conclusion}</p>}
      {review.limits.length > 0 && (
        <div className="mt-3 rounded-lg border border-white/[0.07] bg-black/10 px-3 py-2">
          <p className="font-semibold text-slate-300">Limites du bilan</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-slate-400">{review.limits.map((limit) => <li key={limit}>{limit}</li>)}</ul>
        </div>
      )}
      {review.priorities.length === 3 && (
        <ol className="mt-3 space-y-3" aria-label="Trois priorités proposées">
          {review.priorities.map((priority) => (
            <li key={priority.id} className="rounded-lg border border-white/[0.08] bg-black/10 p-3">
              <p className="font-semibold text-white"><span className="mr-2 text-amber-200">{priority.id}</span>{priority.title}</p>
              <p className="mt-1 text-slate-400">{priority.observation}</p>
              <p className="mt-2 text-slate-500">Appui diagnostic : {priority.basis.map((basis) => reviewBasisLabels[basis]).join(", ")}</p>
              <p className="mt-2 font-semibold text-slate-300">Accepté lorsque :</p>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-slate-400">{priority.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>
            </li>
          ))}
        </ol>
      )}
      {review.errorCode && <p className="mt-2 text-slate-500">Référence de suivi : {review.errorCode}</p>}
    </section>
  );
}

function initializationLabel(project: Project): string {
  if (project.initialization?.state === "ready") return "Prête et vérifiée";
  if (project.initialization?.state === "starting") return "En cours, étape par étape";
  if (project.initialization?.state === "error") return "Interrompue, reprise possible";
  if (project.initialization?.state === "validated") return "Dossier validé";
  return project.initializedAt ? "Initialisée avant le suivi détaillé" : "À initialiser";
}

function ProjectField({ name, label, placeholder }: { name: string; label: string; placeholder: string }) {
  return <label className="text-xs font-semibold text-slate-300">{label}<input required name={name} placeholder={placeholder} className="mt-2 min-h-11 w-full rounded-xl border border-white/10 bg-[#070b11] px-3 text-base font-normal text-white placeholder:text-slate-600 focus:border-amber-300 focus:outline-none" /></label>;
}

function readCookie(name: string): string {
  const prefix = `${encodeURIComponent(name)}=`;
  const item = document.cookie.split("; ").find((part) => part.startsWith(prefix));
  return item ? decodeURIComponent(item.slice(prefix.length)) : "";
}

function projectErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : "PROJECT_INITIALIZATION_FAILED";
  const messages: Record<string, string> = {
    PROJECT_PATH_FORBIDDEN: "Ce dossier est protégé et ne peut pas être connecté.",
    PROJECT_PATH_OUTSIDE_ALLOWED_ROOTS: "Ce dossier se trouve hors des emplacements autorisés.",
    PROJECT_PATH_NOT_DIRECTORY: "Le chemin indiqué n’est pas un dossier existant.",
    PROJECT_PATH_NOT_FOUND: "Ce dossier n’existe pas. Vérifie le chemin puis relance l’analyse.",
    PROJECT_PATH_UNAVAILABLE: "Ce dossier n’est pas accessible pour le moment.",
    PROJECT_WORKSPACE_WRITE_DENIED: "Company OS n’a pas l’autorisation d’écrire dans ce dossier. Redémarre le cockpit avec run-local.ps1 depuis PowerShell, puis relance l’initialisation.",
    PROJECT_PACKAGE_FILE_INVALID: "Le fichier package.json n’est pas lisible. Corrige-le puis relance l’analyse.",
    PROJECT_PACKAGE_FILE_TOO_LARGE: "Le fichier package.json est anormalement volumineux et n’a pas été lu.",
    PROJECT_MANIFEST_ID_MISMATCH: "Ce dossier possède déjà un manifeste pour un autre projet.",
    PROJECT_MANIFEST_INVALID: "Le manifeste Company OS existant n’est pas valide. Corrige-le avant de reprendre l’initialisation.",
    PROJECT_PATH_ALREADY_CONNECTED: "Ce dossier est déjà relié à un autre projet dans Ops.",
    PROJECT_RUNTIME_ACTIVE: "Arrête d’abord le runtime avant de retirer ce projet.",
    PROJECT_RUNTIME_START_RACE: "Le runtime a changé pendant le démarrage. Relance l’initialisation.",
    OPS_PROJECT_INITIALIZATION_FAILED: "L’initialisation n’a pas abouti. Consulte le code affiché sur la carte puis réessaie.",
    INVALID_INPUT_ID: "L’identifiant doit contenir au moins trois caractères. Les espaces et accents sont convertis automatiquement.",
    INVALID_INPUT_DISPLAYNAME: "Le nom affiché doit contenir entre 2 et 120 caractères.",
    INVALID_INPUT_WORKSPACEPATH: "Indique le chemin absolu d’un dossier de projet existant.",
  };
  return messages[code] ?? `L’opération n’a pas abouti (${code}). Aucun fichier existant n’a été remplacé.`;
}
