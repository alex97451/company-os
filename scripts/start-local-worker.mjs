import { startTrackedProcess } from "./local-process.mjs";

startTrackedProcess({
  name: "Local worker watcher",
  pidName: "worker",
  commandMarker: "src/worker/index.ts",
  args: ["node_modules/tsx/dist/cli.mjs", "watch", "--env-file=.env.local", "src/worker/index.ts"],
});
