import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { CockpitRepository } from "../lib/db/cockpit-repository";
import {
  AppServerV2Transport,
  CodexAppServerStdioClient,
  CodexDispatchSupervisor,
  DeterministicDemoTransport,
  PostgresAgentRunOutbox,
  PostgresCodexDispatchOutbox,
  type CodexTransport,
  type AppServerLifecycleEvent,
  truncateOwnerVisibleMessage,
} from "../lib/codex";
import { companyAgentIdSchema, COMPANY_AGENTS } from "../lib/agents";
import { CeoDelegationService, parseCeoDelegations } from "../lib/orchestration";
import { StrategicCompanySessionService } from "../lib/company-sessions";

const runtimeConfigSchema = z.object({
  mode: z.enum(["demo", "app-server-stdio"]).default("demo"),
  ceoThreadId: z.string().trim().min(1).max(256).optional(),
  codexCommand: z.string().trim().min(1).max(1_024).default("codex"),
  projectRoot: z.string().trim().min(1).max(2_048).default(process.cwd()),
  ceoModel: z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/).default("gpt-5.6-sol"),
  pollMs: z.coerce.number().int().min(100).max(1_000).default(500),
  leaseMs: z.coerce.number().int().min(5_000).max(120_000).default(15_000),
  purgeIntervalMs: z.coerce.number().int().min(60_000).max(86_400_000).default(3_600_000),
  agentThreadIds: z.record(z.string(), z.string().trim().min(1).max(256)).default({}),
}).strict();

export type CompanySupervisorConfig = z.infer<typeof runtimeConfigSchema>;
export type SafeSupervisorLogger = {
  info(code: string, metadata?: Record<string, string | number | boolean>): void;
  error(code: string, metadata?: Record<string, string | number | boolean>): void;
};

export function parseCompanySupervisorConfig(env: Readonly<Record<string, string | undefined>>): CompanySupervisorConfig {
  let agentThreadIds: Record<string, string> = {};
  if (env.OPS_CODEX_AGENT_THREADS_JSON) {
    try {
      const decoded: unknown = JSON.parse(env.OPS_CODEX_AGENT_THREADS_JSON);
      agentThreadIds = z.record(z.string(), z.string()).parse(decoded);
      for (const [agentId, threadId] of Object.entries(agentThreadIds)) {
        if (agentId === "ceo" || !companyAgentIdSchema.safeParse(agentId).success || !threadId.trim()) {
          throw new Error("OPS_CODEX_AGENT_THREADS_INVALID");
        }
      }
    } catch {
      throw new Error("OPS_CODEX_AGENT_THREADS_INVALID");
    }
  }
  const config = runtimeConfigSchema.parse({
    mode: env.OPS_CODEX_MODE,
    ceoThreadId: env.OPS_CODEX_CEO_THREAD_ID || undefined,
    codexCommand: env.OPS_CODEX_COMMAND,
    projectRoot: env.COMPANY_OS_PROJECT_ROOT,
    ceoModel: env.OPS_MODEL_EXPERT,
    pollMs: env.OPS_SUPERVISOR_POLL_MS,
    leaseMs: env.OPS_SUPERVISOR_LEASE_MS,
    purgeIntervalMs: env.OPS_EVENT_PURGE_INTERVAL_MS,
    agentThreadIds,
  });
  if (config.mode === "app-server-stdio" && !config.ceoThreadId) {
    throw new Error("OPS_CODEX_CEO_THREAD_ID_REQUIRED");
  }
  if (config.mode === "app-server-stdio" && Object.keys(config.agentThreadIds).length !== 11) {
    throw new Error("OPS_CODEX_ALL_AGENT_THREAD_IDS_REQUIRED");
  }
  return config;
}

export async function bootstrapCeoInstance(pool: Pool, config: CompanySupervisorConfig): Promise<string> {
  const threadId = config.mode === "demo" ? "demo-ceo-local" : config.ceoThreadId;
  if (!threadId) throw new Error("OPS_CODEX_CEO_THREAD_ID_REQUIRED");
  const protocolVersion = config.mode === "demo" ? "demo-v1" : "codex-app-server/v2";
  const existing = await pool.query<{ id: string; thread_id: string }>(
    "SELECT id, thread_id FROM cockpit_agent_instances WHERE agent_id = 'ceo' AND retired_at IS NULL",
  );
  const active = existing.rows[0];
  if (active) {
    if (active.thread_id !== threadId) await assertThreadReplacementSafe(pool, active.id, "CEO_THREAD_MAPPING_CONFLICT");
    await pool.query(
      "UPDATE cockpit_agent_instances SET thread_id = $2, heartbeat_at = now(), state = 'waiting' WHERE id = $1",
      [active.id, threadId],
    );
    return active.id;
  }
  const id = randomUUID();
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO cockpit_agent_instances
      (id, agent_id, thread_id, transport, protocol_version, state, heartbeat_at)
     VALUES ($1,'ceo',$2,'app_server',$3,'waiting',now())
     ON CONFLICT (thread_id) DO UPDATE SET
       transport = EXCLUDED.transport,
       protocol_version = EXCLUDED.protocol_version,
       state = 'waiting',
       heartbeat_at = now(),
       retired_at = NULL
     WHERE cockpit_agent_instances.agent_id = EXCLUDED.agent_id
     RETURNING id`,
    [id, threadId, protocolVersion],
  );
  const instanceId = inserted.rows[0]?.id;
  if (!instanceId) throw new Error("CEO_THREAD_MAPPING_CONFLICT");
  return instanceId;
}

export async function bootstrapSpecialistInstances(pool: Pool, config: CompanySupervisorConfig): Promise<void> {
  const entries = config.mode === "demo"
    ? Object.keys(COMPANY_AGENTS).filter((id) => id !== "ceo").map((id) => [id, `demo-${id}-local`] as const)
    : Object.entries(config.agentThreadIds);
  for (const [rawAgentId, threadId] of entries) {
    const agentId = companyAgentIdSchema.exclude(["ceo"]).parse(rawAgentId);
    const existing = await pool.query<{ id: string; thread_id: string }>(
      "SELECT id, thread_id FROM cockpit_agent_instances WHERE agent_id = $1 AND retired_at IS NULL",
      [agentId],
    );
    if (existing.rows[0]) {
      if (config.mode !== "demo" && existing.rows[0].thread_id !== threadId) {
        await assertThreadReplacementSafe(pool, existing.rows[0].id, `AGENT_THREAD_MAPPING_CONFLICT_${agentId}`);
      }
      await pool.query(
        "UPDATE cockpit_agent_instances SET thread_id = $2, heartbeat_at = now(), state = 'waiting' WHERE id = $1",
        [existing.rows[0].id, threadId],
      );
      continue;
    }
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO cockpit_agent_instances
        (id, agent_id, thread_id, transport, protocol_version, state, heartbeat_at)
       VALUES ($1,$2,$3,'app_server',$4,'waiting',now())
       ON CONFLICT (thread_id) DO UPDATE SET
         transport = EXCLUDED.transport,
         protocol_version = EXCLUDED.protocol_version,
         state = 'waiting',
         heartbeat_at = now(),
         retired_at = NULL
       WHERE cockpit_agent_instances.agent_id = EXCLUDED.agent_id
       RETURNING id`,
      [randomUUID(), agentId, threadId, config.mode === "demo" ? "demo-v1" : "codex-app-server/v2"],
    );
    if (!inserted.rows[0]) throw new Error(`AGENT_THREAD_MAPPING_CONFLICT_${agentId}`);
  }
}

async function assertThreadReplacementSafe(pool: Pool, instanceId: string, conflictCode: string): Promise<void> {
  const activeRun = await pool.query(
    `SELECT 1 FROM cockpit_runs
     WHERE agent_instance_id = $1 AND state IN ('dispatching','working','interruption_requested')
     LIMIT 1`,
    [instanceId],
  );
  if (activeRun.rows[0]) throw new Error(conflictCode);
}

export async function runSupervisorLoop(input: {
  pool: Pool;
  config: CompanySupervisorConfig;
  signal: AbortSignal;
  logger?: SafeSupervisorLogger;
  transport?: CodexTransport;
  client?: CodexAppServerStdioClient;
  supervisor?: Pick<CodexDispatchSupervisor, "processOne">;
}): Promise<void> {
  const logger = input.logger ?? silentLogger;
  await bootstrapCeoInstance(input.pool, input.config);
  await bootstrapSpecialistInstances(input.pool, input.config);

  let client = input.client;
  let supervisor = input.supervisor;
  const lifecycleQueue: AppServerLifecycleEvent[] = [];
  let outbox: PostgresCodexDispatchOutbox | undefined;
  let agentOutbox: PostgresAgentRunOutbox | undefined;
  let agentSupervisor: CodexDispatchSupervisor | undefined;
  let activeTransport: CodexTransport | undefined = input.transport;
  if (!supervisor) {
    let transport = activeTransport;
    if (!transport && input.config.mode === "demo") {
      transport = new DeterministicDemoTransport();
    } else if (!transport) {
      client = client ?? new CodexAppServerStdioClient({
        command: input.config.codexCommand,
        workspaceRoot: input.config.projectRoot,
        onLifecycleEvent: (event) => {
          lifecycleQueue.push(event);
        },
      });
      await client.start();
      transport = new AppServerV2Transport(client);
    }
    activeTransport = transport;
    outbox = new PostgresCodexDispatchOutbox(input.pool, {
      model: input.config.ceoModel,
      effort: "high",
    });
    supervisor = new CodexDispatchSupervisor(outbox, transport);
    agentOutbox = new PostgresAgentRunOutbox(input.pool);
    agentSupervisor = new CodexDispatchSupervisor(agentOutbox, transport);
  }
  const cockpit = new CockpitRepository(input.pool);
  const delegations = new CeoDelegationService(input.pool);
  const strategicSessions = new StrategicCompanySessionService(input.pool);
  const ownerId = `local-supervisor-${process.pid}`;
  let nextPurgeAt = 0;
  let haltReported = false;

  if (outbox) {
    const expired = await outbox.reconcileExpiredLeases();
    if (expired > 0) logger.error("codex_expired_leases_reconciliation_required", { count: expired });
  }
  if (agentOutbox) {
    const expired = await agentOutbox.reconcileExpiredLeases();
    if (expired > 0) logger.error("agent_expired_leases_reconciliation_required", { count: expired });
  }

  logger.info("company_supervisor_started", { mode: input.config.mode, pollMs: input.config.pollMs });
  try {
    while (!input.signal.aborted) {
      await cockpit.heartbeatRuntime("supervisor", "connected");
      const bridgeHealth = activeTransport ? await activeTransport.health().catch(() => "offline" as const) : "degraded";
      await cockpit.heartbeatRuntime("bridge", bridgeHealth, bridgeHealth === "connected" ? undefined : "transport_unavailable");
      await cockpit.heartbeatRuntime("codex", bridgeHealth, bridgeHealth === "connected" ? undefined : "codex_unreachable");
      if (outbox && activeTransport) {
        await reconcileRequestedPause(cockpit, {
          listDispatchedTurns: async () => [
            ...await outbox.listDispatchedTurns(),
            ...await (agentOutbox?.listDispatchedTurns() ?? []),
          ],
        }, activeTransport, logger);
      }
      const result = await supervisor.processOne(ownerId, input.config.leaseMs);
      if (result.status !== "idle" && result.status !== "supervisor_halted") {
        logger.info(`dispatch_${result.status}`);
      }
      if (result.status === "supervisor_halted" && !haltReported) {
        haltReported = true;
        logger.error("supervisor_halted_reconciliation_required");
      }
      if (outbox && result.status === "accepted" && input.config.mode === "demo") {
        await outbox.completeTurn({
          remoteTurnId: result.receipt.remoteTurnId,
          remoteThreadId: result.receipt.remoteThreadId,
          status: "completed",
          finalMessage: "Démo — Le CEO a reçu votre message local. Aucune action externe n’a été lancée.",
          demo: true,
        });
      }
      const agentResult = agentSupervisor
        ? await agentSupervisor.processOne(`${ownerId}-agent`, input.config.leaseMs)
        : { status: "idle" as const };
      if (agentOutbox && agentResult.status === "accepted" && input.config.mode === "demo") {
        await agentOutbox.completeTurn({
          remoteTurnId: agentResult.receipt.remoteTurnId,
          remoteThreadId: agentResult.receipt.remoteThreadId,
          status: "completed",
          finalMessage: "Démo — tâche spécialiste exécutée localement, sans appel externe.",
          demo: true,
        });
      }
      if (outbox) {
        while (lifecycleQueue.length > 0) {
          const event = lifecycleQueue.shift();
          if (!event) continue;
          if (event.type === "process_stopped") {
            logger.error("codex_process_stopped", {
              reason: event.reason,
              ...(event.diagnostic ? { diagnostic: event.diagnostic } : {}),
            });
            const affected = await outbox.markProcessStopped(event.reason);
            const affectedRuns = await agentOutbox?.markProcessStopped(event.reason) ?? 0;
            const detailCode = event.diagnostic
              ? `process_${event.reason}_${event.diagnostic}`
              : `process_${event.reason}`;
            await cockpit.heartbeatRuntime("bridge", "offline", detailCode);
            await cockpit.heartbeatRuntime("codex", "offline", detailCode);
            if (affected > 0) logger.error("codex_process_stopped_reconciliation_required", { count: affected });
            if (affectedRuns > 0) logger.error("agent_process_stopped_reconciliation_required", { count: affectedRuns });
            if (event.diagnostic) logger.error(`codex_${event.diagnostic}`);
            continue;
          }
          if (event.type !== "turn_completed") continue;
          const ownerCommand = await input.pool.query<{ id: string }>(
            "SELECT id FROM cockpit_commands WHERE remote_turn_id = $1",
            [event.turnId],
          );
          let completion: "completed" | "reconciliation_required" | "not_found";
          if (ownerCommand.rows[0]) {
            try {
              const parsed = event.finalMessage
                ? parseCeoDelegations(event.finalMessage)
                : { visibleText: "", delegation: { version: 1 as const, tasks: [] } };
              if (event.status === "completed" && parsed.delegation.tasks.length > 0) {
                await delegations.delegate({
                  ceoTurnId: event.turnId,
                  sourceCommandId: ownerCommand.rows[0].id,
                  delegation: parsed.delegation,
                });
              }
              completion = await outbox.completeTurn({
                remoteTurnId: event.turnId,
                ...(event.threadId ? { remoteThreadId: event.threadId } : {}),
                status: event.status,
                ...(parsed.visibleText ? { finalMessage: truncateOwnerVisibleMessage(parsed.visibleText) } : {}),
                demo: false,
              });
            } catch {
              completion = await outbox.completeTurn({
                remoteTurnId: event.turnId,
                ...(event.threadId ? { remoteThreadId: event.threadId } : {}),
                status: "unknown",
                demo: false,
              });
              logger.error("ceo_delegation_rejected");
            }
          } else if (agentOutbox) {
            completion = await agentOutbox.completeTurn({
              remoteTurnId: event.turnId,
              ...(event.threadId ? { remoteThreadId: event.threadId } : {}),
              status: event.status,
              ...(event.finalMessage ? { finalMessage: event.finalMessage } : {}),
              demo: false,
            });
          } else {
            completion = "not_found";
          }
          if (completion === "not_found") logger.error("codex_turn_correlation_not_found");
          if (completion === "reconciliation_required") logger.error("codex_turn_reconciliation_required");
          const pause = await cockpit.getPauseState();
          const activeTurns = [
            ...await outbox.listDispatchedTurns(),
            ...await (agentOutbox?.listDispatchedTurns() ?? []),
          ];
          if (pause.state !== "running" && activeTurns.length === 0) {
            await cockpit.setGeneralPause("confirmed_stopped", "supervisor", pause.reason ?? undefined);
          }
        }
      }
      if (outbox) {
        const expired = await outbox.reconcileExpiredLeases();
        if (expired > 0) logger.error("codex_expired_leases_reconciliation_required", { count: expired });
      }
      if (agentOutbox) {
        const expired = await agentOutbox.reconcileExpiredLeases();
        if (expired > 0) logger.error("agent_expired_leases_reconciliation_required", { count: expired });
      }
      const sessionsAdvanced = await strategicSessions.advanceReadySessions().catch(() => {
        logger.error("strategic_session_advancement_failed");
        return 0;
      });
      if (sessionsAdvanced > 0) logger.info("strategic_sessions_advanced", { count: sessionsAdvanced });
      if (Date.now() >= nextPurgeAt) {
        const purged = await cockpit.purgeExpiredEvents();
        if (purged > 0) logger.info("cockpit_events_purged", { count: purged });
        nextPurgeAt = Date.now() + input.config.purgeIntervalMs;
      }
      await abortableDelay(input.config.pollMs, input.signal);
    }
  } finally {
    if (outbox) await outbox.markProcessStopped("requested").catch(() => undefined);
    if (agentOutbox) await agentOutbox.markProcessStopped("requested").catch(() => undefined);
    await cockpit.heartbeatRuntime("supervisor", "offline", "process_stopped").catch(() => undefined);
    await cockpit.heartbeatRuntime("bridge", "offline", "process_stopped").catch(() => undefined);
    await cockpit.heartbeatRuntime("codex", "offline", "process_stopped").catch(() => undefined);
    if (client) await client.stop();
    logger.info("company_supervisor_stopped");
  }
}

export async function reconcileRequestedPause(
  cockpit: Pick<CockpitRepository, "getPauseState" | "setGeneralPause">,
  outbox: Pick<PostgresCodexDispatchOutbox, "listDispatchedTurns">,
  transport: Pick<CodexTransport, "interrupt">,
  logger: SafeSupervisorLogger = silentLogger,
): Promise<void> {
  const pause = await cockpit.getPauseState();
  if (pause.state !== "interruption_requested") return;
  const turns = await outbox.listDispatchedTurns();
  if (turns.length === 0) {
    await cockpit.setGeneralPause("confirmed_stopped", "supervisor", pause.reason ?? undefined);
    return;
  }
  if (!transport.interrupt) {
    await cockpit.setGeneralPause("work_still_active", "supervisor", pause.reason ?? undefined);
    logger.error("codex_interrupt_unavailable", { count: turns.length });
    return;
  }
  let uncertain = false;
  for (const turn of turns) {
    const result = await transport.interrupt(turn.remoteTurnId);
    if (result !== "requested") uncertain = true;
  }
  if (uncertain) {
    await cockpit.setGeneralPause("work_still_active", "supervisor", pause.reason ?? undefined);
    logger.error("codex_interrupt_outcome_uncertain", { count: turns.length });
  }
}

const silentLogger: SafeSupervisorLogger = { info: () => undefined, error: () => undefined };

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
