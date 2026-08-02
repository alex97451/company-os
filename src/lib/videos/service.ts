import { randomUUID } from "node:crypto";
import { resolve, sep } from "node:path";
import type { Pool } from "pg";
import { z } from "zod";
import { CeoDelegationService } from "@/lib/orchestration";
import { createVideoJobSchema, videoJobSchema, type CreateVideoJobInput, type VideoJob } from "./contracts";

const rowSchema = z.object({
  id: z.string().uuid(),
  subject: z.string(),
  goal: z.enum(["awareness", "education", "conversion"]),
  language: z.enum(["fr", "en"]),
  template: z.enum(["problem_reveal_solution", "quick_list", "before_after"]),
  durationSeconds: z.number().int(),
  state: z.enum(["queued", "briefing", "voice", "rendering", "quality_check", "completed", "failed", "cancelled"]),
  progress: z.number().int(),
  stageLabel: z.string(),
  selectedHook: z.string().nullable(),
  caption: z.string().nullable(),
  hashtags: z.array(z.string()),
  heuristicScore: z.number().int().nullable(),
  qualityReport: z.unknown().nullable(),
  videoObjectKey: z.string().nullable(),
  thumbnailObjectKey: z.string().nullable(),
  errorCode: z.string().nullable(),
  briefAttemptCount: z.number().int(),
  attemptCount: z.number().int(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  completedAt: z.coerce.date().nullable(),
}).strict();

const SELECT_COLUMNS = `
  id, subject, goal, language, template,
  requested_duration_seconds AS "durationSeconds", state, progress,
  stage_label AS "stageLabel", selected_hook AS "selectedHook", caption, hashtags,
  heuristic_score AS "heuristicScore", quality_report AS "qualityReport",
  video_object_key AS "videoObjectKey", thumbnail_object_key AS "thumbnailObjectKey",
  error_code AS "errorCode", brief_attempt_count AS "briefAttemptCount", attempt_count AS "attemptCount",
  created_at AS "createdAt", updated_at AS "updatedAt", completed_at AS "completedAt"`;

export class VideoStudioService {
  constructor(private readonly pool: Pool, private readonly env: NodeJS.ProcessEnv = process.env) {}

  async list(): Promise<VideoJob[]> {
    const result = await this.pool.query(`SELECT ${SELECT_COLUMNS} FROM video_jobs ORDER BY created_at DESC LIMIT 50`);
    return result.rows.map(toJob);
  }

  async get(idRaw: unknown): Promise<VideoJob | null> {
    const id = z.string().uuid().parse(idRaw);
    const result = await this.pool.query(`SELECT ${SELECT_COLUMNS} FROM video_jobs WHERE id = $1`, [id]);
    return result.rows[0] ? toJob(result.rows[0]) : null;
  }

  async create(rawInput: unknown): Promise<VideoJob> {
    const input = createVideoJobSchema.parse(rawInput);
    const id = randomUUID();
    try {
      await this.pool.query(
        `INSERT INTO video_jobs
          (id, subject, goal, language, template, requested_duration_seconds)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, input.subject, input.goal, input.language, input.template, input.durationSeconds],
      );
    } catch (error) {
      if (isPostgresCode(error, "23505")) throw new Error("VIDEO_JOB_ALREADY_ACTIVE");
      throw error;
    }

    try {
      await this.queueAgent(id, input, 1);
    } catch (error) {
      await this.pool.query(
        "UPDATE video_jobs SET state = 'failed', error_code = $2, stage_label = 'La préparation n’a pas pu démarrer', updated_at = now() WHERE id = $1",
        [id, safeErrorCode(error)],
      ).catch(() => undefined);
      throw error;
    }
    const created = await this.get(id);
    if (!created) throw new Error("VIDEO_JOB_NOT_FOUND");
    return created;
  }

  async cancel(idRaw: unknown): Promise<VideoJob> {
    const id = z.string().uuid().parse(idRaw);
    const result = await this.pool.query(
      `UPDATE video_jobs SET state = 'cancelled', progress = 0,
              stage_label = 'Production annulée par le propriétaire', updated_at = now()
        WHERE id = $1 AND state IN ('queued','briefing','voice','rendering','quality_check')
        RETURNING id`,
      [id],
    );
    if (!result.rows[0]) throw new Error("VIDEO_JOB_NOT_CANCELLABLE");
    const job = await this.get(id);
    if (!job) throw new Error("VIDEO_JOB_NOT_FOUND");
    return job;
  }

  async retry(idRaw: unknown): Promise<VideoJob> {
    const id = z.string().uuid().parse(idRaw);
    const result = await this.pool.query<{
      subject: string; goal: CreateVideoJobInput["goal"]; language: CreateVideoJobInput["language"];
      template: CreateVideoJobInput["template"]; requested_duration_seconds: number;
      brief_attempt_count: number; attempt_count: number;
    }>(
      `SELECT subject, goal, language, template, requested_duration_seconds,
              brief_attempt_count, attempt_count
         FROM video_jobs WHERE id = $1 AND state = 'failed'`,
      [id],
    );
    const row = result.rows[0];
    if (!row || (row.brief_attempt_count >= 2 && row.attempt_count >= 2)) throw new Error("VIDEO_JOB_NOT_RETRYABLE");
    const input = createVideoJobSchema.parse({
      subject: row.subject, goal: row.goal, language: row.language,
      template: row.template, durationSeconds: row.requested_duration_seconds,
    });
    await this.pool.query(
      `UPDATE video_jobs
          SET state = 'queued', progress = 0, stage_label = 'Relance locale demandée',
              brief = NULL, selected_hook = NULL, caption = NULL, hashtags = '{}',
              heuristic_score = NULL, quality_report = NULL, video_object_key = NULL,
              thumbnail_object_key = NULL, error_code = NULL, updated_at = now(), completed_at = NULL
        WHERE id = $1 AND state = 'failed'`,
      [id],
    );
    try {
      await this.queueAgent(id, input, Math.min(2, row.brief_attempt_count + 1));
    } catch (error) {
      await this.pool.query(
        "UPDATE video_jobs SET state = 'failed', error_code = $2, stage_label = 'La relance de l’agent n’a pas démarré', updated_at = now() WHERE id = $1",
        [id, safeErrorCode(error)],
      ).catch(() => undefined);
      throw error;
    }
    const job = await this.get(id);
    if (!job) throw new Error("VIDEO_JOB_NOT_FOUND");
    return job;
  }

  mediaPath(idRaw: unknown, kindRaw: unknown): string {
    const id = z.string().uuid().parse(idRaw);
    const kind = z.enum(["video", "thumbnail"]).parse(kindRaw);
    const projectId = z.string().regex(/^[a-z][a-z0-9-]{2,62}$/).parse(this.env.COMPANY_OS_PROJECT_ID ?? "company-os");
    const root = resolve(process.cwd(), "work", "projects", projectId);
    const target = resolve(root, "videos", id, kind === "video" ? "video.mp4" : "thumbnail.png");
    if (!target.startsWith(`${root}${sep}`)) throw new Error("VIDEO_MEDIA_PATH_INVALID");
    return target;
  }

  private async queueAgent(id: string, input: CreateVideoJobInput, briefAttempt: number): Promise<void> {
    const [delegated] = await new CeoDelegationService(this.pool, this.env).delegate({
      ceoTurnId: `video-job:${id}:brief:${briefAttempt}`,
      delegation: { version: 1, tasks: [videoDelegation(input)] },
      runMetadata: { videoJobId: id, workflow: "short_form_video_v1" },
    });
    if (!delegated) throw new Error("VIDEO_AGENT_RUN_NOT_CREATED");
    await this.pool.query(
      `UPDATE video_jobs
          SET task_id = $2, run_id = $3, brief_attempt_count = $4,
              state = 'briefing', progress = 10,
              stage_label = 'L’agent vidéo prépare les accroches et le storyboard', updated_at = now()
        WHERE id = $1 AND state = 'queued'`,
      [id, delegated.taskId, delegated.runId, briefAttempt],
    );
  }
}

function videoDelegation(input: CreateVideoJobInput) {
  const language = input.language === "fr" ? "français" : "English";
  return {
    agentId: "video_creator" as const,
    title: `Créer une vidéo verticale ${input.durationSeconds} s`,
    intendedOutcome: [
      `Sujet approuvé par le propriétaire : ${input.subject}`,
      `Objectif : ${input.goal}. Langue : ${language}. Modèle : ${input.template}. Durée exacte : ${input.durationSeconds} secondes.`,
      "Proposer exactement trois accroches, sélectionner la meilleure avec un score explicable, puis produire un brief v1 complet et strictement structuré.",
      "Utiliser uniquement des graphismes générés dans Remotion sauf si un actif local avec droits déclarés est explicitement disponible.",
      "La dernière scène doit finir exactement à la durée demandée. La narration doit tenir dans la durée et les hashtags doivent commencer par #.",
      "Aucune publication, aucun contact externe et aucune promesse de viralité.",
    ].join("\n"),
    riskClass: "write_safe" as const,
    complexity: 3 as const,
    contextTokens: 4_000,
    urgency: "normal" as const,
    estimatedCostUsdMicros: 100_000,
    manualProfile: "balanced" as const,
  };
}

function toJob(raw: unknown): VideoJob {
  const row = rowSchema.parse(raw);
  return videoJobSchema.parse({
    id: row.id,
    subject: row.subject,
    goal: row.goal,
    language: row.language,
    template: row.template,
    durationSeconds: row.durationSeconds,
    state: row.state,
    progress: row.progress,
    stageLabel: row.stageLabel,
    selectedHook: row.selectedHook,
    caption: row.caption,
    hashtags: row.hashtags,
    heuristicScore: row.heuristicScore,
    qualityReport: row.qualityReport,
    hasVideo: row.videoObjectKey !== null,
    hasThumbnail: row.thumbnailObjectKey !== null,
    errorCode: row.errorCode,
    attemptCount: row.attemptCount,
    canRetry: row.state === "failed" && (row.briefAttemptCount < 2 || row.attemptCount < 2),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  });
}

function isPostgresCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "VIDEO_AGENT_START_FAILED";
  return /^[A-Z0-9_]{3,120}$/.test(message) ? message : "VIDEO_AGENT_START_FAILED";
}
