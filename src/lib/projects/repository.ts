import type { Pool } from "pg";
import { withTransaction } from "@/lib/db/pool";
import { assertProjectPathAllowed } from "./path-policy";
import {
  projectDiscoverySchema,
  projectInitialReviewSchema,
  projectInitializationProgressSchema,
  type ProjectDiscovery,
  type ProjectInitialReview,
  type ProjectInitializationProgress,
  type RegisterCompanyProject,
} from "./manifest";

export type CompanyProjectView = {
  id: string;
  displayName: string;
  kind: RegisterCompanyProject["kind"];
  workspacePath: string | null;
  isolationMode: "dedicated_runtime";
  status: "registered" | "online" | "offline" | "blocked" | "error";
  current: boolean;
  lastHeartbeatAt: string | null;
  lastErrorCode: string | null;
  runtimeState: "starting" | "online" | "stopping" | "offline" | "error" | null;
  webPort: number | null;
  cockpitUrl: string | null;
  initializedAt: string | null;
  discovery: ProjectDiscovery | null;
  initialization: ProjectInitializationProgress | null;
  initialReview: ProjectInitialReview | null;
};

type ProjectRow = {
  id: string;
  display_name: string;
  kind: RegisterCompanyProject["kind"];
  workspace_path: string | null;
  isolation_mode: "dedicated_runtime";
  effective_status: CompanyProjectView["status"];
  last_heartbeat_at: Date | null;
  last_error_code: string | null;
  runtime_state: CompanyProjectView["runtimeState"];
  web_port: number | null;
  initialized_at: string | null;
  discovery: unknown;
  initialization: unknown;
  initial_review: unknown;
};

export type RegisteredCompanyProject = {
  id: string;
  displayName: string;
  kind: RegisterCompanyProject["kind"];
  workspacePath: string;
};

export class CompanyProjectRepository {
  constructor(private readonly pool: Pool) {}

  async ensureCurrent(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const id = env.COMPANY_OS_PROJECT_ID?.trim() || "company-os";
    const displayName = env.COMPANY_OS_PROJECT_NAME?.trim() || "Company OS";
    const workspacePath = assertProjectPathAllowed(env.COMPANY_OS_PROJECT_ROOT?.trim() || process.cwd(), env);
    const runtimeId = env.COMPANY_OS_RUNTIME_ID?.trim() || `local-${process.pid}`;
    const webPort = safePort(env.APP_URL);
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO company_projects
           (id, display_name, kind, workspace_path, isolation_mode, status, manifest, last_heartbeat_at)
         VALUES ($1, $2, 'saas', $3, 'dedicated_runtime', 'online',
                 jsonb_build_object(
                   'version', 1,
                   'externalWorkEnabledByDefault', false,
                   'initializedAt', now()::text,
                   'bootstrapVersion', 1
                 ), now())
         ON CONFLICT (id) DO UPDATE
           SET display_name = EXCLUDED.display_name,
               workspace_path = EXCLUDED.workspace_path,
               status = 'online',
               manifest = company_projects.manifest || jsonb_build_object(
                 'initializedAt', COALESCE(company_projects.manifest ->> 'initializedAt', now()::text),
                 'bootstrapVersion', 1
               ),
               last_heartbeat_at = now(),
               last_error_code = NULL,
               updated_at = now()`,
        [id, displayName, workspacePath],
      );
      await client.query(
        `INSERT INTO company_project_runtimes
           (project_id, runtime_id, state, process_id, web_port, started_at, last_heartbeat_at)
         VALUES ($1, $2, 'online', $3, $4, now(), now())
         ON CONFLICT (project_id) DO UPDATE
           SET runtime_id = EXCLUDED.runtime_id,
               state = 'online',
               process_id = EXCLUDED.process_id,
               web_port = EXCLUDED.web_port,
               last_heartbeat_at = now(),
               updated_at = now()`,
        [id, runtimeId, process.pid, webPort],
      );
    });
  }

  async list(env: NodeJS.ProcessEnv = process.env): Promise<CompanyProjectView[]> {
    const currentId = env.COMPANY_OS_PROJECT_ID?.trim() || "company-os";
    const result = await this.pool.query<ProjectRow>(
      `SELECT project.id, project.display_name, project.kind, project.workspace_path,
              project.isolation_mode,
              CASE
                WHEN runtime.state = 'online' AND runtime.last_heartbeat_at > now() - interval '45 seconds' THEN 'online'
                WHEN project.status = 'online' THEN 'offline'
                ELSE project.status
              END AS effective_status,
              COALESCE(runtime.last_heartbeat_at, project.last_heartbeat_at) AS last_heartbeat_at,
              project.last_error_code,
              runtime.state AS runtime_state, runtime.web_port,
              project.manifest ->> 'initializedAt' AS initialized_at,
              project.manifest -> 'discovery' AS discovery,
              project.manifest -> 'initialization' AS initialization,
              project.manifest -> 'initialReview' AS initial_review
         FROM company_projects project
         LEFT JOIN company_project_runtimes runtime ON runtime.project_id = project.id
        WHERE ($2 = true OR project.id = $1)
        ORDER BY (project.id = $1) DESC, project.display_name`,
      [currentId, currentId === (env.COMPANY_OS_REGISTRY_PROJECT_ID?.trim() || "company-os")],
    );
    return result.rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      kind: row.kind,
      workspacePath: row.workspace_path,
      isolationMode: row.isolation_mode,
      status: row.id === currentId && env.COMPANY_OS_RUNTIME_ID ? "online" : row.effective_status,
      current: row.id === currentId,
      lastHeartbeatAt: row.id === currentId && env.COMPANY_OS_RUNTIME_ID
        ? new Date().toISOString()
        : row.last_heartbeat_at?.toISOString() ?? null,
      lastErrorCode: row.last_error_code,
      runtimeState: row.id === currentId && env.COMPANY_OS_RUNTIME_ID ? "online" : row.runtime_state,
      webPort: row.web_port,
      cockpitUrl: row.web_port ? `http://localhost:${row.web_port}/ops` : null,
      initializedAt: row.initialized_at,
      discovery: nullableParsed(projectDiscoverySchema, row.discovery),
      initialization: nullableParsed(projectInitializationProgressSchema, row.initialization),
      initialReview: nullableParsed(projectInitialReviewSchema, row.initial_review),
    }));
  }

  async getRegistered(id: string, env: NodeJS.ProcessEnv = process.env): Promise<RegisteredCompanyProject> {
    const result = await this.pool.query<{
      id: string;
      display_name: string;
      kind: RegisterCompanyProject["kind"];
      workspace_path: string | null;
    }>(
      `SELECT id, display_name, kind, workspace_path
         FROM company_projects
        WHERE id = $1`,
      [id],
    );
    const project = result.rows[0];
    if (!project) throw new Error("PROJECT_NOT_FOUND");
    if (!project.workspace_path) throw new Error("PROJECT_PATH_NOT_CONFIGURED");
    return {
      id: project.id,
      displayName: project.display_name,
      kind: project.kind,
      workspacePath: assertProjectPathAllowed(project.workspace_path, env),
    };
  }

  async register(
    input: RegisterCompanyProject,
    discovery: ProjectDiscovery,
    progress: ProjectInitializationProgress,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<void> {
    const workspacePath = assertProjectPathAllowed(input.workspacePath, env);
    if (workspacePath !== assertProjectPathAllowed(discovery.canonicalPath, env)) throw new Error("PROJECT_PREFLIGHT_PATH_MISMATCH");
    const validatedDiscovery = projectDiscoverySchema.parse(discovery);
    const validatedProgress = projectInitializationProgressSchema.parse(progress);
    try {
      await this.pool.query(
        `INSERT INTO company_projects
         (id, display_name, kind, workspace_path, isolation_mode, status, manifest)
       VALUES ($1, $2, $3, $4, 'dedicated_runtime', 'registered',
               jsonb_build_object(
                 'version', 1,
                 'externalWorkEnabledByDefault', false,
                 'discovery', $5::jsonb,
                 'initialization', $6::jsonb
               ))
       ON CONFLICT (id) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             kind = EXCLUDED.kind,
             workspace_path = EXCLUDED.workspace_path,
             status = CASE WHEN company_projects.status = 'online' THEN 'online' ELSE 'registered' END,
             manifest = company_projects.manifest || jsonb_build_object(
               'discovery', $5::jsonb,
               'initialization', $6::jsonb
             ),
             last_error_code = NULL,
             updated_at = now()`,
        [input.id, input.displayName, input.kind, workspacePath, JSON.stringify(validatedDiscovery), JSON.stringify(validatedProgress)],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new Error("PROJECT_PATH_ALREADY_CONNECTED");
      throw error;
    }
  }

  async disconnect(id: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const currentId = env.COMPANY_OS_PROJECT_ID?.trim() || "company-os";
    if (id === currentId) throw new Error("CURRENT_PROJECT_CANNOT_DISCONNECT");
    const active = await this.pool.query(
      `SELECT 1
         FROM company_project_runtimes
        WHERE project_id = $1
          AND state IN ('starting', 'online')
          AND last_heartbeat_at > now() - interval '30 seconds'`,
      [id],
    );
    if (active.rowCount) throw new Error("PROJECT_RUNTIME_ACTIVE");
    const result = await this.pool.query(
      "DELETE FROM company_projects WHERE id = $1 RETURNING id",
      [id],
    );
    if (!result.rowCount) throw new Error("PROJECT_NOT_FOUND");
  }

  async markRuntimeStarting(
    projectId: string,
    runtimeId: string,
    webPort: number,
    discovery: ProjectDiscovery,
    progress: ProjectInitializationProgress,
  ): Promise<void> {
    const validatedDiscovery = projectDiscoverySchema.parse(discovery);
    const validatedProgress = projectInitializationProgressSchema.parse(progress);
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `UPDATE company_projects
            SET status = 'registered',
                manifest = manifest || jsonb_build_object(
                  'initializedAt', now()::text,
                  'bootstrapVersion', 1,
                  'discovery', $2::jsonb,
                  'initialization', $3::jsonb
                ),
                last_error_code = NULL,
                updated_at = now()
          WHERE id = $1`,
        [projectId, JSON.stringify(validatedDiscovery), JSON.stringify(validatedProgress)],
      );
      await client.query(
        `INSERT INTO company_project_runtimes
           (project_id, runtime_id, state, web_port, started_at, last_heartbeat_at, metadata)
         VALUES ($1, $2, 'starting', $3, now(), now(), '{"bootstrapVersion":2}'::jsonb)
         ON CONFLICT (project_id) DO UPDATE
           SET runtime_id = EXCLUDED.runtime_id,
                state = 'starting',
                process_id = NULL,
                web_port = EXCLUDED.web_port,
               started_at = now(),
               last_heartbeat_at = now(),
               metadata = EXCLUDED.metadata,
               updated_at = now()`,
        [projectId, runtimeId, webPort],
      );
    });
  }

  async allocateRuntimePort(projectId: string): Promise<number> {
    const result = await this.pool.query<{ project_id: string; web_port: number | null }>(
      "SELECT project_id, web_port FROM company_project_runtimes WHERE web_port IS NOT NULL",
    );
    const existing = result.rows.find((row) => row.project_id === projectId)?.web_port;
    if (existing) return existing;
    const used = new Set(result.rows.map((row) => row.web_port).filter((port): port is number => port !== null));
    for (let port = 3200; port <= 3399; port += 1) if (!used.has(port)) return port;
    throw new Error("PROJECT_RUNTIME_PORTS_EXHAUSTED");
  }

  async attachRuntimeProcess(projectId: string, runtimeId: string, processId: number): Promise<void> {
    const result = await this.pool.query(
      `UPDATE company_project_runtimes
          SET process_id = $3, updated_at = now()
        WHERE project_id = $1 AND runtime_id = $2 AND state IN ('starting', 'online')`,
      [projectId, runtimeId, processId],
    );
    if (result.rowCount !== 1) throw new Error("PROJECT_RUNTIME_START_RACE");
  }

  async markInitializationError(
    projectId: string,
    errorCode: string,
    progress: ProjectInitializationProgress | null = null,
  ): Promise<void> {
    const validatedProgress = progress ? projectInitializationProgressSchema.parse(progress) : null;
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `UPDATE company_projects
            SET status = 'error',
                last_error_code = $2,
                manifest = CASE
                  WHEN $3::jsonb IS NULL THEN manifest
                  ELSE manifest || jsonb_build_object('initialization', $3::jsonb)
                END,
                updated_at = now()
          WHERE id = $1`,
        [projectId, errorCode.slice(0, 120), validatedProgress ? JSON.stringify(validatedProgress) : null],
      );
      await client.query(
        `UPDATE company_project_runtimes
            SET state = 'error', updated_at = now()
          WHERE project_id = $1`,
        [projectId],
      );
    });
  }

  async runtimeProcess(projectId: string): Promise<{
    processId: number | null;
    runtimeId: string;
    state: "starting" | "online" | "stopping" | "offline" | "error";
    heartbeatAt: Date | null;
  }> {
    const result = await this.pool.query<{
      process_id: number | null;
      runtime_id: string;
      state: "starting" | "online" | "stopping" | "offline" | "error";
      last_heartbeat_at: Date | null;
    }>(
      `SELECT process_id, runtime_id, state, last_heartbeat_at
         FROM company_project_runtimes
        WHERE project_id = $1`,
      [projectId],
    );
    const runtime = result.rows[0];
    if (!runtime) throw new Error("PROJECT_RUNTIME_NOT_FOUND");
    return {
      processId: runtime.process_id,
      runtimeId: runtime.runtime_id,
      state: runtime.state,
      heartbeatAt: runtime.last_heartbeat_at,
    };
  }

  async markRuntimeOffline(projectId: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `UPDATE company_project_runtimes
            SET state = 'offline', process_id = NULL, updated_at = now()
          WHERE project_id = $1`,
        [projectId],
      );
      await client.query(
        `UPDATE company_projects
            SET status = 'offline', updated_at = now()
          WHERE id = $1`,
        [projectId],
      );
    });
  }
}

function nullableParsed<T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T } }, value: unknown): T | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data ?? null : null;
}

function safePort(appUrl: string | undefined): number | null {
  if (!appUrl) return null;
  try {
    const url = new URL(appUrl);
    const value = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return Number.isInteger(value) && value >= 1024 && value <= 65_535 ? value : null;
  } catch {
    return null;
  }
}
