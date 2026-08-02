import { z } from "zod";
import { companyAgentIdSchema, riskClassSchema } from "../agents/registry";

export const modelProfileSchema = z.enum(["rapid", "balanced", "expert", "critical"]);
export const reasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]);
export const taskComplexitySchema = z.number().int().min(1).max(5);
export const taskUrgencySchema = z.enum(["low", "normal", "high", "immediate"]);

export const cockpitTaskStatusSchema = z.enum([
  "queued", "working", "action_required", "verification", "done", "problem", "paused",
]);
export const cockpitRunStatusSchema = z.enum([
  "queued", "dispatching", "working", "verification", "completed", "failed", "blocked",
  "interruption_requested", "reconciliation_required", "orphaned",
]);
export const cockpitAgentStatusSchema = z.enum([
  "offline", "waiting", "working", "action_required", "problem", "paused", "uncertain",
]);
export const ownerFacingStatusSchema = z.enum(["waiting", "working", "action_required", "done", "problem"]);

export const routerInputSchema = z.object({
  taskId: z.string().uuid(),
  accountableAgentId: companyAgentIdSchema,
  riskClass: riskClassSchema,
  complexity: taskComplexitySchema,
  contextTokens: z.number().int().min(0).max(2_000_000),
  urgency: taskUrgencySchema,
  remainingBudgetUsdMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  estimatedCostUsdMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  manualProfile: modelProfileSchema.optional(),
  manualModel: z.string().trim().min(1).max(100).optional(),
}).strict();

const safeScalarSchema = z.union([z.string().max(2_000), z.number().finite(), z.boolean(), z.null()]);
export type SafeOperationalValue = z.infer<typeof safeScalarSchema> | SafeOperationalValue[] | { [key: string]: SafeOperationalValue };
export const safeOperationalValueSchema: z.ZodType<SafeOperationalValue> = z.lazy(() =>
  z.union([
    safeScalarSchema,
    z.array(safeOperationalValueSchema).max(100),
    z.record(z.string().max(100), safeOperationalValueSchema),
  ]),
);
export const safeOperationalPayloadSchema = z.record(z.string().max(100), safeOperationalValueSchema)
  .superRefine((value, context) => {
    inspectOperationalKeys(value, context);
  })
  .refine((value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 16_384, "Operational payload exceeds 16 KiB.");

const safeTokenMetricKeys = new Set(["contexttokens", "maxoutputtokens"]);

function isSensitiveOperationalKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const compact = words.join("");
  if ((words.includes("raw") && words.some((word) => word === "quote" || word === "quotation"))
    || ["quote", "quotation", "quotecontent", "quotetext"].includes(compact)) return true;
  if (words.some((word) => ["upload", "uploaded", "email", "secret", "password", "passwd", "pwd", "credential", "credentials"].includes(word))) {
    return true;
  }
  return words.some((word) => word === "token" || word === "tokens")
    && !safeTokenMetricKeys.has(compact);
}

function inspectOperationalKeys(
  value: SafeOperationalValue,
  context: z.RefinementCtx,
  path: Array<string | number> = [],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectOperationalKeys(entry, context, [...path, index]));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = [...path, key];
    if (isSensitiveOperationalKey(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Sensitive keys are not allowed in operational payloads.",
        path: entryPath,
      });
    }
    inspectOperationalKeys(entry, context, entryPath);
  }
}

export type ModelProfile = z.infer<typeof modelProfileSchema>;
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export type CockpitTaskStatus = z.infer<typeof cockpitTaskStatusSchema>;
export type CockpitRunStatus = z.infer<typeof cockpitRunStatusSchema>;
export type CockpitAgentStatus = z.infer<typeof cockpitAgentStatusSchema>;
export type OwnerFacingStatus = z.infer<typeof ownerFacingStatusSchema>;
export type RouterInput = z.infer<typeof routerInputSchema>;

export const PROFILE_LABELS: Readonly<Record<ModelProfile, { en: string; fr: string }>> = {
  rapid: { en: "Rapid", fr: "Rapide" },
  balanced: { en: "Balanced", fr: "Équilibré" },
  expert: { en: "Expert", fr: "Expert" },
  critical: { en: "Critical", fr: "Critique" },
};

export const OWNER_STATUS_LABELS: Readonly<Record<OwnerFacingStatus, { en: string; fr: string }>> = {
  waiting: { en: "Waiting", fr: "En attente" },
  working: { en: "Working", fr: "En cours" },
  action_required: { en: "Action required", fr: "Action requise" },
  done: { en: "Done", fr: "Terminé" },
  problem: { en: "Problem", fr: "Problème" },
};

export function taskStatusForOwner(status: CockpitTaskStatus): OwnerFacingStatus {
  switch (status) {
    case "queued": case "paused": return "waiting";
    case "working": case "verification": return "working";
    case "action_required": return "action_required";
    case "done": return "done";
    case "problem": return "problem";
  }
}

export function runStatusForOwner(status: CockpitRunStatus): OwnerFacingStatus {
  switch (status) {
    case "queued": return "waiting";
    case "dispatching": case "working": case "verification": case "interruption_requested": return "working";
    case "completed": return "done";
    case "blocked": return "action_required";
    case "failed": case "reconciliation_required": case "orphaned": return "problem";
  }
}

export function agentStatusForOwner(status: CockpitAgentStatus): OwnerFacingStatus {
  switch (status) {
    case "waiting": case "offline": case "paused": return "waiting";
    case "working": return "working";
    case "action_required": return "action_required";
    case "problem": case "uncertain": return "problem";
  }
}
