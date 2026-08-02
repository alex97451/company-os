import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = process.cwd();
if (!existsSync(resolve(root, ".env.local"))) {
  throw new Error("LOCAL_ENV_MISSING: run `npm run ops:setup` first.");
}
if (!existsSync(resolve(root, ".next", "BUILD_ID"))) {
  run("npm.cmd", ["run", "build"]);
}

run("docker", ["compose", "version"]);
run("docker", ["compose", "--env-file", ".env.local", "up", "-d", "--wait", "--wait-timeout", "120", "postgres", "minio"]);
run("docker", ["compose", "--env-file", ".env.local", "run", "--rm", "minio-init"]);
run(process.execPath, ["--env-file=.env.local", "scripts/apply-cockpit-migration.mjs"]);
run(process.execPath, ["--env-file=.env.local", "scripts/queue-company-project-runtimes.mjs"]);
run(process.execPath, ["--env-file=.env.local", "scripts/start-local-web.mjs"]);
run(process.execPath, ["scripts/start-project-runtime-manager.mjs"]);
run(process.execPath, ["scripts/start-local-supervisor.mjs"]);

console.log("Company OS est démarré en développement avec rechargement automatique.");
console.log(`Cockpit : ${process.env.APP_URL ?? "http://localhost:3020"}/ops`);
if (process.env.OPS_LAN_ENABLED === "true" && process.env.OPS_LAN_ORIGIN) {
  console.log(`Cockpit opérateur LAN : ${process.env.OPS_LAN_ORIGIN}/ops`);
}
console.log("Aucune action externe ou dépense n'a été lancée.");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`COMMAND_FAILED: ${command} ${args.join(" ")}`);
}
