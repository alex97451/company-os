import { z } from "zod";

export function normalizeProjectId(value: string): string {
  return value
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

export const projectIdSchema = z.preprocess(
  (value) => typeof value === "string" ? normalizeProjectId(value) : value,
  z.string().regex(/^[a-z][a-z0-9-]{2,62}$/),
);
export const projectKindSchema = z.enum(["saas", "web_app", "api", "library", "generic"]);

export const projectTechnologySchema = z.enum([
  "Node.js",
  "TypeScript",
  "JavaScript",
  "Next.js",
  "React",
  "Python",
  "Docker",
]);

export const projectDiscoverySchema = z.object({
  version: z.literal(1),
  analyzedAt: z.string().datetime(),
  canonicalPath: z.string().trim().min(3).max(1_024),
  existingProjectId: projectIdSchema.nullable(),
  writable: z.literal(true),
  technologies: z.array(projectTechnologySchema).max(16),
  packageManager: z.enum(["npm", "pnpm", "yarn", "bun", "none"]),
  scripts: z.array(z.string().regex(/^[a-zA-Z0-9:_-]{1,100}$/)).max(100),
  documentation: z.object({
    readme: z.boolean(),
    agentInstructions: z.boolean(),
    docsDirectory: z.boolean(),
    markdownFiles: z.number().int().min(0).max(500),
  }).strict(),
  git: z.object({
    state: z.enum(["clean", "changes", "not_repository", "unavailable"]),
    branch: z.string().trim().min(1).max(200).nullable(),
    changedFiles: z.number().int().min(0).max(100_000),
  }).strict(),
  suggestedKind: projectKindSchema,
  commands: z.object({
    verify: z.string().trim().min(1).max(300),
    start: z.string().trim().min(1).max(300),
    stop: z.string().trim().min(1).max(300),
  }).strict(),
}).strict();

export const projectInitializationStepIdSchema = z.enum([
  "folder_check",
  "workspace_analysis",
  "local_files",
  "database",
  "storage",
  "team",
  "cockpit",
]);

export const projectInitializationProgressSchema = z.object({
  version: z.literal(1),
  state: z.enum(["validated", "starting", "ready", "error"]),
  updatedAt: z.string().datetime(),
  steps: z.array(z.object({
    id: projectInitializationStepIdSchema,
    status: z.enum(["pending", "active", "complete", "error"]),
    message: z.string().trim().min(1).max(300),
  }).strict()).length(7),
}).strict();

export const projectInitialReviewBasisSchema = z.enum([
  "technologies",
  "commands",
  "documentation",
  "git",
  "operational_readiness",
]);

export const projectInitialReviewPrioritySchema = z.object({
  id: z.enum(["P1", "P2", "P3"]),
  title: z.string().trim().min(3).max(160),
  observation: z.string().trim().min(3).max(600),
  basis: z.array(projectInitialReviewBasisSchema).min(1).max(5),
  acceptanceCriteria: z.array(z.string().trim().min(3).max(300)).min(1).max(5),
}).strict();

export const projectInitialReviewResultSchema = z.object({
  version: z.literal(1),
  conclusion: z.string().trim().min(3).max(2_000),
  limits: z.array(z.string().trim().min(3).max(500)).min(1).max(6),
  priorities: z.array(projectInitialReviewPrioritySchema).length(3),
}).strict().superRefine((value, context) => {
  const expectedIds = ["P1", "P2", "P3"];
  value.priorities.forEach((priority, index) => {
    if (priority.id !== expectedIds[index]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Priorities must be ordered P1, P2 and P3.",
        path: ["priorities", index, "id"],
      });
    }
  });
}).refine(
  (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 8_192,
  "Initial review result exceeds 8 KiB.",
);

export const projectInitialReviewSchema = z.object({
  version: z.literal(1),
  state: z.enum(["queued", "running", "completed", "error"]),
  commandId: z.string().uuid().nullable(),
  triggeredAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  conclusion: z.string().trim().min(3).max(2_000).nullable(),
  limits: z.array(z.string().trim().min(3).max(500)).max(6),
  priorities: z.array(projectInitialReviewPrioritySchema).max(3),
  errorCode: z.string().regex(/^[A-Z0-9_]{3,120}$/).nullable(),
}).strict().superRefine((value, context) => {
  if (["queued", "running"].includes(value.state)) {
    if (!value.commandId) context.addIssue({ code: z.ZodIssueCode.custom, message: "Active review requires a command.", path: ["commandId"] });
    if (value.completedAt || value.conclusion || value.limits.length || value.priorities.length || value.errorCode) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Active review cannot contain a final result." });
    }
  }
  if (value.state === "completed") {
    if (!value.commandId || !value.completedAt || !value.conclusion || value.limits.length < 1 || value.priorities.length !== 3 || value.errorCode) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Completed review requires a validated result." });
    }
  }
  if (value.state === "error") {
    if (!value.completedAt || !value.conclusion || value.limits.length < 1 || !value.errorCode || value.priorities.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Failed review requires an owner-facing conclusion and limitation." });
    }
  }
});

export const companyProjectManifestSchema = z.object({
  version: z.literal(1),
  id: projectIdSchema,
  displayName: z.string().trim().min(2).max(120),
  kind: projectKindSchema,
  isolationMode: z.literal("dedicated_runtime"),
  companyDirectory: z.string().trim().min(1).max(200),
  agentRoster: z.string().trim().min(1).max(240),
  externalWorkEnabledByDefault: z.literal(false),
  commands: z.object({
    verify: z.string().trim().min(1).max(300),
    start: z.string().trim().min(1).max(300),
    stop: z.string().trim().min(1).max(300),
  }).strict(),
}).strict();

export const registerCompanyProjectSchema = z.object({
  id: projectIdSchema,
  displayName: z.string().trim().min(2).max(120),
  kind: projectKindSchema,
  workspacePath: z.string().trim().min(3).max(1_024),
}).strict();

export const projectPreflightRequestSchema = z.object({
  workspacePath: z.string().trim().min(3).max(1_024),
}).strict();

export type CompanyProjectManifest = z.infer<typeof companyProjectManifestSchema>;
export type RegisterCompanyProject = z.infer<typeof registerCompanyProjectSchema>;
export type ProjectTechnology = z.infer<typeof projectTechnologySchema>;
export type ProjectDiscovery = z.infer<typeof projectDiscoverySchema>;
export type ProjectInitializationProgress = z.infer<typeof projectInitializationProgressSchema>;
export type ProjectInitializationStepId = z.infer<typeof projectInitializationStepIdSchema>;
export type ProjectInitialReview = z.infer<typeof projectInitialReviewSchema>;
export type ProjectInitialReviewBasis = z.infer<typeof projectInitialReviewBasisSchema>;
export type ProjectInitialReviewPriority = z.infer<typeof projectInitialReviewPrioritySchema>;
export type ProjectInitialReviewResult = z.infer<typeof projectInitialReviewResultSchema>;
