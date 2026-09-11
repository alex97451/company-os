import pg from "pg";
import { z } from "zod";
import {
  PostgresInitialProjectReviewStore,
  runInitialProjectReview,
} from "../src/lib/projects/initial-review";

const configSchema = z.object({
  registryDatabaseUrl: z.string().trim().min(1).max(4_096),
  projectDatabaseUrl: z.string().trim().min(1).max(4_096),
  projectId: z.string().regex(/^[a-z][a-z0-9-]{2,62}$/),
  runtimeId: z.string().trim().min(1).max(200),
}).strict();

const config = configSchema.parse({
  registryDatabaseUrl: process.env.COMPANY_OS_REGISTRY_DATABASE_URL,
  projectDatabaseUrl: process.env.DATABASE_URL,
  projectId: process.env.COMPANY_OS_PROJECT_ID,
  runtimeId: process.env.COMPANY_OS_RUNTIME_ID,
});

const registryPool = new pg.Pool({
  connectionString: config.registryDatabaseUrl,
  max: 1,
  application_name: `company-os-initial-review-registry:${config.projectId}`,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
});
const projectPool = new pg.Pool({
  connectionString: config.projectDatabaseUrl,
  max: 2,
  application_name: `company-os-initial-review-project:${config.projectId}`,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
});
const store = new PostgresInitialProjectReviewStore(
  registryPool,
  projectPool,
  config.projectId,
  config.runtimeId,
);

try {
  const review = await runInitialProjectReview(store);
  console.info(JSON.stringify({ level: "info", code: `initial_ceo_review_${review.state}` }));
} catch (error) {
  await store.recordFailure(error).catch(() => undefined);
  console.error(JSON.stringify({ level: "error", code: "initial_ceo_review_failed" }));
  process.exitCode = 1;
} finally {
  await Promise.all([
    registryPool.end().catch(() => undefined),
    projectPool.end().catch(() => undefined),
  ]);
}
