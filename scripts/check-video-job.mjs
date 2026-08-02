import pg from "pg";

const projectId = process.argv[2];
const jobId = process.argv[3];
if (!/^[a-z][a-z0-9-]{2,62}$/.test(projectId ?? "")) throw new Error("PROJECT_ID_INVALID");
if (!/^[0-9a-f-]{36}$/.test(jobId ?? "")) throw new Error("VIDEO_JOB_ID_INVALID");
const url = new URL(process.env.DATABASE_URL);
url.pathname = `/company_os_${projectId.replaceAll("-", "_")}`;
const client = new pg.Client({ connectionString: url.toString() });
await client.connect();
const result = await client.query(
  `SELECT job.state, job.progress, job.stage_label AS "stageLabel", job.error_code AS "errorCode",
          selected_hook IS NOT NULL AS "hasHook", video_object_key IS NOT NULL AS "hasVideo",
          job.updated_at AS "updatedAt", task.status AS "taskState", run.state AS "runState",
          run.codex_turn_id IS NOT NULL AS "turnStarted",
          (SELECT event.event_type FROM cockpit_events event WHERE event.aggregate_type = 'run' AND event.aggregate_id = run.id::text ORDER BY event.sequence DESC LIMIT 1) AS "lastEvent",
          (SELECT event.safe_payload ->> 'code' FROM cockpit_events event WHERE event.aggregate_type = 'run' AND event.aggregate_id = run.id::text ORDER BY event.sequence DESC LIMIT 1) AS "lastCode"
          ,(SELECT event.safe_payload ->> 'summary' FROM cockpit_events event WHERE event.aggregate_type = 'run' AND event.aggregate_id = run.id::text ORDER BY event.sequence DESC LIMIT 1) AS "lastSummary"
     FROM video_jobs job
     LEFT JOIN cockpit_tasks task ON task.id = job.task_id
     LEFT JOIN cockpit_runs run ON run.id = job.run_id
    WHERE job.id = $1`,
  [jobId],
);
await client.end();
if (!result.rows[0]) throw new Error("VIDEO_JOB_NOT_FOUND");
process.stdout.write(`${JSON.stringify(result.rows[0])}\n`);
