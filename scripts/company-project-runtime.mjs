import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const root = process.cwd();
const args = readArgs(process.argv.slice(2));
const projectId = required(args, "project-id");
const projectName = required(args, "project-name");
const runtimeId = required(args, "runtime-id");
const workspace = required(args, "workspace");
const webPort = Number(required(args, "web-port"));
if (!Number.isInteger(webPort) || webPort < 3200 || webPort > 3399) throw new Error("PROJECT_WEB_PORT_INVALID");
const registryUrl = process.env.DATABASE_URL;
if (!registryUrl) throw new Error("DATABASE_URL_REQUIRED");

const registry = new pg.Pool({
  connectionString: registryUrl,
  max: 1,
  application_name: `company-os-registry:${projectId}`,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
});
const children = [];
let stopped = false;
let failures = 0;
let timer;

try {
  const projectDatabaseUrl = await ensureProjectDatabase(registryUrl, projectId);
  run(process.execPath, ["scripts/apply-cockpit-migration.mjs"], { ...process.env, DATABASE_URL: projectDatabaseUrl });
  await setInitializationStep("database", "complete", "La base de données isolée est créée et accessible.", "storage", "Préparation du stockage privé du projet.");
  ensureProjectBucket(projectId);
  await setInitializationStep("storage", "complete", "Le stockage privé est créé et n’est pas public.", "team", "Création ou reprise des douze conversations Codex dédiées.");

  const stateDir = resolve(root, "work", "projects", projectId);
  mkdirSync(stateDir, { recursive: true });
  const provisioned = capture(process.execPath, [
    "scripts/provision-project-codex-threads.mjs",
    "--project-id", projectId,
    "--project-name", projectName,
    "--workspace", workspace,
    "--output", resolve(stateDir, "codex-threads.json"),
  ], process.env);
  const threadMap = JSON.parse(provisioned.trim().split(/\r?\n/).filter(Boolean).at(-1));
  const { ceo, ...specialists } = threadMap.threads;
  await setInitializationStep("team", "complete", "Les douze conversations Codex dédiées ont été vérifiées.", "cockpit", "Démarrage du cockpit et vérification de son signal local.");
  const runtimeEnv = {
    ...process.env,
    APP_URL: `http://localhost:${webPort}`,
    DATABASE_URL: projectDatabaseUrl,
    COMPANY_OS_PROJECT_ID: projectId,
    COMPANY_OS_PROJECT_NAME: projectName,
    COMPANY_OS_PROJECT_ROOT: workspace,
    COMPANY_OS_RUNTIME_ID: runtimeId,
    OPS_CODEX_MODE: "app-server-stdio",
    OPS_CODEX_CEO_THREAD_ID: ceo,
    OPS_CODEX_AGENT_THREADS_JSON: JSON.stringify(specialists),
    S3_BUCKET: `company-os-${projectId}`,
    GLOBAL_EXTERNAL_WORK_ENABLED: "false",
    META_ADS_ENABLED: "false",
    META_DAILY_BUDGET_CAP: "0",
  };

  children.push(startChild(
    "web",
    ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "-p", String(webPort)],
    runtimeEnv,
    stateDir,
  ));
  children[0].once("exit", () => { if (!stopped) void reportFailure("PROJECT_WEB_EXITED").then(() => shutdown(1)); });
  await waitForHealth(`http://127.0.0.1:${webPort}/api/health`, children[0]);
  children.push(startChild(
    "supervisor",
    ["node_modules/tsx/dist/cli.mjs", "watch", "src/company-supervisor/index.ts"],
    runtimeEnv,
    stateDir,
  ));
  children[1].once("exit", () => { if (!stopped) void reportFailure("PROJECT_SUPERVISOR_EXITED").then(() => shutdown(1)); });
  await new Promise((resolvePromise, reject) => setTimeout(() => children[1].exitCode === null ? resolvePromise() : reject(new Error("PROJECT_SUPERVISOR_EXITED")), 1_500));
  children.push(startChild(
    "video-worker",
    ["node_modules/tsx/dist/cli.mjs", "watch", "src/video-worker/index.ts"],
    runtimeEnv,
    stateDir,
  ));
  children[2].once("exit", () => { if (!stopped) void reportFailure("PROJECT_VIDEO_WORKER_EXITED").then(() => shutdown(1)); });
  await new Promise((resolvePromise, reject) => setTimeout(() => children[2].exitCode === null ? resolvePromise() : reject(new Error("PROJECT_VIDEO_WORKER_EXITED")), 1_500));
  await waitForProjectReadiness(projectDatabaseUrl, children);
  await heartbeat("online", projectDatabaseUrl);
  await setInitializationStep("cockpit", "complete", "Le cockpit local, le superviseur et Codex ont fourni des signaux récents.");
  children.push(startChild(
    "initial-review",
    ["node_modules/tsx/dist/cli.mjs", "scripts/run-initial-project-review.ts"],
    { ...runtimeEnv, COMPANY_OS_REGISTRY_DATABASE_URL: registryUrl },
    stateDir,
  ));
  timer = setInterval(() => void heartbeat("online", projectDatabaseUrl), 10_000);
} catch (error) {
  const code = safeCode(error);
  console.error(JSON.stringify({ level: "error", code }));
  await failActiveInitializationStep().catch(() => undefined);
  await reportFailure(code);
  await shutdown(1);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
process.on("uncaughtException", () => void shutdown(1));
process.on("unhandledRejection", () => void shutdown(1));

async function heartbeat(state, projectDatabaseUrl) {
  try {
    const updated = await registry.query(
      `UPDATE company_project_runtimes
          SET state = $3, process_id = $4, web_port = $5,
              last_heartbeat_at = now(),
              metadata = metadata || jsonb_build_object('workspace', $6::text, 'database', $7::text, 'isolation', 'database-per-project'),
              updated_at = now()
        WHERE project_id = $1 AND runtime_id = $2 RETURNING project_id`,
      [projectId, runtimeId, state, process.pid, webPort, workspace, new URL(projectDatabaseUrl).pathname.slice(1)],
    );
    if (updated.rowCount !== 1) throw new Error("PROJECT_RUNTIME_REGISTRATION_MISSING");
    await registry.query(
      "UPDATE company_projects SET status = 'online', last_heartbeat_at = now(), last_error_code = NULL, updated_at = now() WHERE id = $1",
      [projectId],
    );
    failures = 0;
  } catch {
    failures += 1;
    if (failures >= 6) await shutdown(1);
  }
}

async function reportFailure(code) {
  await registry.query(
    "UPDATE company_projects SET status = 'error', last_error_code = $2, updated_at = now() WHERE id = $1",
    [projectId, code],
  ).catch(() => undefined);
  await registry.query(
    "UPDATE company_project_runtimes SET state = 'error', process_id = NULL, updated_at = now() WHERE project_id = $1 AND runtime_id = $2",
    [projectId, runtimeId],
  ).catch(() => undefined);
}

async function setInitializationStep(completedId, completedStatus, completedMessage, nextId, nextMessage) {
  const result = await registry.query(
    "SELECT manifest -> 'initialization' AS initialization FROM company_projects WHERE id = $1",
    [projectId],
  );
  const initialization = result.rows[0]?.initialization;
  if (!initialization || !Array.isArray(initialization.steps)) throw new Error("PROJECT_INITIALIZATION_PROGRESS_MISSING");
  initialization.state = nextId ? "starting" : "ready";
  initialization.updatedAt = new Date().toISOString();
  initialization.steps = initialization.steps.map((step) => {
    if (step.id === completedId) return { ...step, status: completedStatus, message: completedMessage };
    if (step.id === nextId) return { ...step, status: "active", message: nextMessage };
    return step;
  });
  await registry.query(
    "UPDATE company_projects SET manifest = manifest || jsonb_build_object('initialization', $2::jsonb), updated_at = now() WHERE id = $1",
    [projectId, JSON.stringify(initialization)],
  );
}

async function failActiveInitializationStep() {
  const result = await registry.query(
    "SELECT manifest -> 'initialization' AS initialization FROM company_projects WHERE id = $1",
    [projectId],
  );
  const initialization = result.rows[0]?.initialization;
  if (!initialization || !Array.isArray(initialization.steps)) return;
  initialization.state = "error";
  initialization.updatedAt = new Date().toISOString();
  initialization.steps = initialization.steps.map((step) => step.status === "active"
    ? { ...step, status: "error", message: "Cette étape n’a pas abouti. Corrige la cause indiquée dans Ops puis relance l’initialisation." }
    : step);
  await registry.query(
    "UPDATE company_projects SET manifest = manifest || jsonb_build_object('initialization', $2::jsonb), updated_at = now() WHERE id = $1",
    [projectId, JSON.stringify(initialization)],
  );
}

async function shutdown(code) {
  if (stopped) return;
  stopped = true;
  if (timer) clearInterval(timer);
  for (const child of children.reverse()) if (child.exitCode === null) child.kill("SIGTERM");
  await registry.query(
    "UPDATE company_project_runtimes SET state = $3, process_id = NULL, updated_at = now() WHERE project_id = $1 AND runtime_id = $2",
    [projectId, runtimeId, code === 0 ? "offline" : "error"],
  ).catch(() => undefined);
  await registry.query(
    "UPDATE company_projects SET status = $2, updated_at = now() WHERE id = $1",
    [projectId, code === 0 ? "offline" : "error"],
  ).catch(() => undefined);
  await registry.end().catch(() => undefined);
  process.exit(code);
}

async function ensureProjectDatabase(connectionString, id) {
  const source = new URL(connectionString);
  const databaseName = `company_os_${id.replaceAll("-", "_")}`;
  const maintenanceUrl = new URL(source);
  maintenanceUrl.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: maintenanceUrl.toString() });
  await admin.connect();
  try {
    const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName]);
    if (!existing.rowCount) await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0 ENCODING 'UTF8'`);
  } finally {
    await admin.end();
  }
  source.pathname = `/${databaseName}`;
  return source.toString();
}

function ensureProjectBucket(id) {
  const user = process.env.MINIO_ROOT_USER;
  const password = process.env.MINIO_ROOT_PASSWORD;
  if (!user || !password) throw new Error("MINIO_CREDENTIALS_REQUIRED");
  run("docker", ["exec", "company-os-minio-1", "mc", "alias", "set", "companyos", "http://127.0.0.1:9000", user, password], process.env);
  run("docker", ["exec", "company-os-minio-1", "mc", "mb", "--ignore-existing", `companyos/company-os-${id}`], process.env);
  run("docker", ["exec", "company-os-minio-1", "mc", "anonymous", "set", "none", `companyos/company-os-${id}`], process.env);
}

function startChild(name, nodeArgs, env, stateDir) {
  const stdout = openSync(resolve(stateDir, `${name}.stdout.log`), "a");
  const stderr = openSync(resolve(stateDir, `${name}.stderr.log`), "a");
  const child = spawn(process.execPath, nodeArgs, { cwd: root, env, stdio: ["ignore", stdout, stderr], windowsHide: true });
  closeSync(stdout);
  closeSync(stderr);
  return child;
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("PROJECT_WEB_EXITED");
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error("PROJECT_WEB_HEALTH_TIMEOUT");
}
async function waitForProjectReadiness(projectDatabaseUrl, watchedChildren) {
  const projectPool = new pg.Pool({
    connectionString: projectDatabaseUrl,
    max: 1,
    application_name: `company-os-readiness:${projectId}`,
  });
  const deadline = Date.now() + 120_000;
  try {
    while (Date.now() < deadline) {
      if (watchedChildren.some((child) => child.exitCode !== null)) throw new Error("PROJECT_SERVICE_EXITED");
      try {
        const result = await projectPool.query(
          `SELECT component, status, heartbeat_at
             FROM cockpit_runtime_health
            WHERE component IN ('supervisor','bridge','codex')`,
        );
        const health = new Map(result.rows.map((row) => [row.component, row]));
        const ready = ["supervisor", "bridge", "codex"].every((component) => {
          const signal = health.get(component);
          const heartbeatAt = signal?.heartbeat_at instanceof Date ? signal.heartbeat_at : new Date(signal?.heartbeat_at ?? 0);
          return signal?.status === "connected" && Date.now() - heartbeatAt.getTime() < 15_000;
        });
        if (ready) return;
      } catch (error) {
        if (error instanceof Error && error.message === "PROJECT_SERVICE_EXITED") throw error;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    throw new Error("PROJECT_SERVICES_HEALTH_TIMEOUT");
  } finally {
    await projectPool.end().catch(() => undefined);
  }
}
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`COMMAND_FAILED_${args[0] ?? command}`);
}
function capture(command, args, env) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = result.stderr ?? "";
    if (stderr.includes("EPERM")) throw new Error("PROJECT_CODEX_SPAWN_DENIED");
    if (stderr.includes("EACCES")) throw new Error("PROJECT_CODEX_ACCESS_DENIED");
    if (stderr.includes("CODEX_REQUEST_TIMEOUT")) throw new Error("PROJECT_CODEX_TIMEOUT");
    throw new Error("PROJECT_CODEX_PROVISION_FAILED");
  }
  return result.stdout;
}
function safeCode(error) {
  const message = error instanceof Error ? error.message : "PROJECT_RUNTIME_FAILED";
  return /^[A-Z0-9_]{3,120}$/.test(message) ? message : "PROJECT_RUNTIME_FAILED";
}
function readArgs(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]?.replace(/^--/, "");
    const value = values[index + 1];
    if (key && value) result.set(key, value);
  }
  return result;
}
function required(values, key) {
  const value = values.get(key);
  if (!value) throw new Error(`ARGUMENT_REQUIRED_${key.toUpperCase().replaceAll("-", "_")}`);
  return value;
}
