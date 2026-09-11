import type { Pool } from "pg";
import { z } from "zod";
import { CockpitRepository } from "@/lib/db/cockpit-repository";
import {
  projectDiscoverySchema,
  projectInitialReviewResultSchema,
  projectInitialReviewSchema,
  projectIdSchema,
  type ProjectDiscovery,
  type ProjectInitialReview,
  type ProjectInitialReviewResult,
} from "./manifest";

const REVIEW_VERSION = 1;
const REVIEW_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_POLL_MS = 2_000;

const reviewContextRowSchema = z.object({
  id: projectIdSchema,
  displayName: z.string().trim().min(2).max(120),
  discovery: z.unknown(),
  initialReview: z.unknown().nullable(),
  runtimeId: z.string().trim().min(1).max(200),
  runtimeState: z.enum(["starting", "online", "stopping", "offline", "error"]),
  heartbeatAt: z.coerce.date(),
}).strict();

const ownerStateRowSchema = z.object({
  commandVersion: z.number().int().min(0),
}).strict();

const commandRowSchema = z.object({
  id: z.string().uuid(),
  state: z.enum([
    "pending",
    "dispatched",
    "acknowledged",
    "completed",
    "rejected",
    "expired",
    "reconciliation_required",
  ]),
  finalMessage: z.string().trim().min(1).max(16_384).nullable(),
}).strict();

const existingCommandRowSchema = z.object({ id: z.string().uuid() }).strict();

export type InitialProjectReviewContext = {
  projectId: string;
  displayName: string;
  discovery: ProjectDiscovery;
  initialReview: ProjectInitialReview | null;
  verifiedAt: string;
};

export type InitialProjectReviewCommand = z.infer<typeof commandRowSchema>;

export interface InitialProjectReviewStore {
  loadContext(): Promise<InitialProjectReviewContext>;
  getOrCreateCommand(prompt: string): Promise<string>;
  readCommand(commandId: string): Promise<InitialProjectReviewCommand>;
  saveReview(review: ProjectInitialReview): Promise<void>;
}

export type RunInitialProjectReviewOptions = {
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  pollMs?: number;
  timeoutMs?: number;
};

export async function runInitialProjectReview(
  store: InitialProjectReviewStore,
  options: RunInitialProjectReviewOptions = {},
): Promise<ProjectInitialReview> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const pollMs = z.number().int().min(100).max(30_000).parse(options.pollMs ?? DEFAULT_POLL_MS);
  const timeoutMs = z.number().int().min(1_000).max(REVIEW_TIMEOUT_MS).parse(options.timeoutMs ?? REVIEW_TIMEOUT_MS);
  const context = await store.loadContext();
  if (context.initialReview?.state === "completed") {
    await store.saveReview(context.initialReview);
    return context.initialReview;
  }

  const triggeredAt = context.initialReview?.triggeredAt ?? context.verifiedAt;
  const prompt = buildInitialProjectReviewPrompt(context.displayName, context.discovery);
  const commandId = context.initialReview?.commandId ?? await store.getOrCreateCommand(prompt);
  let currentState: "queued" | "running" | null = context.initialReview?.state === "queued" || context.initialReview?.state === "running"
    ? context.initialReview.state
    : null;
  let review = context.initialReview ?? activeReview("queued", commandId, triggeredAt, now().toISOString());
  if (!context.initialReview) {
    currentState = "queued";
    await store.saveReview(review);
  }
  const deadline = now().getTime() + timeoutMs;

  while (now().getTime() <= deadline) {
    const command = await store.readCommand(commandId);
    if (command.state === "completed") {
      if (!command.finalMessage) {
        review = failedReview("INITIAL_CEO_REVIEW_RESULT_MISSING", triggeredAt, commandId, now().toISOString());
      } else {
        try {
          const result = parseInitialProjectReviewResult(command.finalMessage);
          review = completedReview(result, triggeredAt, commandId, now().toISOString());
        } catch {
          review = failedReview("INITIAL_CEO_REVIEW_RESULT_INVALID", triggeredAt, commandId, now().toISOString());
        }
      }
      await store.saveReview(review);
      return review;
    }

    if (["rejected", "expired", "reconciliation_required"].includes(command.state)) {
      review = failedReview(commandFailureCode(command.state), triggeredAt, commandId, now().toISOString());
      await store.saveReview(review);
      return review;
    }

    const nextState = command.state === "pending" ? "queued" : "running";
    if (currentState !== nextState) {
      currentState = nextState;
      review = activeReview(currentState, commandId, triggeredAt, now().toISOString());
      await store.saveReview(review);
    }
    await sleep(pollMs);
  }

  review = failedReview("INITIAL_CEO_REVIEW_TIMEOUT", triggeredAt, commandId, now().toISOString());
  await store.saveReview(review);
  return review;
}

export class PostgresInitialProjectReviewStore implements InitialProjectReviewStore {
  private readonly cockpit: CockpitRepository;

  constructor(
    private readonly registryPool: Pool,
    private readonly projectPool: Pool,
    private readonly projectId: string,
    private readonly runtimeId: string,
  ) {
    projectIdSchema.parse(projectId);
    z.string().trim().min(1).max(200).parse(runtimeId);
    this.cockpit = new CockpitRepository(projectPool);
  }

  async loadContext(): Promise<InitialProjectReviewContext> {
    const result = await this.registryPool.query(
      `SELECT project.id, project.display_name AS "displayName",
              project.manifest -> 'discovery' AS discovery,
              project.manifest -> 'initialReview' AS "initialReview",
              runtime.runtime_id AS "runtimeId", runtime.state AS "runtimeState",
              runtime.last_heartbeat_at AS "heartbeatAt"
         FROM company_projects project
         JOIN company_project_runtimes runtime ON runtime.project_id = project.id
        WHERE project.id = $1`,
      [this.projectId],
    );
    const row = reviewContextRowSchema.safeParse(result.rows[0]);
    if (!row.success) throw new Error("INITIAL_CEO_REVIEW_CONTEXT_INVALID");
    if (row.data.runtimeId !== this.runtimeId) throw new Error("INITIAL_CEO_REVIEW_RUNTIME_REPLACED");
    if (row.data.runtimeState !== "online" || Date.now() - row.data.heartbeatAt.getTime() > 45_000) {
      throw new Error("INITIAL_CEO_REVIEW_ONLINE_SIGNAL_MISSING");
    }
    const discovery = projectDiscoverySchema.safeParse(row.data.discovery);
    if (!discovery.success) throw new Error("INITIAL_CEO_REVIEW_DISCOVERY_INVALID");
    const initialReview = row.data.initialReview === null
      ? null
      : projectInitialReviewSchema.safeParse(row.data.initialReview);
    if (initialReview && !initialReview.success) throw new Error("INITIAL_CEO_REVIEW_STATE_INVALID");
    return {
      projectId: row.data.id,
      displayName: row.data.displayName,
      discovery: discovery.data,
      initialReview: initialReview?.data ?? null,
      verifiedAt: row.data.heartbeatAt.toISOString(),
    };
  }

  async getOrCreateCommand(prompt: string): Promise<string> {
    const safePrompt = z.string().trim().min(1).max(1_200).parse(prompt);
    const idempotencyKey = `system.initial-project-review:${this.projectId}:v${REVIEW_VERSION}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existing = await this.findCommand(idempotencyKey);
      if (existing) return existing;
      const ownerStateResult = await this.projectPool.query(
        `SELECT command_version AS "commandVersion" FROM cockpit_owner_state WHERE id = 1`,
      );
      const ownerState = ownerStateRowSchema.safeParse(ownerStateResult.rows[0]);
      if (!ownerState.success) throw new Error("INITIAL_CEO_REVIEW_OWNER_STATE_MISSING");
      try {
        return await this.cockpit.createOwnerCommand({
          idempotencyKey,
          expectedAggregateVersion: ownerState.data.commandVersion,
          commandType: "owner.message",
          safePayload: {
            message: safePrompt,
            ownerVisibleMessage: "Company OS a demandé au CEO le premier état des lieux en lecture seule, à partir du diagnostic vérifié. Aucune action externe n’est autorisée.",
            actorId: "system_review",
            actorRole: "owner",
          },
          expiresAt: new Date(Date.now() + REVIEW_TIMEOUT_MS),
        });
      } catch (error) {
        const code = safeErrorCode(error);
        if (!["COMMAND_STALE_VERSION", "COMMAND_NOT_CREATED"].includes(code)) throw error;
      }
    }
    const existing = await this.findCommand(idempotencyKey);
    if (existing) return existing;
    throw new Error("INITIAL_CEO_REVIEW_COMMAND_CONFLICT");
  }

  async readCommand(commandId: string): Promise<InitialProjectReviewCommand> {
    const id = z.string().uuid().parse(commandId);
    const result = await this.projectPool.query(
      `SELECT command.id, command.state,
              (SELECT message.safe_body
                 FROM cockpit_messages message
                WHERE message.command_id = command.id AND message.sender = 'ceo'
                ORDER BY message.created_at DESC LIMIT 1) AS "finalMessage"
         FROM cockpit_commands command
        WHERE command.id = $1`,
      [id],
    );
    const command = commandRowSchema.safeParse(result.rows[0]);
    if (!command.success) throw new Error("INITIAL_CEO_REVIEW_COMMAND_MISSING");
    return command.data;
  }

  async saveReview(review: ProjectInitialReview): Promise<void> {
    const validated = projectInitialReviewSchema.parse(review);
    const result = await this.registryPool.query(
      `UPDATE company_projects
          SET manifest = jsonb_set(manifest, '{initialReview}', $2::jsonb, true),
              updated_at = now()
        WHERE id = $1`,
      [this.projectId, JSON.stringify(validated)],
    );
    if (result.rowCount !== 1) throw new Error("INITIAL_CEO_REVIEW_PROJECT_MISSING");
    if (validated.state === "completed" && validated.commandId) {
      await this.projectPool.query(
        `UPDATE cockpit_messages
            SET safe_body = $2
          WHERE command_id = $1 AND sender = 'ceo' AND status IN ('completed','demo')`,
        [validated.commandId, formatInitialProjectReviewForOwner(validated)],
      );
    }
  }

  async recordFailure(error: unknown): Promise<void> {
    const code = safeErrorCode(error);
    if (code === "INITIAL_CEO_REVIEW_RUNTIME_REPLACED") return;
    const result = await this.registryPool.query(
      `SELECT manifest -> 'initialReview' AS "initialReview"
         FROM company_projects WHERE id = $1`,
      [this.projectId],
    );
    const existing = projectInitialReviewSchema.safeParse(result.rows[0]?.initialReview);
    if (existing.success && existing.data.state === "completed") return;
    const timestamp = new Date().toISOString();
    await this.saveReview(failedReview(
      code,
      existing.success ? existing.data.triggeredAt : timestamp,
      existing.success ? existing.data.commandId : null,
      timestamp,
    ));
  }

  private async findCommand(idempotencyKey: string): Promise<string | null> {
    const result = await this.projectPool.query(
      "SELECT id FROM cockpit_commands WHERE idempotency_key = $1",
      [idempotencyKey],
    );
    const existing = existingCommandRowSchema.safeParse(result.rows[0]);
    return existing.success ? existing.data.id : null;
  }
}

export function buildInitialProjectReviewPrompt(displayName: string, discovery: ProjectDiscovery): string {
  const name = z.string().trim().min(2).max(120).parse(displayName);
  const source = projectDiscoverySchema.parse(discovery);
  const git = source.git.state === "clean"
    ? "propre"
    : source.git.state === "changes"
      ? `${source.git.changedFiles} changement(s) conservé(s)`
      : source.git.state === "not_repository" ? "sans dépôt" : "indisponible";
  const prompt = [
    `Premier état des lieux CEO de « ${name} », strictement en lecture seule.`,
    "Appuie-toi uniquement sur ce diagnostic; n’utilise aucun outil, ne délègue rien et ne déclenche aucune action locale ou externe.",
    `Diagnostic: type=${source.suggestedKind}; technologies=${source.technologies.join(", ") || "non reconnues"}; gestionnaire=${source.packageManager}; scripts=${source.scripts.slice(0, 8).join(", ") || "aucun"}; documentation=${source.documentation.markdownFiles} Markdown, README=${source.documentation.readme ? "oui" : "non"}, AGENTS=${source.documentation.agentInstructions ? "oui" : "non"}; Git=${git}.`,
    "Réponds en français non technique, uniquement par un objet JSON sans Markdown.",
    "Format exact: {\"version\":1,\"conclusion\":\"...\",\"limits\":[\"...\"],\"priorities\":[{\"id\":\"P1\",\"title\":\"...\",\"observation\":\"...\",\"basis\":[\"commands\"],\"acceptanceCriteria\":[\"...\"]}, puis P2 et P3]}. Valeurs basis: technologies, commands, documentation, git, operational_readiness.",
    "Propose exactement trois priorités traçables. Chaque critère doit être vérifiable. N’ajoute ni dépense, ni déploiement, ni publicité, ni publication, ni contact externe.",
  ].join("\n");
  return z.string().max(1_200).parse(prompt);
}

export function parseInitialProjectReviewResult(message: string): ProjectInitialReviewResult {
  const safeMessage = z.string().trim().min(1).max(16_384).parse(message);
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(safeMessage);
  const unwrapped = fenced?.[1] ?? safeMessage;
  const start = unwrapped.indexOf("{");
  const end = unwrapped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("INITIAL_CEO_REVIEW_RESULT_INVALID");
  try {
    return projectInitialReviewResultSchema.parse(JSON.parse(unwrapped.slice(start, end + 1)));
  } catch {
    throw new Error("INITIAL_CEO_REVIEW_RESULT_INVALID");
  }
}

export function formatInitialProjectReviewForOwner(review: ProjectInitialReview): string {
  const validated = projectInitialReviewSchema.parse(review);
  if (validated.state !== "completed" || !validated.conclusion) {
    throw new Error("INITIAL_CEO_REVIEW_RESULT_NOT_COMPLETED");
  }
  return [
    "Premier état des lieux CEO",
    "",
    validated.conclusion,
    "",
    "Limites",
    ...validated.limits.map((limit) => `- ${limit}`),
    "",
    ...validated.priorities.flatMap((priority) => [
      `${priority.id} — ${priority.title}`,
      priority.observation,
      `Appui du diagnostic : ${priority.basis.map(basisForOwner).join(", ")}.`,
      "Accepté lorsque :",
      ...priority.acceptanceCriteria.map((criterion) => `- ${criterion}`),
      "",
    ]),
    "Aucune action externe n’a été lancée par ce bilan.",
  ].join("\n").trim();
}

function activeReview(
  state: "queued" | "running",
  commandId: string,
  triggeredAt: string,
  updatedAt: string,
): ProjectInitialReview {
  return projectInitialReviewSchema.parse({
    version: REVIEW_VERSION,
    state,
    commandId,
    triggeredAt,
    updatedAt,
    completedAt: null,
    conclusion: null,
    limits: [],
    priorities: [],
    errorCode: null,
  });
}

function completedReview(
  result: ProjectInitialReviewResult,
  triggeredAt: string,
  commandId: string,
  completedAt: string,
): ProjectInitialReview {
  return projectInitialReviewSchema.parse({
    ...result,
    state: "completed",
    commandId,
    triggeredAt,
    updatedAt: completedAt,
    completedAt,
    errorCode: null,
  });
}

export function failedReview(
  errorCode: string,
  triggeredAt: string,
  commandId: string | null,
  completedAt: string,
): ProjectInitialReview {
  const code = z.string().regex(/^[A-Z0-9_]{3,120}$/).catch("INITIAL_CEO_REVIEW_FAILED").parse(errorCode);
  const explanation = failureExplanation(code);
  return projectInitialReviewSchema.parse({
    version: REVIEW_VERSION,
    state: "error",
    commandId,
    triggeredAt,
    updatedAt: completedAt,
    completedAt,
    conclusion: explanation.conclusion,
    limits: [explanation.limit],
    priorities: [],
    errorCode: code,
  });
}

function commandFailureCode(state: InitialProjectReviewCommand["state"]): string {
  if (state === "expired") return "INITIAL_CEO_REVIEW_EXPIRED";
  if (state === "reconciliation_required") return "INITIAL_CEO_REVIEW_RECONCILIATION_REQUIRED";
  return "INITIAL_CEO_REVIEW_REJECTED";
}

function basisForOwner(basis: ProjectInitialReviewResult["priorities"][number]["basis"][number]): string {
  const labels = {
    technologies: "technologies détectées",
    commands: "commandes disponibles",
    documentation: "documentation repérée",
    git: "état Git observé",
    operational_readiness: "mise en ligne vérifiée",
  } as const;
  return labels[basis];
}

function failureExplanation(code: string): { conclusion: string; limit: string } {
  if (code === "INITIAL_CEO_REVIEW_RESULT_INVALID" || code === "INITIAL_CEO_REVIEW_RESULT_MISSING") {
    return {
      conclusion: "Le CEO a terminé son analyse, mais le résultat n’a pas pu être présenté sous la forme attendue.",
      limit: "Aucune priorité n’est affichée tant que la conclusion et les trois critères d’acceptation ne sont pas validés.",
    };
  }
  if (code === "INITIAL_CEO_REVIEW_TIMEOUT" || code === "INITIAL_CEO_REVIEW_EXPIRED") {
    return {
      conclusion: "Le premier état des lieux n’a pas abouti dans le délai prévu.",
      limit: "Aucune nouvelle commande n’a été créée automatiquement; la reprise conserve le même suivi pour éviter un doublon.",
    };
  }
  if (code === "INITIAL_CEO_REVIEW_ONLINE_SIGNAL_MISSING" || code === "INITIAL_CEO_REVIEW_RUNTIME_REPLACED") {
    return {
      conclusion: "Le bilan n’a pas démarré car la mise en ligne du projet n’était plus confirmée.",
      limit: "Le CEO n’est pas présenté comme actif sans signal récent du runtime et de Codex.",
    };
  }
  return {
    conclusion: "Le premier état des lieux CEO n’a pas pu être finalisé.",
    limit: "Aucune action externe n’a été lancée et aucune priorité incomplète n’est présentée comme validée.",
  };
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]{3,120}$/.test(error.message)) return error.message;
  return "INITIAL_CEO_REVIEW_FAILED";
}
