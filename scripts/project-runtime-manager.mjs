import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const root = process.cwd();
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL_REQUIRED");
const pool = new pg.Pool({ connectionString, max: 2, application_name: "company-os-runtime-manager" });
let stopped = false;

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

while (!stopped) {
  await launchPending().catch(() => undefined);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
}

async function launchPending() {
  const result = await pool.query(
    `SELECT runtime.project_id, runtime.runtime_id, runtime.web_port,
            project.display_name, project.workspace_path
       FROM company_project_runtimes runtime
       JOIN company_projects project ON project.id = runtime.project_id
      WHERE runtime.state = 'starting' AND runtime.process_id IS NULL
      ORDER BY runtime.updated_at
      LIMIT 5`,
  );
  for (const row of result.rows) await launch(row);
}

async function launch(row) {
  if (!row.workspace_path || !row.web_port) {
    await fail(row.project_id, "PROJECT_RUNTIME_CONFIGURATION_MISSING");
    return;
  }
  const stateDir = resolve(root, "work", "projects", row.project_id);
  mkdirSync(stateDir, { recursive: true });
  const stdout = openSync(resolve(stateDir, "runtime.stdout.log"), "a");
  const stderr = openSync(resolve(stateDir, "runtime.stderr.log"), "a");
  const child = spawn(process.execPath, [
    "scripts/company-project-runtime.mjs",
    "--project-id", row.project_id,
    "--project-name", row.display_name,
    "--runtime-id", row.runtime_id,
    "--workspace", row.workspace_path,
    "--web-port", String(row.web_port),
  ], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", stdout, stderr],
    env: { ...process.env, NODE_ENV: "development" },
  });
  closeSync(stdout);
  closeSync(stderr);
  await new Promise((resolvePromise, reject) => {
    child.once("spawn", resolvePromise);
    child.once("error", reject);
  });
  const attached = await pool.query(
    `UPDATE company_project_runtimes SET process_id = $3, updated_at = now()
      WHERE project_id = $1 AND runtime_id = $2 AND state = 'starting' AND process_id IS NULL`,
    [row.project_id, row.runtime_id, child.pid],
  );
  if (attached.rowCount !== 1) child.kill("SIGTERM");
  child.unref();
}

async function fail(projectId, code) {
  await pool.query("UPDATE company_project_runtimes SET state = 'error', process_id = NULL, updated_at = now() WHERE project_id = $1", [projectId]);
  await pool.query("UPDATE company_projects SET status = 'error', last_error_code = $2, updated_at = now() WHERE id = $1", [projectId, code]);
}

async function shutdown() {
  if (stopped) return;
  stopped = true;
  await pool.end().catch(() => undefined);
}
