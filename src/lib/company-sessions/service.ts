import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { CompanyAgentId } from "@/lib/agents/registry";
import { assertSafeOwnerMessage, findOwnerMessagePolicyViolation } from "@/lib/cockpit/owner-message-policy";
import { safeOperationalPayloadSchema } from "@/lib/cockpit/domain";
import { withTransaction } from "@/lib/db/pool";
import { CeoDelegationService, parseCeoDelegations } from "@/lib/orchestration";
import { assertProjectPathAllowed } from "@/lib/projects/path-policy";
import {
  companySessionControlSchema,
  companySessionViewSchema,
  createCompanySessionSchema,
  type CompanySessionView,
} from "./contracts";

const ACTIVE_STATES = ["starting", "council", "planning", "executing", "waiting_approval", "verifying", "blocked", "paused", "stopping"];
const GLOBAL_PARTICIPANTS: CompanyAgentId[] = [
  "product",
  "design_conversion",
  "engineering",
  "qa_safety",
  "growth",
  "content_brand",
  "sales_partnerships",
  "customer_care",
  "finance_risk",
  "reliability_privacy",
];
const TARGETED_FALLBACK: CompanyAgentId[] = [
  "product", "engineering", "design_conversion", "qa_safety",
];
const GLOBAL_REVIEW_MISSION =
  "Faire le point sur l’état réel de l’entreprise, identifier les opportunités et risques prioritaires, puis décider et exécuter les tâches locales les plus utiles pour la faire prospérer durablement.";
const GLOBAL_REVIEW_OUTCOME =
  "Un diagnostic partagé, des priorités justifiées, jusqu’à cinq tâches locales exécutées et un rapport final vérifié.";

type SessionRow = {
  id: string;
  project_id: string;
  mode: "global" | "targeted";
  mission: string;
  expected_outcome: string | null;
  owner_focus: string | null;
  state: CompanySessionView["state"];
  resume_state: CompanySessionView["state"] | null;
  stage: CompanySessionView["stage"];
  aggregate_version: number;
  fencing_token: string;
  stop_requested: boolean;
  max_tasks: number;
  max_duration_minutes: number;
  final_report: string | null;
  failure_code: string | null;
  started_at: Date;
  completed_at: Date | null;
  updated_at: Date;
};

type CompanyReviewSnapshot = {
  capturedAt: string;
  projectStatus: string;
  runtimeState: string;
  runtimeFresh: boolean;
  taskCounts: {
    queued: number;
    working: number;
    actionRequired: number;
    verification: number;
    done: number;
    problem: number;
    paused: number;
  };
  agentCounts: {
    ready: number;
    working: number;
    attention: number;
  };
  pendingApprovals: number;
};

export class StrategicCompanySessionService {
  constructor(
    private readonly pool: Pool,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async create(raw: unknown): Promise<CompanySessionView> {
    const input = createCompanySessionSchema.parse(raw);
    const mission = input.mode === "global" ? GLOBAL_REVIEW_MISSION : input.mission;
    const expectedOutcome = input.mode === "global" ? GLOBAL_REVIEW_OUTCOME : input.expectedOutcome;
    assertSafeOwnerMessage(mission);
    if (expectedOutcome) assertSafeOwnerMessage(expectedOutcome);
    if (input.ownerFocus) assertSafeOwnerMessage(input.ownerFocus);
    await this.assertRealLocalReadiness();
    const projectId = currentProjectId(this.env);
    const companySnapshot = input.mode === "global"
      ? await this.buildCompanyReviewSnapshot(projectId)
      : null;

    const sessionId = randomUUID();
    const participants = input.mode === "global"
      ? GLOBAL_PARTICIPANTS
      : chooseTargetedParticipants(`${mission} ${input.ownerFocus ?? ""}`);

    await withTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`company-session:${projectId}`]);
      const active = await client.query(
        "SELECT 1 FROM company_sessions WHERE project_id = $1 AND state = ANY($2::text[]) LIMIT 1",
        [projectId, ACTIVE_STATES],
      );
      if (active.rowCount) throw new Error("COMPANY_SESSION_ALREADY_ACTIVE");
      await client.query(
        `INSERT INTO company_sessions
          (id, project_id, mode, mission, expected_outcome, owner_focus, state, stage,
           max_tasks, max_duration_minutes, external_spend_cap_usd_micros)
         VALUES ($1,$2,$3,$4,$5,$6,'starting','round_1',$7,$8,0)`,
        [sessionId, projectId, input.mode, mission, expectedOutcome ?? null,
          input.ownerFocus ?? null, input.maxTasks, input.maxDurationMinutes],
      );
      for (const [order, agentId] of participants.entries()) {
        await client.query(
          `INSERT INTO company_session_participants (session_id, agent_id, invitation_order)
           VALUES ($1,$2,$3)`,
          [sessionId, agentId, order],
        );
        await queueContribution(client, {
          sessionId,
          round: 1,
          kind: "proposal",
          agentId,
          title: input.mode === "global"
            ? "Bilan de l’entreprise et priorités recommandées"
            : `Proposition stratégique — ${mission.slice(0, 180)}`,
          intendedOutcome: councilPrompt({
            mission,
            expected: expectedOutcome,
            focus: input.ownerFocus,
            agentId,
            mode: input.mode,
            companySnapshot,
          }),
        }, this.env);
      }
      await client.query(
        "UPDATE company_sessions SET state = 'council', aggregate_version = 1, updated_at = now() WHERE id = $1",
        [sessionId],
      );
      await sessionEvent(client, sessionId, "session.started", {
        mode: input.mode, participantCount: participants.length, externalSpendUsdMicros: 0,
      });
      if (companySnapshot) {
        await sessionEvent(client, sessionId, "session.company_review.captured", companySnapshot);
      }
    });
    return this.get(sessionId);
  }

  async list(): Promise<CompanySessionView[]> {
    const sessions = await this.pool.query<SessionRow>(
      "SELECT * FROM company_sessions WHERE project_id = $1 ORDER BY created_at DESC LIMIT 20",
      [currentProjectId(this.env)],
    );
    return Promise.all(sessions.rows.map((row) => this.hydrate(row)));
  }

  async get(idRaw: string): Promise<CompanySessionView> {
    const id = z.string().uuid().parse(idRaw);
    const result = await this.pool.query<SessionRow>(
      "SELECT * FROM company_sessions WHERE id = $1 AND project_id = $2",
      [id, currentProjectId(this.env)],
    );
    if (!result.rows[0]) throw new Error("COMPANY_SESSION_NOT_FOUND");
    return this.hydrate(result.rows[0]);
  }

  async control(idRaw: string, raw: unknown): Promise<CompanySessionView> {
    const id = z.string().uuid().parse(idRaw);
    const input = companySessionControlSchema.parse(raw);
    await withTransaction(this.pool, async (client) => {
      const current = await client.query<SessionRow>(
        "SELECT * FROM company_sessions WHERE id = $1 AND project_id = $2 FOR UPDATE",
        [id, currentProjectId(this.env)],
      );
      const session = current.rows[0];
      if (!session) throw new Error("COMPANY_SESSION_NOT_FOUND");
      if (session.aggregate_version !== input.expectedVersion) throw new Error("COMPANY_SESSION_STALE_VERSION");
      if (input.action === "pause") {
        if (!["council", "planning", "executing", "verifying", "blocked"].includes(session.state)) {
          throw new Error("COMPANY_SESSION_CANNOT_PAUSE");
        }
        await client.query(
          `UPDATE company_sessions SET state = 'paused', resume_state = $2,
             aggregate_version = aggregate_version + 1, fencing_token = fencing_token + 1, updated_at = now()
           WHERE id = $1`,
          [id, session.state],
        );
        await sessionEvent(client, id, "session.pause.confirmed", {});
      } else if (input.action === "resume") {
        if (session.state !== "paused" && session.state !== "blocked") throw new Error("COMPANY_SESSION_CANNOT_RESUME");
        const resumeState = session.state === "paused" ? session.resume_state ?? stateForStage(session.stage) : stateForStage(session.stage);
        await client.query(
          `UPDATE company_sessions SET state = $2, resume_state = NULL, failure_code = NULL,
             aggregate_version = aggregate_version + 1, fencing_token = fencing_token + 1, updated_at = now()
           WHERE id = $1`,
          [id, resumeState],
        );
        await sessionEvent(client, id, "session.resumed", {});
      } else {
        if (["completed", "stopped", "failed"].includes(session.state)) throw new Error("COMPANY_SESSION_ALREADY_TERMINAL");
        await client.query(
          `UPDATE company_sessions SET state = 'stopping', stop_requested = true,
             aggregate_version = aggregate_version + 1, fencing_token = fencing_token + 1, updated_at = now()
           WHERE id = $1`,
          [id],
        );
        await cancelQueuedSessionWork(client, id);
        await sessionEvent(client, id, "session.stop.requested", {});
      }
    });
    await this.advanceReadySessions();
    return this.get(id);
  }

  async advanceReadySessions(): Promise<number> {
    const result = await this.pool.query<{ id: string }>(
      "SELECT id FROM company_sessions WHERE project_id = $1 AND state = ANY($2::text[]) ORDER BY updated_at LIMIT 10",
      [currentProjectId(this.env), ["council", "planning", "executing", "verifying", "stopping"]],
    );
    let advanced = 0;
    for (const row of result.rows) {
      if (await this.advanceOne(row.id)) advanced += 1;
    }
    return advanced;
  }

  private async advanceOne(sessionId: string): Promise<boolean> {
    const session = await this.getRow(sessionId);
    if (session.state === "stopping") return this.reconcileStop(session);
    const contributionStatus = await this.pool.query<{ status: string; count: string }>(
      "SELECT status, count(*)::text AS count FROM company_session_contributions WHERE session_id = $1 GROUP BY status",
      [sessionId],
    );
    const failed = contributionStatus.rows.some((row) => ["failed", "blocked"].includes(row.status));
    if (failed) {
      await this.block(sessionId, session.aggregate_version, "contribution_failed");
      return true;
    }
    const pending = contributionStatus.rows.some((row) => ["queued", "working"].includes(row.status));
    if (pending && session.stage !== "execution") return false;

    if (session.stage === "round_1") {
      const bundle = await this.contributionBundle(sessionId, 1);
      await withTransaction(this.pool, async (client) => {
        if (!await claimStage(client, session, "round_1", "ceo_synthesis", "planning")) return;
        await queueContribution(client, {
          sessionId, round: 1, kind: "ceo_synthesis", agentId: "ceo",
          title: "Synthèse du premier tour stratégique",
          intendedOutcome: [
            "Tu es le CEO. Synthétise équitablement les constats, opportunités, arbitrages et risques de toute l’équipe.",
            `Mission: ${session.mission}`,
            `Contributions:\n${bundle}`,
            "Ne modifie aucun fichier pendant cette synthèse. Aucune action externe.",
          ].join("\n").slice(0, 2_000),
        }, this.env);
        await sessionEvent(client, sessionId, "session.round_1.completed", {});
      });
      return true;
    }
    if (session.stage === "ceo_synthesis") {
      const synthesis = await this.latestContributionBody(sessionId, "ceo_synthesis");
      const roundTwoParticipantLimit = session.mode === "global" ? 10 : 4;
      const participants = await this.pool.query<{ agent_id: CompanyAgentId }>(
        "SELECT agent_id FROM company_session_participants WHERE session_id = $1 ORDER BY invitation_order LIMIT $2",
        [sessionId, roundTwoParticipantLimit],
      );
      await withTransaction(this.pool, async (client) => {
        if (!await claimStage(client, session, "ceo_synthesis", "round_2", "council")) return;
        for (const row of participants.rows) {
          await queueContribution(client, {
            sessionId, round: 2, kind: "objection", agentId: row.agent_id,
            title: "Contre-analyse du plan stratégique",
            intendedOutcome: [
              "Challenge cette synthèse depuis ton rôle : éléments oubliés, objections, dépendances, compromis et correction recommandée.",
              `Mission: ${session.mission}`,
              `Synthèse CEO: ${synthesis.slice(0, 1_300)}`,
              "Ne modifie aucun fichier pendant ce tour. Aucune action externe.",
            ].join("\n").slice(0, 2_000),
          }, this.env);
        }
        await sessionEvent(client, sessionId, "session.round_2.started", { participantCount: participants.rowCount });
      });
      return true;
    }
    if (session.stage === "round_2") {
      const bundle = await this.contributionBundle(sessionId, 2);
      const synthesis = await this.latestContributionBody(sessionId, "ceo_synthesis");
      await withTransaction(this.pool, async (client) => {
        if (!await claimStage(client, session, "round_2", "ceo_decision", "planning")) return;
        await queueContribution(client, {
          sessionId, round: 2, kind: "ceo_decision", agentId: "ceo",
          title: "Décision et plan d’exécution",
          intendedOutcome: decisionPrompt(session, synthesis, bundle),
        }, this.env);
        await sessionEvent(client, sessionId, "session.decision.requested", {});
      });
      return true;
    }
    if (session.stage === "ceo_decision") {
      const decision = await this.latestContributionBody(sessionId, "ceo_decision");
      let parsed: ReturnType<typeof parseCeoDelegations>;
      try {
        parsed = parseCeoDelegations(decision);
      } catch {
        await this.block(sessionId, session.aggregate_version, "ceo_plan_invalid");
        return true;
      }
      const tasks = parsed.delegation.tasks.slice(0, session.max_tasks).map((task) => ({
        ...task,
        verifierAgentId: task.verifierAgentId ?? (task.agentId === "qa_safety" ? "reliability_privacy" as const : "qa_safety" as const),
        estimatedCostUsdMicros: 0,
      }));
      if (tasks.some((task) => !["read", "draft", "write_safe"].includes(task.riskClass))) {
        await this.block(sessionId, session.aggregate_version, "ceo_plan_exceeds_local_authority");
        return true;
      }
      if (tasks.length === 0) {
        await this.completeWithoutExecution(session, parsed.visibleText);
        return true;
      }
      const delegated = await new CeoDelegationService(this.pool, this.env).delegate({
        ceoTurnId: `strategic-session:${sessionId}`,
        delegation: { version: 1, tasks },
      });
      await withTransaction(this.pool, async (client) => {
        const changed = await client.query(
          `UPDATE company_sessions SET stage = 'execution', state = 'executing',
             aggregate_version = aggregate_version + 1, updated_at = now()
           WHERE id = $1 AND stage = 'ceo_decision' AND aggregate_version = $2`,
          [sessionId, session.aggregate_version],
        );
        if (!changed.rowCount) return;
        for (const [index, run] of delegated.entries()) {
          await client.query(
            `INSERT INTO company_session_execution_tasks (session_id, task_id, expected_deliverable)
             VALUES ($1,$2,$3) ON CONFLICT (task_id) DO NOTHING`,
            [sessionId, run.taskId, tasks[index]?.intendedOutcome ?? "Livrable vérifié"],
          );
        }
        await sessionEvent(client, sessionId, "session.execution.started", { taskCount: delegated.length });
      });
      return true;
    }
    if (session.stage === "execution") {
      return this.finishExecutionIfReady(session);
    }
    return false;
  }

  private async finishExecutionIfReady(session: SessionRow): Promise<boolean> {
    const result = await this.pool.query<{
      task_id: string; title: string; assigned_agent_id: CompanyAgentId; verifier_agent_id: CompanyAgentId | null;
      status: string; completion_summary: string | null;
    }>(
      `SELECT task.id AS task_id, task.title, task.assigned_agent_id, task.verifier_agent_id,
              task.status, completion.summary AS completion_summary
         FROM company_session_execution_tasks link
         JOIN cockpit_tasks task ON task.id = link.task_id
         LEFT JOIN LATERAL (
           SELECT left(event.safe_payload ->> 'summary', 4000) AS summary
           FROM cockpit_runs completed_run
           JOIN cockpit_events event
             ON event.aggregate_type = 'run'
            AND event.aggregate_id = completed_run.id::text
            AND event.event_type = 'agent.run.completed'
           WHERE completed_run.task_id = task.id
             AND event.safe_payload ? 'summary'
           ORDER BY event.occurred_at DESC
           LIMIT 1
         ) completion ON true
        WHERE link.session_id = $1 ORDER BY task.created_at`,
      [session.id],
    );
    if (!result.rowCount || result.rows.some((row) => !["done", "problem"].includes(row.status))) return false;
    const report = buildFinalReport(session, result.rows);
    const artifact = await writeFinalReportArtifact(session.id, report, this.env);
    await withTransaction(this.pool, async (client) => {
      const changed = await client.query(
        `UPDATE company_sessions SET state = 'completed', stage = 'final_report', final_report = $3,
           aggregate_version = aggregate_version + 1, completed_at = now(), updated_at = now()
         WHERE id = $1 AND aggregate_version = $2 AND stage = 'execution'`,
        [session.id, session.aggregate_version, report],
      );
      if (!changed.rowCount) return;
      for (const task of result.rows) {
        const summary = task.completion_summary ?? "Aucune conclusion exploitable n’a été enregistrée.";
        await client.query(
          `INSERT INTO company_session_deliverables
            (session_id, task_id, producer_agent_id, verifier_agent_id, title, summary, status, verified_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $7 = 'verified' THEN now() ELSE NULL END)`,
          [session.id, task.task_id, task.assigned_agent_id, task.verifier_agent_id, task.title,
            summary, task.status === "done" && task.verifier_agent_id ? "verified" : task.status === "done" ? "ready" : "blocked"],
        );
      }
      await client.query(
        `INSERT INTO company_session_deliverables
          (session_id, producer_agent_id, verifier_agent_id, title, summary, status, relative_path, sha256, verified_at)
         VALUES ($1,'ceo','reliability_privacy','Rapport final de la session',$2,'verified',$3,$4,now())`,
        [session.id, report.slice(0, 8_192), artifact.relativePath, artifact.sha256],
      );
      await sessionEvent(client, session.id, "session.completed", {
        deliverableCount: (result.rowCount ?? 0) + 1, reportPath: artifact.relativePath,
      });
    });
    return true;
  }

  private async completeWithoutExecution(session: SessionRow, decision: string): Promise<void> {
    const report = `# Conclusion stratégique\n\n${decision}\n\nAucune tâche d’exécution locale n’a été demandée par le CEO.`;
    const artifact = await writeFinalReportArtifact(session.id, report, this.env);
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `UPDATE company_sessions SET state = 'completed', stage = 'final_report', final_report = $3,
           aggregate_version = aggregate_version + 1, completed_at = now(), updated_at = now()
         WHERE id = $1 AND aggregate_version = $2`,
        [session.id, session.aggregate_version, report],
      );
      await client.query(
        `INSERT INTO company_session_deliverables
          (session_id, producer_agent_id, verifier_agent_id, title, summary, status, relative_path, sha256, verified_at)
         VALUES ($1,'ceo','reliability_privacy','Rapport final de la session',$2,'verified',$3,$4,now())`,
        [session.id, report, artifact.relativePath, artifact.sha256],
      );
      await sessionEvent(client, session.id, "session.completed", { deliverableCount: 1 });
    });
  }

  private async reconcileStop(session: SessionRow): Promise<boolean> {
    const active = await this.pool.query(
      `SELECT 1 FROM cockpit_runs run
       WHERE run.state IN ('dispatching','working','interruption_requested')
         AND (
           EXISTS (SELECT 1 FROM company_session_contributions c WHERE c.session_id = $1 AND c.run_id = run.id)
           OR EXISTS (
             SELECT 1 FROM company_session_execution_tasks e
             WHERE e.session_id = $1 AND e.task_id = run.task_id
           )
         ) LIMIT 1`,
      [session.id],
    );
    if (active.rowCount) {
      if (Date.now() - session.updated_at.getTime() > 120_000) {
        await this.block(session.id, session.aggregate_version, "stop_confirmation_pending");
        return true;
      }
      return false;
    }
    await this.pool.query(
      `UPDATE company_sessions SET state = 'stopped', completed_at = now(),
         aggregate_version = aggregate_version + 1, updated_at = now()
       WHERE id = $1 AND aggregate_version = $2 AND state = 'stopping'`,
      [session.id, session.aggregate_version],
    );
    return true;
  }

  private async block(id: string, version: number, code: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const updated = await client.query(
        `UPDATE company_sessions SET state = 'blocked', failure_code = $3,
           aggregate_version = aggregate_version + 1, updated_at = now()
         WHERE id = $1 AND aggregate_version = $2`,
        [id, version, code],
      );
      if (updated.rowCount) await sessionEvent(client, id, "session.blocked", { code });
    });
  }

  private async contributionBundle(id: string, round: number): Promise<string> {
    const result = await this.pool.query<{ author_agent_id: string; safe_body: string }>(
      `SELECT author_agent_id, safe_body FROM company_session_contributions
       WHERE session_id = $1 AND round = $2 AND status = 'completed'
       ORDER BY created_at`,
      [id, round],
    );
    return compactContributionBundle(result.rows, 1_400);
  }

  private async latestContributionBody(id: string, kind: string): Promise<string> {
    const result = await this.pool.query<{ safe_body: string }>(
      `SELECT safe_body FROM company_session_contributions
       WHERE session_id = $1 AND contribution_kind = $2 AND status = 'completed'
       ORDER BY completed_at DESC LIMIT 1`,
      [id, kind],
    );
    if (!result.rows[0]?.safe_body) throw new Error("COMPANY_SESSION_CONTRIBUTION_MISSING");
    return result.rows[0].safe_body;
  }

  private async getRow(id: string): Promise<SessionRow> {
    const result = await this.pool.query<SessionRow>("SELECT * FROM company_sessions WHERE id = $1", [id]);
    if (!result.rows[0]) throw new Error("COMPANY_SESSION_NOT_FOUND");
    return result.rows[0];
  }

  private async buildCompanyReviewSnapshot(projectId: string): Promise<CompanyReviewSnapshot> {
    const result = await this.pool.query<{
      captured_at: Date;
      project_status: string;
      runtime_state: string | null;
      runtime_fresh: boolean;
      task_queued: string;
      task_working: string;
      task_action_required: string;
      task_verification: string;
      task_done: string;
      task_problem: string;
      task_paused: string;
      agents_ready: string;
      agents_working: string;
      agents_attention: string;
      pending_approvals: string;
    }>(
      `SELECT
         now() AS captured_at,
         project.status AS project_status,
         COALESCE(runtime.state, 'offline') AS runtime_state,
         COALESCE(runtime.last_heartbeat_at > now() - interval '30 seconds', false) AS runtime_fresh,
         (SELECT count(*)::text FROM cockpit_tasks WHERE status = 'queued') AS task_queued,
         (SELECT count(*)::text FROM cockpit_tasks WHERE status = 'working') AS task_working,
         (SELECT count(*)::text FROM cockpit_tasks WHERE status = 'action_required') AS task_action_required,
         (SELECT count(*)::text FROM cockpit_tasks WHERE status = 'verification') AS task_verification,
         (SELECT count(*)::text FROM cockpit_tasks WHERE status = 'done') AS task_done,
         (SELECT count(*)::text FROM cockpit_tasks WHERE status = 'problem') AS task_problem,
         (SELECT count(*)::text FROM cockpit_tasks WHERE status = 'paused') AS task_paused,
         (SELECT count(*)::text FROM cockpit_agent_instances
           WHERE retired_at IS NULL AND state IN ('waiting','working')) AS agents_ready,
         (SELECT count(*)::text FROM cockpit_agent_instances
           WHERE retired_at IS NULL AND state = 'working') AS agents_working,
         (SELECT count(*)::text FROM cockpit_agent_instances
           WHERE retired_at IS NULL AND state IN ('action_required','problem','uncertain')) AS agents_attention,
         (SELECT count(*)::text FROM cockpit_approvals WHERE state = 'pending') AS pending_approvals
       FROM company_projects project
       LEFT JOIN company_project_runtimes runtime ON runtime.project_id = project.id
       WHERE project.id = $1`,
      [projectId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("COMPANY_SESSION_PROJECT_NOT_FOUND");
    return {
      capturedAt: row.captured_at.toISOString(),
      projectStatus: row.project_status,
      runtimeState: row.runtime_state ?? "offline",
      runtimeFresh: row.runtime_fresh,
      taskCounts: {
        queued: Number(row.task_queued),
        working: Number(row.task_working),
        actionRequired: Number(row.task_action_required),
        verification: Number(row.task_verification),
        done: Number(row.task_done),
        problem: Number(row.task_problem),
        paused: Number(row.task_paused),
      },
      agentCounts: {
        ready: Number(row.agents_ready),
        working: Number(row.agents_working),
        attention: Number(row.agents_attention),
      },
      pendingApprovals: Number(row.pending_approvals),
    };
  }

  private async hydrate(row: SessionRow): Promise<CompanySessionView> {
    const [participants, contributions, deliverables, events] = await Promise.all([
      this.pool.query("SELECT agent_id AS \"agentId\", status, invitation_order AS \"order\" FROM company_session_participants WHERE session_id = $1 ORDER BY invitation_order", [row.id]),
      this.pool.query("SELECT id, round, contribution_kind AS kind, author_agent_id AS \"authorAgentId\", title, status, safe_body AS body, created_at AS \"createdAt\", completed_at AS \"completedAt\" FROM company_session_contributions WHERE session_id = $1 ORDER BY created_at", [row.id]),
      this.pool.query("SELECT id, title, summary, status, producer_agent_id AS \"producerAgentId\", verifier_agent_id AS \"verifierAgentId\", relative_path AS \"relativePath\", sha256, created_at AS \"createdAt\" FROM company_session_deliverables WHERE session_id = $1 ORDER BY created_at", [row.id]),
      this.pool.query("SELECT sequence::text, id, event_type AS \"eventType\", safe_payload AS payload, occurred_at AS \"occurredAt\" FROM company_session_events WHERE session_id = $1 ORDER BY sequence DESC LIMIT 100", [row.id]),
    ]);
    return companySessionViewSchema.parse({
      id: row.id, projectId: row.project_id, mode: row.mode, mission: row.mission,
      expectedOutcome: row.expected_outcome, ownerFocus: row.owner_focus, state: row.state,
      stage: row.stage, version: row.aggregate_version, stopRequested: row.stop_requested,
      finalReport: row.final_report, failureCode: row.failure_code,
      startedAt: row.started_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null,
      updatedAt: row.updated_at.toISOString(), participants: participants.rows,
      contributions: contributions.rows, deliverables: deliverables.rows, events: events.rows.reverse(),
    });
  }

  private async assertRealLocalReadiness(): Promise<void> {
    if ((this.env.OPS_CODEX_MODE ?? "demo") === "demo") throw new Error("COMPANY_SESSION_REAL_CODEX_REQUIRED");
    if (this.env.GLOBAL_EXTERNAL_WORK_ENABLED === "true") throw new Error("COMPANY_SESSION_EXTERNAL_WORK_MUST_BE_DISABLED");
    const result = await this.pool.query<{ pause: string; component: string; status: string; heartbeat_at: Date }>(
      `SELECT pause.state AS pause, health.component, health.status, health.heartbeat_at
       FROM cockpit_pause pause CROSS JOIN cockpit_runtime_health health WHERE pause.id = 1`,
    );
    if (!result.rows.length || result.rows[0]?.pause !== "running") throw new Error("COMPANY_SESSION_COCKPIT_PAUSED");
    const healthy = new Set(result.rows.filter((row) =>
      row.status === "connected" && Date.now() - row.heartbeat_at.getTime() <= 15_000,
    ).map((row) => row.component));
    if (!["supervisor", "bridge", "codex"].every((component) => healthy.has(component))) {
      throw new Error("COMPANY_SESSION_RUNTIME_NOT_READY");
    }
  }
}

async function queueContribution(
  client: PoolClient,
  input: {
    sessionId: string;
    round: 1 | 2;
    kind: "proposal" | "objection" | "ceo_synthesis" | "ceo_decision";
    agentId: CompanyAgentId;
    title: string;
    intendedOutcome: string;
  },
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const title = input.title.slice(0, 300);
  const intendedOutcome = input.intendedOutcome.slice(0, 2_000);
  if (findOwnerMessagePolicyViolation(title) || findOwnerMessagePolicyViolation(intendedOutcome)) {
    throw new Error("COMPANY_SESSION_UNSAFE_PROMPT");
  }
  const instance = await client.query<{ id: string; thread_id: string; transport: "app_server" | "exec_resume" }>(
    `SELECT id, thread_id, transport FROM cockpit_agent_instances
     WHERE agent_id = $1 AND retired_at IS NULL
       AND state NOT IN ('offline','paused','problem','uncertain') FOR SHARE`,
    [input.agentId],
  );
  const agent = instance.rows[0];
  if (!agent) throw new Error(`COMPANY_SESSION_AGENT_NOT_READY_${input.agentId}`);
  const profile = input.agentId === "ceo" ? "expert" : "balanced";
  const configuredModel = env[`OPS_MODEL_${profile.toUpperCase()}`];
  const allowlist = await client.query<{ model: string; reasoning_effort: "low" | "medium" | "high" | "xhigh" }>(
    `SELECT model, reasoning_effort FROM cockpit_model_allowlist
     WHERE profile = $1 AND enabled = true
     ORDER BY (model = $2) DESC, priority DESC, model LIMIT 1`,
    [profile, configuredModel ?? ""],
  );
  const model = allowlist.rows[0];
  if (!model) throw new Error("COMPANY_SESSION_MODEL_NOT_AVAILABLE");
  const estimatedCost = input.agentId === "ceo" ? 100_000 : 50_000;
  await ensureBudget(client, estimatedCost);
  const taskId = randomUUID();
  const runId = randomUUID();
  const contributionId = randomUUID();
  await client.query(
    `INSERT INTO cockpit_tasks
      (id, assigned_agent_id, title, intended_outcome, risk_class, status)
     VALUES ($1,$2,$3,$4,'read','queued')`,
    [taskId, input.agentId, title, intendedOutcome],
  );
  await client.query(
    `INSERT INTO cockpit_runs
      (id, task_id, agent_instance_id, transport, router_version, model_profile, selected_model,
       reasoning_effort, routing_score, routing_factors, requires_distinct_verifier,
       codex_thread_id, estimated_cost_usd_micros)
     VALUES ($1,$2,$3,$4,'strategic-session-v1',$5,$6,$7,100,$8,false,$9,$10)`,
    [runId, taskId, agent.id, agent.transport, profile, model.model,
      input.agentId === "ceo" ? "high" : model.reasoning_effort,
      { strategicSessionId: input.sessionId, contributionId, stage: input.kind },
      agent.thread_id, estimatedCost],
  );
  const payload = safeOperationalPayloadSchema.parse({
    version: 1, strategicSessionId: input.sessionId, contributionId,
    sessionStage: input.kind, round: input.round, agentId: input.agentId,
    title, intendedOutcome, externalSpendUsdMicros: 0,
  });
  await client.query(
    "INSERT INTO cockpit_outbox (run_id, destination, safe_payload) VALUES ($1,$2,$3)",
    [runId, `codex:${input.agentId}`, payload],
  );
  await client.query(
    `INSERT INTO company_session_contributions
      (id, session_id, round, contribution_kind, author_agent_id, title, task_id, run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [contributionId, input.sessionId, input.round, input.kind, input.agentId, title, taskId, runId],
  );
}

async function ensureBudget(client: PoolClient, amount: number): Promise<void> {
  await client.query(
    `INSERT INTO cockpit_budgets
      (scope, period_start, period_end, external_spend_limit_usd_micros,
       external_spend_reserved_usd_micros, external_spend_actual_usd_micros,
       model_usage_limit_usd_micros, usage_provenance)
     VALUES ('company:model:daily',date_trunc('day',now()),date_trunc('day',now()) + interval '1 day',0,0,0,5000000,'estimated')
     ON CONFLICT (scope, period_start, period_end) DO NOTHING`,
  );
  const reserved = await client.query(
    `UPDATE cockpit_budgets SET model_usage_reserved_usd_micros = model_usage_reserved_usd_micros + $1,
       version = version + 1, updated_at = now()
     WHERE scope = 'company:model:daily' AND period_start <= now() AND period_end > now()
       AND external_spend_limit_usd_micros = 0
       AND external_spend_reserved_usd_micros = 0
       AND external_spend_actual_usd_micros = 0
       AND model_usage_reserved_usd_micros + model_usage_actual_usd_micros + $1 <= model_usage_limit_usd_micros`,
    [amount],
  );
  if (reserved.rowCount !== 1) throw new Error("COMPANY_SESSION_MODEL_BUDGET_EXCEEDED");
}

async function claimStage(
  client: PoolClient,
  session: SessionRow,
  from: CompanySessionView["stage"],
  to: CompanySessionView["stage"],
  state: CompanySessionView["state"],
): Promise<boolean> {
  const result = await client.query(
    `UPDATE company_sessions SET stage = $3, state = $4,
       aggregate_version = aggregate_version + 1, updated_at = now()
     WHERE id = $1 AND aggregate_version = $2 AND stage = $5 AND state <> 'paused'`,
    [session.id, session.aggregate_version, to, state, from],
  );
  return result.rowCount === 1;
}

async function sessionEvent(client: PoolClient, sessionId: string, eventType: string, payload: unknown): Promise<void> {
  await client.query(
    "INSERT INTO company_session_events (session_id, event_type, safe_payload) VALUES ($1,$2,$3)",
    [sessionId, eventType, safeOperationalPayloadSchema.parse(payload)],
  );
}

async function cancelQueuedSessionWork(client: PoolClient, sessionId: string): Promise<void> {
  await client.query(
    `UPDATE cockpit_outbox SET state = 'failed'
     WHERE run_id IN (
       SELECT run_id FROM company_session_contributions WHERE session_id = $1
       UNION
       SELECT run.id FROM company_session_execution_tasks link
       JOIN cockpit_runs run ON run.task_id = link.task_id WHERE link.session_id = $1
     ) AND state = 'pending'`,
    [sessionId],
  );
  await client.query(
    `UPDATE cockpit_runs SET state = 'failed', completed_at = now()
     WHERE id IN (
       SELECT run_id FROM company_session_contributions WHERE session_id = $1
       UNION
       SELECT run.id FROM company_session_execution_tasks link
       JOIN cockpit_runs run ON run.task_id = link.task_id WHERE link.session_id = $1
     ) AND state = 'queued'`,
    [sessionId],
  );
  await client.query(
    "UPDATE company_session_contributions SET status = 'cancelled' WHERE session_id = $1 AND status = 'queued'",
    [sessionId],
  );
}

function chooseTargetedParticipants(text: string): CompanyAgentId[] {
  const normalized = text.toLowerCase();
  const selected = new Set<CompanyAgentId>(["product"]);
  if (/design|landing|conversion|ux|ui|marque/.test(normalized)) selected.add("design_conversion");
  if (/code|tech|bug|api|base|infra|saas/.test(normalized)) selected.add("engineering");
  if (/marketing|seo|acquisition|publicit|croissance/.test(normalized)) selected.add("growth");
  if (/contenu|copy|rédaction|brand|communaut/.test(normalized)) selected.add("content_brand");
  if (/prix|finance|budget|revenu|marge/.test(normalized)) selected.add("finance_risk");
  if (/sécur|privacy|donnée|fiabil|ops/.test(normalized)) selected.add("reliability_privacy");
  if (/test|qualité|conform|rapport/.test(normalized)) selected.add("qa_safety");
  for (const fallback of TARGETED_FALLBACK) {
    if (selected.size >= 4) break;
    selected.add(fallback);
  }
  return [...selected].slice(0, 6);
}

function currentProjectId(env: NodeJS.ProcessEnv): string {
  return z.string().regex(/^[a-z][a-z0-9-]{2,62}$/).parse(
    env.COMPANY_OS_PROJECT_ID?.trim() || "company-os",
  );
}

function councilPrompt(input: {
  mission: string;
  expected: string | undefined;
  focus: string | undefined;
  agentId: CompanyAgentId;
  mode: "global" | "targeted";
  companySnapshot: CompanyReviewSnapshot | null;
}): string {
  return [
    `Mission de la session: ${input.mission}`,
    input.expected ? `Résultat attendu: ${input.expected}` : "",
    input.focus ? `Priorité du propriétaire: ${input.focus}` : "",
    `Rôle consulté: ${input.agentId}.`,
    input.mode === "global"
      ? "Avant de répondre, examine réellement le dépôt local, ses documents, ses tâches et ses validations dans ton périmètre. Distingue ce qui existe, ce qui fonctionne, ce qui manque et ce qui mérite une priorité."
      : "",
    input.companySnapshot ? `Instantané opérationnel: ${formatCompanyReviewSnapshot(input.companySnapshot)}` : "",
    "Produis une contribution concise et vérifiable : constat, preuves locales, opportunités de progrès ou de revenu, risques, dépendances, tâches recommandées et indicateur de réussite.",
    "Ne modifie aucun fichier pendant ce tour de conseil. Aucune action externe.",
  ].filter(Boolean).join("\n").slice(0, 2_000);
}

function decisionPrompt(session: SessionRow, synthesis: string, objections: string): string {
  return [
    "Tu es le CEO. Toute exécution doit rester locale, sûre et réversible.",
    "Aucune dépense, publication, email, publicité, paiement ou déploiement de production.",
    `Mission: ${session.mission}`,
    `Décide un plan local concret de 0 à ${session.max_tasks} tâches.`,
    "Commence par une décision lisible pour le propriétaire: priorités, compromis, critères de réussite et risques.",
    "Si une exécution est utile, termine par exactement un bloc ```company-delegations JSON version 1.",
    "Chaque tâche doit rester locale et réversible, riskClass read/draft/write_safe uniquement, estimatedCostUsdMicros 0, et inclure un verifierAgentId distinct.",
    `Synthèse du premier tour: ${synthesis.slice(0, 650)}`,
    `Contre-analyses: ${objections.slice(0, 650)}`,
  ].join("\n").slice(0, 2_000);
}

export function compactContributionBundle(
  rows: Array<{ author_agent_id: string; safe_body: string }>,
  limit = 1_400,
): string {
  if (rows.length === 0) return "Aucune contribution terminée.";
  const prefixBudget = rows.reduce((total, row) => total + row.author_agent_id.length + 4, 0);
  const bodyBudget = Math.max(40, Math.floor((limit - prefixBudget - rows.length) / rows.length));
  return rows
    .map((row) => `[${row.author_agent_id}] ${row.safe_body.replace(/\s+/g, " ").trim().slice(0, bodyBudget)}`)
    .join("\n")
    .slice(0, limit);
}

function formatCompanyReviewSnapshot(snapshot: CompanyReviewSnapshot): string {
  const tasks = snapshot.taskCounts;
  const agents = snapshot.agentCounts;
  return [
    `projet=${snapshot.projectStatus}`,
    `runtime=${snapshot.runtimeState}/${snapshot.runtimeFresh ? "récent" : "non récent"}`,
    `tâches: ${tasks.queued} en attente, ${tasks.working} en cours, ${tasks.actionRequired} à décider, ${tasks.verification} à vérifier, ${tasks.done} terminées, ${tasks.problem} en problème, ${tasks.paused} en pause`,
    `agents: ${agents.ready} prêts dont ${agents.working} en travail, ${agents.attention} à surveiller`,
    `approbations en attente=${snapshot.pendingApprovals}`,
    `mesuré=${snapshot.capturedAt}`,
  ].join("; ");
}

function stateForStage(stage: CompanySessionView["stage"]): CompanySessionView["state"] {
  if (stage === "round_1" || stage === "round_2") return "council";
  if (stage === "ceo_synthesis" || stage === "ceo_decision") return "planning";
  if (stage === "execution") return "executing";
  return "verifying";
}

function buildFinalReport(
  session: SessionRow,
  tasks: Array<{ title: string; status: string; completion_summary: string | null }>,
): string {
  const successful = tasks.filter((task) => task.status === "done").length;
  const verdict = successful === tasks.length ? "Session terminée et livrables vérifiés." : "Session terminée avec des blocages à traiter.";
  return [
    "# Rapport final — session autonome",
    "",
    `## Verdict\n${verdict}`,
    "",
    `## Mission\n${session.mission}`,
    "",
    "## Livrables",
    ...tasks.map((task) => `- **${task.title}** — ${task.status === "done" ? "validé" : "bloqué"} : ${task.completion_summary ?? "aucune conclusion enregistrée"}`),
    "",
    `## Décision propriétaire\n${successful === tasks.length ? "Aucune intervention nécessaire pour clôturer cette session." : "Examiner les livrables bloqués avant de relancer une mission ciblée."}`,
    "",
    "_Aucune action externe ni dépense n’a été exécutée._",
  ].join("\n").slice(0, 16_000);
}

async function writeFinalReportArtifact(
  sessionId: string,
  report: string,
  env: NodeJS.ProcessEnv,
): Promise<{ relativePath: string; sha256: string }> {
  const root = assertProjectPathAllowed(env.COMPANY_OS_PROJECT_ROOT?.trim() || process.cwd(), env);
  const directory = path.resolve(root, ".company-os", "artifacts", sessionId);
  const target = path.resolve(directory, "final-report.md");
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("COMPANY_SESSION_ARTIFACT_PATH_REJECTED");
  await mkdir(directory, { recursive: true });
  let actualTarget = target;
  try {
    await writeFile(target, report, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    actualTarget = path.resolve(directory, `final-report-${Date.now()}.md`);
    await writeFile(actualTarget, report, { encoding: "utf8", flag: "wx" });
  }
  return {
    relativePath: path.relative(root, actualTarget).replaceAll(path.sep, "/"),
    sha256: createHash("sha256").update(report).digest("hex"),
  };
}
