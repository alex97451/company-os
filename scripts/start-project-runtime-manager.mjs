import { startTrackedProcess } from "./local-process.mjs";

startTrackedProcess({
  name: "Company OS project runtime manager",
  pidName: "runtime-manager",
  commandMarker: "scripts/project-runtime-manager.mjs",
  args: ["--env-file=.env.local", "scripts/project-runtime-manager.mjs"],
});
