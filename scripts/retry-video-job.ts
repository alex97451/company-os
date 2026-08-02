import pg from "pg";
import { z } from "zod";
import { VideoStudioService } from "../src/lib/videos/service";

const projectId = z.string().regex(/^[a-z][a-z0-9-]{2,62}$/).parse(process.argv[2]);
const jobId = z.string().uuid().parse(process.argv[3]);
const url = new URL(z.string().url().parse(process.env.DATABASE_URL));
url.pathname = `/company_os_${projectId.replaceAll("-", "_")}`;
const pool = new pg.Pool({ connectionString: url.toString(), max: 2, application_name: "company-os-video-retry" });

void new VideoStudioService(pool, { ...process.env, COMPANY_OS_PROJECT_ID: projectId }).retry(jobId).then((job) => {
  process.stdout.write(`${JSON.stringify({ id: job.id, state: job.state, canRetry: job.canRetry, projectId })}\n`);
}).finally(async () => {
  await pool.end();
});
