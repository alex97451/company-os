import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import { COMPANY_AGENTS, OWNER_AGENT_PRESENTATION } from "@/lib/agents";
import { inspectProjectWorkspace } from "./discovery";
import {
  companyProjectManifestSchema,
  type CompanyProjectManifest,
  type ProjectDiscovery,
  type ProjectInitializationProgress,
} from "./manifest";
import { advanceProjectProgress, createValidatedProjectProgress, failProjectProgress } from "./progress";
import { CompanyProjectRepository } from "./repository";

const BOOTSTRAP_VERSION = 1;

export type ProjectInitializationResult = {
  projectId: string;
  state: "starting";
  cockpitUrl: string;
  filesCreated: string[];
  discovery: ProjectDiscovery;
  progress: ProjectInitializationProgress;
};

export async function initializeCompanyProject(
  pool: Pool,
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectInitializationResult> {
  const repository = new CompanyProjectRepository(pool);
  const currentId = env.COMPANY_OS_PROJECT_ID?.trim() || "company-os";
  if (projectId === currentId) throw new Error("CURRENT_PROJECT_ALREADY_INITIALIZED");
  let progress: ProjectInitializationProgress | null = null;

  try {
    const project = await repository.getRegistered(projectId, env);
    const discovery = await inspectProjectWorkspace(project.workspacePath, env);
    const root = discovery.canonicalPath;
    progress = advanceProjectProgress(
      createValidatedProjectProgress(),
      "workspace_analysis",
      "Le dossier a été analysé sans modifier ses fichiers.",
      "local_files",
      "Company OS prépare uniquement les fichiers locaux absents.",
    );

    const filesCreated = await scaffoldProject(root, {
      version: 1,
      id: project.id,
      displayName: project.displayName,
      kind: project.kind,
      isolationMode: "dedicated_runtime",
      companyDirectory: ".company-os",
      agentRoster: ".company-os/agents.json",
      externalWorkEnabledByDefault: false,
      commands: discovery.commands,
    });
    progress = advanceProjectProgress(
      progress,
      "local_files",
      filesCreated.length > 0
        ? `${filesCreated.length} fichier${filesCreated.length > 1 ? "s" : ""} local${filesCreated.length > 1 ? "aux" : ""} créé${filesCreated.length > 1 ? "s" : ""} sans remplacer l’existant.`
        : "Les fichiers locaux étaient déjà présents et ont été conservés.",
      "database",
      "Préparation et migration de la base de données isolée.",
    );

    const runtimeId = `project-${project.id}-${randomUUID()}`;
    const webPort = await repository.allocateRuntimePort(project.id);
    await repository.markRuntimeStarting(project.id, runtimeId, webPort, discovery, progress);
    return {
      projectId: project.id,
      state: "starting",
      cockpitUrl: `http://localhost:${webPort}/ops`,
      filesCreated,
      discovery,
      progress,
    };
  } catch (error) {
    const code = safeErrorCode(error);
    const failedProgress = progress
      ? failProjectProgress(progress, "Cette étape n’a pas abouti. Corrige la cause indiquée dans Ops puis relance l’initialisation.")
      : null;
    await repository.markInitializationError(projectId, code, failedProgress);
    throw new Error(code);
  }
}

export async function stopCompanyProjectRuntime(
  pool: Pool,
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const currentId = env.COMPANY_OS_PROJECT_ID?.trim() || "company-os";
  if (projectId === currentId) throw new Error("CURRENT_PROJECT_CANNOT_STOP");
  const repository = new CompanyProjectRepository(pool);
  const runtime = await repository.runtimeProcess(projectId);
  const fresh = Boolean(runtime.heartbeatAt && Date.now() - runtime.heartbeatAt.getTime() < 30_000);
  if (runtime.processId && fresh && ["starting", "online"].includes(runtime.state)) {
    try {
      process.kill(runtime.processId, "SIGTERM");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") throw new Error("PROJECT_RUNTIME_STOP_FAILED");
    }
  }
  await repository.markRuntimeOffline(projectId);
}

async function scaffoldProject(root: string, manifest: CompanyProjectManifest): Promise<string[]> {
  const companyDir = join(root, ".company-os");
  await mkdir(companyDir, { recursive: true });
  const created: string[] = [];

  await ensureManifest(join(root, "company-os.project.json"), manifest, created, root);
  await writeIfMissing(join(companyDir, "agents.json"), JSON.stringify({
    version: 1,
    agents: Object.values(COMPANY_AGENTS).map((agent) => ({
      id: agent.id,
      name: OWNER_AGENT_PRESENTATION[agent.id].name,
      role: OWNER_AGENT_PRESENTATION[agent.id].role,
      autonomyLevel: agent.level,
    })),
  }, null, 2) + "\n", created, root);
  await writeIfMissing(join(companyDir, "runtime.json"), JSON.stringify({
    version: 1,
    bootstrapVersion: BOOTSTRAP_VERSION,
    mode: "local",
    externalWorkEnabled: false,
  }, null, 2) + "\n", created, root);
  await writeIfMissing(join(companyDir, "README.md"), [
    `# ${manifest.displayName} — Company OS`,
    "",
    "Cet espace a été initialisé localement par le cockpit Company OS.",
    "",
    "- Le runtime, la mémoire et les permissions sont isolés pour ce projet.",
    "- Les actions externes restent désactivées par défaut.",
    "- Aucun secret ne doit être ajouté à ces fichiers versionnables.",
    "- Le démarrage et l’arrêt du runtime se pilotent depuis Ops.",
    "",
  ].join("\n"), created, root);

  return created;
}

async function ensureManifest(
  path: string,
  manifest: CompanyProjectManifest,
  created: string[],
  root: string,
): Promise<void> {
  try {
    const file = await stat(path);
    if (file.size > 100_000) throw new Error("PROJECT_MANIFEST_TOO_LARGE");
    const current = companyProjectManifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (current.id !== manifest.id) throw new Error("PROJECT_MANIFEST_ID_MISMATCH");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    await writeIfMissing(path, JSON.stringify(manifest, null, 2) + "\n", created, root);
  }
}

async function writeIfMissing(
  path: string,
  content: string,
  created: string[],
  root: string,
): Promise<void> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
    created.push(path.slice(root.length + 1).replaceAll("\\", "/"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function safeErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "PROJECT_INITIALIZATION_FAILED";
  if (/^[A-Z0-9_]{3,120}$/.test(error.message)) return error.message;
  if ((error as NodeJS.ErrnoException).code === "EACCES" || (error as NodeJS.ErrnoException).code === "EPERM") {
    return "PROJECT_WORKSPACE_WRITE_DENIED";
  }
  return "PROJECT_INITIALIZATION_FAILED";
}
