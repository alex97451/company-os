import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

export function startTrackedProcess({ name, pidName, commandMarker, args, env = {} }) {
  const root = process.cwd();
  mkdirSync(resolve(root, "work"), { recursive: true });
  const pidPath = resolve(root, `work/${pidName}.pid`);

  if (existsSync(pidPath)) {
    const existingPid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    if (Number.isSafeInteger(existingPid) && existingPid > 0 && processMatches(existingPid, commandMarker)) {
      console.log(`${name} is already running with PID ${existingPid}.`);
      return existingPid;
    }
    unlinkSync(pidPath);
  }

  const stdout = openSync(resolve(root, `work/${pidName}.stdout.log`), "a");
  const stderr = openSync(resolve(root, `work/${pidName}.stderr.log`), "a");
  const child = spawn(process.execPath, args, {
    cwd: root,
    detached: true,
    env: { ...process.env, ...env },
    stdio: ["ignore", stdout, stderr],
    windowsHide: true,
  });

  writeFileSync(pidPath, `${child.pid}\n`, "utf8");
  child.unref();
  closeSync(stdout);
  closeSync(stderr);
  console.log(`${name} started with PID ${child.pid}.`);
  return child.pid;
}

export function stopTrackedProcess({ name, pidName, commandMarker }) {
  const root = process.cwd();
  const pidPath = resolve(root, `work/${pidName}.pid`);
  if (!existsSync(pidPath)) return;

  const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
  if (!Number.isSafeInteger(pid) || pid < 1) {
    unlinkSync(pidPath);
    return;
  }

  const marker = commandMarker.replaceAll("'", "''");
  const command = [
    `function Stop-CompanyOsTree([int]$TargetId) { $children = Get-CimInstance Win32_Process -Filter \"ParentProcessId = $TargetId\" -ErrorAction SilentlyContinue; foreach ($child in $children) { Stop-CompanyOsTree $child.ProcessId }; Stop-Process -Id $TargetId -Force -ErrorAction SilentlyContinue }`,
    `$process = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction SilentlyContinue`,
    "if (-not $process) { exit 10 }",
    `if ($process.CommandLine -notlike '*${marker}*') { exit 11 }`,
    "Stop-CompanyOsTree $process.ProcessId",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    cwd: root,
    stdio: "ignore",
    windowsHide: true,
  });

  if (result.status === 0 || result.status === 10) {
    unlinkSync(pidPath);
    console.log(`Stopped ${name}${result.status === 0 ? ` (PID ${pid})` : " (already exited)"}.`);
    return;
  }
  if (result.status === 11) {
    console.warn(`Skipped ${name}: PID ${pid} no longer matches a Company OS command.`);
    return;
  }
  throw new Error(`PROCESS_STOP_FAILED: ${name}`);
}

function processMatches(pid, commandMarker) {
  const marker = commandMarker.replaceAll("'", "''");
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$process = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction SilentlyContinue; if ($process -and $process.CommandLine -like '*${marker}*') { exit 0 }; exit 1`,
    ],
    { cwd: process.cwd(), stdio: "ignore", windowsHide: true },
  );
  return result.status === 0;
}
