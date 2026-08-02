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

export type CompanyProjectManifest = z.infer<typeof companyProjectManifestSchema>;
export type RegisterCompanyProject = z.infer<typeof registerCompanyProjectSchema>;
