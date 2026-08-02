import { startTrackedProcess } from "./local-process.mjs";

startTrackedProcess({
  name: "Next.js development server",
  pidName: "web",
  commandMarker: "node_modules/next/dist/bin/next dev",
  args: [
    "node_modules/next/dist/bin/next",
    "dev",
    "--turbopack",
    "--hostname",
    process.env.OPS_LAN_ENABLED === "true" ? "0.0.0.0" : "127.0.0.1",
    "-p",
    new URL(process.env.APP_URL ?? "http://localhost:3020").port || "3020",
  ],
});
