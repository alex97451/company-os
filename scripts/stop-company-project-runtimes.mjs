import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) process.exit(0);

const currentProjectId = process.env.COMPANY_OS_PROJECT_ID || "company-os";
const pool = new pg.Pool({
  connectionString,
  max: 1,
  application_name: "company-os:local-stop",
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
});

try {
  const result = await pool.query(
    `SELECT project_id, process_id
       FROM company_project_runtimes
      WHERE project_id <> $1
        AND process_id IS NOT NULL
        AND state IN ('starting', 'online')
        AND last_heartbeat_at > now() - interval '30 seconds'`,
    [currentProjectId],
  );
  for (const runtime of result.rows) {
    try {
      process.kill(runtime.process_id, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  await pool.query(
    `UPDATE company_project_runtimes
        SET state = 'offline', process_id = NULL, updated_at = now()
      WHERE project_id <> $1 AND state IN ('starting', 'online', 'stopping')`,
    [currentProjectId],
  );
  await pool.query(
    `UPDATE company_projects SET status = 'offline', updated_at = now()
      WHERE id <> $1 AND status = 'online'`,
    [currentProjectId],
  );
} catch {
  console.log("Company project runtime cleanup skipped because the local registry is unavailable.");
} finally {
  await pool.end();
}
