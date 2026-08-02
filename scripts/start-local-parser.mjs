import { startTrackedProcess } from "./local-process.mjs";

startTrackedProcess({
  name: "Local parser watcher",
  pidName: "parser",
  commandMarker: "src/parser/server.ts",
  args: ["node_modules/tsx/dist/cli.mjs", "watch", "--env-file=.env.local", "src/parser/server.ts"],
  env: { PARSER_HOST: "127.0.0.1", PARSER_PORT: "4319" },
});
