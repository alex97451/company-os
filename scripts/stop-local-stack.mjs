import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { stopTrackedProcess } from "./local-process.mjs";

const root = process.cwd();

stopTrackedProcess({ name: "project runtime manager", pidName: "runtime-manager", commandMarker: "scripts/project-runtime-manager.mjs" });
stopTrackedProcess({ name: "company supervisor", pidName: "supervisor", commandMarker: "src/company-supervisor/index.ts" });
stopTrackedProcess({ name: "Next.js development server", pidName: "web", commandMarker: "node_modules/next/dist/bin/next dev" });

if (existsSync(resolve(root, ".env.local"))) {
  const projectRuntimeStop = spawnSync(process.execPath, ["--env-file=.env.local", "scripts/stop-company-project-runtimes.mjs"], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  if (projectRuntimeStop.error) throw projectRuntimeStop.error;
  if (projectRuntimeStop.status !== 0) throw new Error("COMPANY_PROJECT_RUNTIMES_STOP_FAILED");

  const result = spawnSync("docker", ["compose", "--env-file", ".env.local", "down"], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("DOCKER_COMPOSE_STOP_FAILED");
} else {
  console.log("No .env.local found; Docker Compose was not contacted.");
}

console.log("Company OS local est arrêté. Les données Docker sont conservées.");
