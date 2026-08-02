import { stopTrackedProcess } from "./local-process.mjs";

stopTrackedProcess({
  name: "Next.js development server",
  pidName: "web",
  commandMarker: "node_modules/next/dist/bin/next dev",
});
