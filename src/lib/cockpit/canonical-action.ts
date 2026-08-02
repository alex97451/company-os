import { createHash } from "node:crypto";
import { z } from "zod";

const jsonPrimitiveSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
type JsonValue = z.infer<typeof jsonPrimitiveSchema> | JsonValue[] | { [key: string]: JsonValue };
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([jsonPrimitiveSchema, z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
);

export const canonicalActionSchema = z.object({
  target: z.string().trim().min(1).max(256),
  operation: z.string().trim().min(1).max(128),
  parameters: z.record(z.string(), jsonValueSchema),
  maximumImpact: z.object({
    amountUsdMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    affectedRecords: z.number().int().min(0).max(1_000_000).optional(),
    description: z.string().trim().min(1).max(500),
  }).strict(),
  policyVersion: z.number().int().positive(),
  actionVersion: z.number().int().positive(),
}).strict();

export type CanonicalAction = z.infer<typeof canonicalActionSchema>;

function canonicalizeValue(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeValue).join(",")}]`;
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalizeValue(item)}`).join(",")}}`;
}
export function canonicalizeAction(input: unknown): string {
  return canonicalizeValue(canonicalActionSchema.parse(input));
}

export function digestCanonicalAction(input: unknown): string {
  return createHash("sha256").update(canonicalizeAction(input)).digest("hex");
}
