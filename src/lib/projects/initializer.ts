import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import { COMPANY_AGENTS, OWNER_AGENT_PRESENTATION } from "@/lib/agents";
import { companyProjectManifestSchema, type CompanyProjectManifest } from "./manifest";
import { assertProjectPathAllowed } from "./path-policy";
import { CompanyProjectRepository } from "./repository";

const BOOTSTRAP_VERSION = 1;

export type ProjectInitializationResult = {
  projectId: string;
  state: "starting";
  cockpitUrl: string;
  filesCreated: string[];
};

export async function initializeCompanyProject(
  pool: Pool,
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectInitializationResult> {
  const repository = new CompanyProjectRepository(pool);
  const currentId = env.COMPANY_OS_PROJECT_ID?.trim() || "company-os";
  if (projectId === currentId) throw new Error("CURRENT_PROJECT_ALREADY_INITIALIZED");

  try {
    const project = await repository.getRegistered(projectId, env);
    const root = assertProjectPathAllowed(await realpath(project.workspacePath), env);
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) throw new Error("PROJECT_PATH_NOT_DIRECTORY");

    const filesCreated = await scaffoldProject(root, {
      version: 1,
      id: project.id,
      displayName: project.displayName,
      kind: project.kind,
      isolationMode: "dedicated_runtime",
      companyDirectory: ".company-os",
      agentRoster: ".company-os/agents.json",
      externalWorkEnabledByDefault: false,
      commands: await detectCommands(root),
    });

    const runtimeId = `project-${project.id}-${randomUUID()}`;
    const webPort = await repository.allocateRuntimePort(project.id);
    await repository.markRuntimeStarting(project.id, runtimeId, webPort);
    return { projectId: project.id, state: "starting", cockpitUrl: `http://localhost:${webPort}/ops`, filesCreated };
  } catch (error) {
    const code = safeErrorCode(error);
    await repository.markInitializationError(projectId, code);
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

async function detectCommands(root: string): Promise<CompanyProjectManifest["commands"]> {
  try {
    const packagePath = join(root, "package.json");
    const packageStat = await stat(packagePath);
    if (packageStat.size > 1_000_000) throw new Error("PROJECT_PACKAGE_FILE_TOO_LARGE");
    const parsed = JSON.parse(await readFile(packagePath, "utf8")) as { scripts?: Record<string, unknown> };
    const scripts = parsed.scripts ?? {};
    return {
      verify: typeof scripts.verify === "string" ? "npm run verify" : typeof scripts.test === "string" ? "npm test" : "npm run lint --if-present",
      start: typeof scripts.dev === "string" ? "npm run dev" : typeof scripts.start === "string" ? "npm start" : "À configurer dans Ops",
      stop: "Arrêter le runtime depuis Ops",
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      verify: "À configurer dans Ops",
      start: "À configurer dans Ops",
      stop: "Arrêter le runtime depuis Ops",
    };
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
