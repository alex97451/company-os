"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { Boxes, CheckCircle2, ExternalLink, FolderLock, LoaderCircle, Play, Plus, Radio, Server, Square, Trash2 } from "lucide-react";

type ProjectStatus = "registered" | "online" | "offline" | "blocked" | "error";
type ProjectKind = "saas" | "web_app" | "api" | "library" | "generic";
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
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/ops/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-company-os-csrf": readCookie("company_os_ops_csrf") },
        body: JSON.stringify({
          id: String(form.get("id") ?? ""),
          displayName: String(form.get("displayName") ?? ""),
          kind: String(form.get("kind") ?? "generic"),
          workspacePath: String(form.get("workspacePath") ?? ""),
        }),
      });
      const data = await response.json() as { error?: string; issues?: Array<{ path?: Array<string | number> }> };
      if (!response.ok) {
        const invalidField = data.issues?.[0]?.path?.[0];
        throw new Error(invalidField ? `INVALID_INPUT_${String(invalidField).toUpperCase()}` : (data.error ?? "PROJECT_REGISTER_FAILED"));
      }
      event.currentTarget.reset();
      setNotice("Projet préparé. Son runtime dédié démarre maintenant ; son passage en ligne sera confirmé par un signal réel.");
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
                <div><dt className="text-slate-500">Initialisation</dt><dd className="text-slate-300">{project.initializedAt ? "Company OS installé" : "À initialiser"}</dd></div>
                <div><dt className="text-slate-500">Dernier signal du runtime</dt><dd className="text-slate-300">{project.lastHeartbeatAt ? new Date(project.lastHeartbeatAt).toLocaleString("fr-FR") : "Aucun signal reçu"}</dd></div>
              </dl>
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
        <form onSubmit={register} className="grid gap-4 border-t border-white/[0.07] p-4 sm:grid-cols-2">
          <ProjectField name="id" label="Identifiant" placeholder="mon-nouveau-projet" />
          <ProjectField name="displayName" label="Nom affiché" placeholder="Mon nouveau projet" />
          <label className="text-xs font-semibold text-slate-300">Type
            <select name="kind" defaultValue="generic" className="mt-2 min-h-11 w-full rounded-xl border border-white/10 bg-[#070b11] px-3 text-base font-normal text-white focus:border-amber-300 focus:outline-none">
              <option value="saas">SaaS</option><option value="web_app">Application web</option><option value="api">API</option><option value="library">Bibliothèque</option><option value="generic">Générique</option>
            </select>
          </label>
          <ProjectField name="workspacePath" label="Chemin absolu du projet" placeholder={allowedRoots[0] ? `${allowedRoots[0]}\\mon-projet` : "C:\\chemin\\autorisé\\projet"} />
          <div className="sm:col-span-2 rounded-xl border border-sky-400/20 bg-sky-400/[0.05] p-3 text-xs leading-5 text-sky-100">
            Le dossier doit déjà exister. Company OS ajoute uniquement ses fichiers absents, prépare les agents et démarre un runtime local isolé. Aucun fichier existant n’est remplacé.
          </div>
          <button type="submit" disabled={busy} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-amber-300 px-4 text-sm font-bold text-slate-950 hover:bg-amber-200 disabled:opacity-50 sm:w-fit">
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Server className="size-4" />} Initialiser et démarrer
          </button>
        </form>
      </details>
    </section>
  );
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
    PROJECT_WORKSPACE_WRITE_DENIED: "Company OS n’a pas l’autorisation d’écrire dans ce dossier. Redémarre le cockpit avec run-local.ps1 depuis PowerShell, puis relance l’initialisation.",
    PROJECT_MANIFEST_ID_MISMATCH: "Ce dossier possède déjà un manifeste pour un autre projet.",
    PROJECT_RUNTIME_ACTIVE: "Arrête d’abord le runtime avant de retirer ce projet.",
    PROJECT_RUNTIME_START_RACE: "Le runtime a changé pendant le démarrage. Relance l’initialisation.",
    OPS_PROJECT_INITIALIZATION_FAILED: "L’initialisation n’a pas abouti. Consulte le code affiché sur la carte puis réessaie.",
    INVALID_INPUT_ID: "L’identifiant doit contenir au moins trois caractères. Les espaces et accents sont convertis automatiquement.",
    INVALID_INPUT_DISPLAYNAME: "Le nom affiché doit contenir entre 2 et 120 caractères.",
    INVALID_INPUT_WORKSPACEPATH: "Indique le chemin absolu d’un dossier de projet existant.",
  };
  return messages[code] ?? `L’opération n’a pas abouti (${code}). Aucun fichier existant n’a été remplacé.`;
}
