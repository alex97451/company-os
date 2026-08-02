import { createDatabasePool } from "../lib/db/pool";
import { parseCompanySupervisorConfig, runSupervisorLoop, type SafeSupervisorLogger } from "./runtime";

const logger: SafeSupervisorLogger = {
  info(code, metadata) { console.info(JSON.stringify({ level: "info", code, ...metadata })); },
  error(code, metadata) { console.error(JSON.stringify({ level: "error", code, ...metadata })); },
};

async function main(): Promise<void> {
  const config = parseCompanySupervisorConfig(process.env);
  const pool = createDatabasePool({ ...process.env, DATABASE_APPLICATION_NAME: `company-os-supervisor:${process.env.COMPANY_OS_PROJECT_ID ?? "system"}` });
  const abortController = new AbortController();
  const stop = () => abortController.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runSupervisorLoop({ pool, config, signal: abortController.signal, logger });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  // Fail closed with a safe code only; never serialize exception details or payloads.
  const detail = error instanceof Error && /^[A-Z0-9_]{3,120}$/.test(error.message)
    ? error.message.toLowerCase()
    : "unknown";
  logger.error("company_supervisor_start_failed", { detail });
  process.exitCode = 1;
});
