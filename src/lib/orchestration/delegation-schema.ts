import { z } from "zod";
import { companyAgentIdSchema, riskClassSchema } from "../agents/registry";
import { modelProfileSchema, taskComplexitySchema, taskUrgencySchema } from "../cockpit/domain";

export const delegatedAgentIdSchema = companyAgentIdSchema.exclude(["ceo"]);

export const ceoDelegationTaskSchema = z.object({
  agentId: delegatedAgentIdSchema,
  verifierAgentId: delegatedAgentIdSchema.optional(),
  title: z.string().trim().min(1).max(300),
  intendedOutcome: z.string().trim().min(1).max(2_000),
  riskClass: riskClassSchema,
  complexity: taskComplexitySchema,
  contextTokens: z.number().int().min(0).max(2_000_000),
  urgency: taskUrgencySchema,
  estimatedCostUsdMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  manualProfile: modelProfileSchema.optional(),
  manualModel: z.string().trim().min(1).max(100).optional(),
}).strict().refine((task) => task.agentId !== task.verifierAgentId, {
  message: "The verifier must be distinct from the accountable agent.",
  path: ["verifierAgentId"],
});

export const ceoDelegationEnvelopeSchema = z.object({
  version: z.literal(1),
  tasks: z.array(ceoDelegationTaskSchema).max(5),
}).strict();

export type CeoDelegationTask = z.infer<typeof ceoDelegationTaskSchema>;
export type CeoDelegationEnvelope = z.infer<typeof ceoDelegationEnvelopeSchema>;
