import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = process.cwd();
mkdirSync(resolve(root, "work"), { recursive: true });
const pidPath = resolve(root, "work/supervisor.pid");

if (existsSync(pidPath)) {
  const existingPid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
  if (Number.isSafeInteger(existingPid) && existingPid > 0 && isCompanySupervisor(existingPid)) {
    console.log(`Local company supervisor is already running with PID ${existingPid}.`);
    process.exit(0);
  }
  unlinkSync(pidPath);
}

const runtimeSync = spawnSync(
  process.execPath,
  ["--env-file=.env.local", "scripts/ensure-local-codex-runtime.mjs"],
  { cwd: root, stdio: "inherit", windowsHide: true },
);
if (runtimeSync.status !== 0) {
  throw new Error("CODEX_RUNTIME_SYNC_FAILED");
}

const provisioned = spawnSync(
  process.execPath,
  [
    "--env-file=.env.local",
    "scripts/provision-project-codex-threads.mjs",
    "--project-id", process.env.COMPANY_OS_PROJECT_ID ?? "company-os",
    "--project-name", process.env.COMPANY_OS_PROJECT_NAME ?? "Company OS",
    "--workspace", process.env.COMPANY_OS_PROJECT_ROOT ?? root,
    "--output", resolve(root, "work", "projects", "company-os", "codex-threads.json"),
  ],
  { cwd: root, encoding: "utf8", windowsHide: true },
);
if (provisioned.error) throw provisioned.error;
if (provisioned.status !== 0) throw new Error("CODEX_THREAD_PROVISION_FAILED");
const threadMap = JSON.parse(provisioned.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
const { ceo, ...specialists } = threadMap.threads;
const supervisorEnv = {
  ...process.env,
  OPS_CODEX_MODE: "app-server-stdio",
  OPS_CODEX_CEO_THREAD_ID: ceo,
  OPS_CODEX_AGENT_THREADS_JSON: JSON.stringify(specialists),
};

const stdout = openSync(resolve(root, "work/supervisor.stdout.log"), "a");
const stderr = openSync(resolve(root, "work/supervisor.stderr.log"), "a");
const child = spawn(
  process.execPath,
  [
    "node_modules/tsx/dist/cli.mjs",
    "watch",
    "--env-file=.env.local",
    "src/company-supervisor/index.ts",
  ],
  {
    cwd: root,
    detached: true,
    env: supervisorEnv,
    stdio: ["ignore", stdout, stderr],
    windowsHide: true,
  },
);

writeFileSync(pidPath, `${child.pid}\n`, "utf8");
child.unref();
closeSync(stdout);
closeSync(stderr);
console.log(`Local company supervisor started with PID ${child.pid}.`);

function isCompanySupervisor(pid) {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue; if ($process -and $process.CommandLine -like '*src/company-supervisor/index.ts*') { exit 0 }; exit 1`,
    ],
    { cwd: root, stdio: "ignore", windowsHide: true },
  );
  return result.status === 0;
}
