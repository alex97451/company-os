import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "win32") process.exit(0);

const configuredCommand = process.env.OPS_CODEX_COMMAND?.trim();
if (!configuredCommand) throw new Error("OPS_CODEX_COMMAND_REQUIRED");
if (!isAbsolute(configuredCommand) && !/[\\/]/.test(configuredCommand)) {
  console.log("Codex runtime is managed through PATH; no local helper synchronization is required.");
  process.exit(0);
}

const targetExecutable = isAbsolute(configuredCommand)
  ? configuredCommand
  : resolve(process.cwd(), configuredCommand);
const targetDirectory = dirname(targetExecutable);
const helperNames = [
  "codex-windows-sandbox-setup.exe",
  "codex-command-runner.exe",
  "codex-code-mode-host.exe",
];

if (
  existsSync(targetExecutable)
  && helperNames.every((name) => existsSync(resolve(targetDirectory, name)))
) {
  console.log("Local Codex runtime and Windows sandbox helpers are ready.");
  process.exit(0);
}

const located = spawnSync("where.exe", ["codex.exe"], {
  encoding: "utf8",
  windowsHide: true,
});
if (located.error) throw located.error;
if (located.status !== 0) throw new Error("CODEX_WINDOWS_APP_NOT_FOUND");

const sourceExecutable = located.stdout
  .split(/\r?\n/)
  .map((value) => value.trim())
  .find((value) => /\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\resources\\codex\.exe$/i.test(value));
if (!sourceExecutable) throw new Error("CODEX_WINDOWS_APP_SOURCE_REJECTED");

const sourceDirectory = dirname(sourceExecutable);
for (const helperName of helperNames) {
  if (!existsSync(resolve(sourceDirectory, helperName))) {
    throw new Error(`CODEX_WINDOWS_HELPER_MISSING:${helperName}`);
  }
}

mkdirSync(targetDirectory, { recursive: true });
if (!existsSync(targetExecutable) || statSync(targetExecutable).size !== statSync(sourceExecutable).size) {
  copyFileSync(sourceExecutable, targetExecutable);
}
for (const helperName of helperNames) {
  const source = resolve(sourceDirectory, helperName);
  const target = resolve(targetDirectory, helperName);
  if (!existsSync(target) || statSync(target).size !== statSync(source).size) {
    copyFileSync(source, target);
  }
}

console.log("Local Codex runtime and signed Windows sandbox helpers synchronized.");
