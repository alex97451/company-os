import { z } from "zod";

export const videoLanguageSchema = z.enum(["fr", "en"]);
export const videoGoalSchema = z.enum(["awareness", "education", "conversion"]);
export const videoTemplateSchema = z.enum(["problem_reveal_solution", "quick_list", "before_after"]);
export const videoJobStateSchema = z.enum([
  "queued", "briefing", "voice", "rendering", "quality_check", "completed", "failed", "cancelled",
]);

export const createVideoJobSchema = z.object({
  subject: z.string().trim().min(3).max(2_000),
  goal: videoGoalSchema,
  language: videoLanguageSchema,
  template: videoTemplateSchema,
  durationSeconds: z.number().int().min(15).max(60),
}).strict();

const hookSchema = z.object({
  id: z.string().regex(/^hook_[1-3]$/),
  text: z.string().trim().min(3).max(180),
  score: z.number().int().min(0).max(100),
  rationale: z.string().trim().min(3).max(300),
}).strict();

const sceneSchema = z.object({
  id: z.string().regex(/^scene_[1-8]$/),
  startSeconds: z.number().min(0).max(60),
  durationSeconds: z.number().min(1).max(30),
  headline: z.string().trim().min(1).max(90),
  body: z.string().trim().max(220),
  narration: z.string().trim().min(1).max(500),
  accent: z.enum(["gold", "sky", "rose", "emerald"]),
  transition: z.enum(["cut", "slide", "zoom", "wipe"]),
}).strict();

const rightsDeclarationSchema = z.object({
  asset: z.string().trim().min(1).max(240),
  basis: z.enum(["generated_in_remotion", "owner_provided", "licensed_local", "public_domain"]),
  source: z.string().trim().min(1).max(500),
}).strict();

export const videoBriefSchema = z.object({
  version: z.literal(1),
  title: z.string().trim().min(3).max(160),
  language: videoLanguageSchema,
  platforms: z.tuple([z.literal("tiktok"), z.literal("instagram_reels")]),
  template: videoTemplateSchema,
  durationSeconds: z.number().int().min(15).max(60),
  hooks: z.array(hookSchema).length(3),
  selectedHookId: z.string().regex(/^hook_[1-3]$/),
  voiceScript: z.string().trim().min(10).max(2_500),
  scenes: z.array(sceneSchema).min(3).max(8),
  caption: z.string().trim().min(3).max(2_200),
  hashtags: z.array(z.string().regex(/^#[\p{L}\p{N}_]{2,40}$/u)).min(3).max(12),
  heuristicScore: z.number().int().min(0).max(100),
  rightsDeclarations: z.array(rightsDeclarationSchema).min(1).max(20),
}).strict().superRefine((brief, context) => {
  if (!brief.hooks.some((hook) => hook.id === brief.selectedHookId)) {
    context.addIssue({ code: "custom", message: "Selected hook is missing.", path: ["selectedHookId"] });
  }
  const wordCount = brief.voiceScript.split(/\s+/).filter(Boolean).length;
  if (wordCount > brief.durationSeconds * 3.2) {
    context.addIssue({ code: "custom", message: "Voice script is too long for the requested duration.", path: ["voiceScript"] });
  }
  const ordered = [...brief.scenes].sort((left, right) => left.startSeconds - right.startSeconds);
  if (ordered.some((scene, index) => index > 0 && scene.startSeconds < ordered[index - 1].startSeconds + ordered[index - 1].durationSeconds - 0.05)) {
    context.addIssue({ code: "custom", message: "Scenes overlap.", path: ["scenes"] });
  }
  const end = Math.max(...brief.scenes.map((scene) => scene.startSeconds + scene.durationSeconds));
  if (Math.abs(end - brief.durationSeconds) > 0.25) {
    context.addIssue({ code: "custom", message: "Scenes must cover the complete requested duration.", path: ["scenes"] });
  }
});

export const videoAgentResultSchema = z.object({
  status: z.enum(["completed", "blocked"]),
  summary: z.string().trim().min(1).max(4_000),
  evidence: z.array(z.string().trim().min(1).max(500)).max(12),
  brief: videoBriefSchema.nullable(),
}).strict().superRefine((result, context) => {
  if (result.status === "completed" && !result.brief) {
    context.addIssue({ code: "custom", message: "A completed video task requires a brief.", path: ["brief"] });
  }
  if (result.status === "blocked" && result.brief) {
    context.addIssue({ code: "custom", message: "A blocked video task cannot include a renderable brief.", path: ["brief"] });
  }
});

export const videoQualityReportSchema = z.object({
  passed: z.boolean(),
  checks: z.array(z.object({
    id: z.string().min(1).max(80),
    label: z.string().min(1).max(200),
    passed: z.boolean(),
    detail: z.string().min(1).max(500),
  }).strict()).min(1).max(20),
  checkedAt: z.string().datetime(),
}).strict();

export const videoJobSchema = z.object({
  id: z.string().uuid(),
  subject: z.string(),
  goal: videoGoalSchema,
  language: videoLanguageSchema,
  template: videoTemplateSchema,
  durationSeconds: z.number().int(),
  state: videoJobStateSchema,
  progress: z.number().int().min(0).max(100),
  stageLabel: z.string(),
  selectedHook: z.string().nullable(),
  caption: z.string().nullable(),
  hashtags: z.array(z.string()),
  heuristicScore: z.number().int().nullable(),
  qualityReport: videoQualityReportSchema.nullable(),
  hasVideo: z.boolean(),
  hasThumbnail: z.boolean(),
  errorCode: z.string().nullable(),
  attemptCount: z.number().int().min(0).max(2),
  canRetry: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
}).strict();

export const videoJobsResponseSchema = z.object({
  jobs: z.array(videoJobSchema),
  localOnly: z.literal(true),
  autoPublishing: z.literal(false),
}).strict();

export const videoJobResponseSchema = z.object({
  job: videoJobSchema,
  localOnly: z.literal(true),
  autoPublishing: z.literal(false),
}).strict();

export type CreateVideoJobInput = z.infer<typeof createVideoJobSchema>;
export type VideoBrief = z.infer<typeof videoBriefSchema>;
export type VideoAgentResult = z.infer<typeof videoAgentResultSchema>;
export type VideoQualityReport = z.infer<typeof videoQualityReportSchema>;
export type VideoJob = z.infer<typeof videoJobSchema>;

export function parseVideoAgentResult(value: string): VideoAgentResult {
  return videoAgentResultSchema.parse(JSON.parse(value));
}

export const videoAgentOutputJsonSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["completed", "blocked"] },
    summary: { type: "string" },
    evidence: { type: "array", items: { type: "string" }, maxItems: 12 },
    brief: {
      anyOf: [{
        type: "object",
        properties: {
          version: { type: "integer", enum: [1] },
          title: { type: "string" },
          language: { type: "string", enum: ["fr", "en"] },
          platforms: { type: "array", items: { type: "string", enum: ["tiktok", "instagram_reels"] }, minItems: 2, maxItems: 2 },
          template: { type: "string", enum: videoTemplateSchema.options },
          durationSeconds: { type: "integer", minimum: 15, maximum: 60 },
          hooks: { type: "array", minItems: 3, maxItems: 3, items: { type: "object", properties: { id: { type: "string", enum: ["hook_1", "hook_2", "hook_3"] }, text: { type: "string" }, score: { type: "integer", minimum: 0, maximum: 100 }, rationale: { type: "string" } }, required: ["id", "text", "score", "rationale"], additionalProperties: false } },
          selectedHookId: { type: "string", enum: ["hook_1", "hook_2", "hook_3"] },
          voiceScript: { type: "string" },
          scenes: { type: "array", minItems: 3, maxItems: 8, items: { type: "object", properties: { id: { type: "string" }, startSeconds: { type: "number" }, durationSeconds: { type: "number" }, headline: { type: "string" }, body: { type: "string" }, narration: { type: "string" }, accent: { type: "string", enum: ["gold", "sky", "rose", "emerald"] }, transition: { type: "string", enum: ["cut", "slide", "zoom", "wipe"] } }, required: ["id", "startSeconds", "durationSeconds", "headline", "body", "narration", "accent", "transition"], additionalProperties: false } },
          caption: { type: "string" },
          hashtags: { type: "array", minItems: 3, maxItems: 12, items: { type: "string" } },
          heuristicScore: { type: "integer", minimum: 0, maximum: 100 },
          rightsDeclarations: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", properties: { asset: { type: "string" }, basis: { type: "string", enum: ["generated_in_remotion", "owner_provided", "licensed_local", "public_domain"] }, source: { type: "string" } }, required: ["asset", "basis", "source"], additionalProperties: false } },
        },
        required: ["version", "title", "language", "platforms", "template", "durationSeconds", "hooks", "selectedHookId", "voiceScript", "scenes", "caption", "hashtags", "heuristicScore", "rightsDeclarations"],
        additionalProperties: false,
      }, { type: "null" }],
    },
  },
  required: ["status", "summary", "evidence", "brief"],
  additionalProperties: false,
} as const;
