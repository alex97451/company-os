import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL_REQUIRED");
const currentProjectId = process.env.COMPANY_OS_PROJECT_ID ?? "company-os";
const pool = new pg.Pool({ connectionString, max: 1, application_name: "company-os-runtime-queue" });
try {
  const result = await pool.query(
    `UPDATE company_project_runtimes runtime
        SET state = 'starting',
            runtime_id = 'project-' || runtime.project_id || '-' || gen_random_uuid()::text,
            process_id = NULL,
            last_heartbeat_at = now(),
            updated_at = now()
       FROM company_projects project
      WHERE project.id = runtime.project_id
        AND project.id <> $1
        AND project.workspace_path IS NOT NULL
        AND runtime.web_port IS NOT NULL
        AND runtime.state IN ('offline','error')
      RETURNING runtime.project_id`,
    [currentProjectId],
  );
  console.log(`${result.rowCount ?? 0} runtime(s) projet mis en file locale.`);
} finally {
  await pool.end();
}
