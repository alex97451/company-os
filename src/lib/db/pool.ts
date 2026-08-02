import { Pool, type PoolClient, type PoolConfig } from "pg";

let sharedPool: Pool | null = null;

export function createDatabasePool(env: NodeJS.ProcessEnv = process.env): Pool {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required; database access is disabled.");
  const config: PoolConfig = {
    connectionString,
    max: parseBoundedInteger(env.DATABASE_POOL_MAX, 10, 1, 50),
    connectionTimeoutMillis: parseBoundedInteger(env.DATABASE_CONNECT_TIMEOUT_MS, 5_000, 500, 30_000),
    idleTimeoutMillis: 30_000,
    application_name: env.DATABASE_APPLICATION_NAME ?? "company-os",
    ssl: env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
  };
  const pool = new Pool(config);
  pool.on("error", (error: Error & { code?: string }) => {
    const detail = typeof error.code === "string" && /^[A-Z0-9]{3,12}$/.test(error.code)
      ? error.code
      : "CONNECTION_INTERRUPTED";
    console.error(JSON.stringify({ level: "error", code: "database_idle_client_error", detail }));
  });
  return pool;
}

export function getDatabasePool(): Pool {
  sharedPool ??= createDatabasePool();
  return sharedPool;
}

export async function closeDatabasePool(): Promise<void> {
  if (!sharedPool) return;
  const pool = sharedPool;
  sharedPool = null;
  await pool.end();
}

export async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '30s'");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function parseBoundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid bounded integer: ${value}`);
  return parsed;
}
