import { spawnSync } from "node:child_process";
import { stopTrackedProcess } from "./local-process.mjs";

stopTrackedProcess({
  name: "Next.js development server",
  pidName: "web",
  commandMarker: "node_modules/next/dist/bin/next dev",
});

const result = spawnSync(process.execPath, ["--env-file=.env.local", "scripts/start-local-web.mjs"], {
  cwd: process.cwd(),
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) throw result.error;
if (result.status !== 0) throw new Error("LOCAL_WEB_RESTART_FAILED");
