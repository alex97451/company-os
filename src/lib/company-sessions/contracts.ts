import { z } from "zod";
import { companyAgentIdSchema } from "@/lib/agents/registry";

export const companySessionModeSchema = z.enum(["global", "targeted"]);
export const companySessionStateSchema = z.enum([
  "starting", "council", "planning", "executing", "waiting_approval",
  "verifying", "blocked", "completed", "paused", "stopping", "stopped", "failed",
]);

const sessionLimits = {
  ownerFocus: z.string().trim().min(1).max(1_000).optional(),
  maxTasks: z.number().int().min(1).max(5).default(5),
  maxDurationMinutes: z.number().int().min(5).max(90).default(90),
};

export const createCompanySessionSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("global"),
    ...sessionLimits,
  }).strict(),
  z.object({
    mode: z.literal("targeted"),
    mission: z.string().trim().min(3).max(2_000),
    expectedOutcome: z.string().trim().min(1).max(2_000).optional(),
    ...sessionLimits,
  }).strict(),
]);

export const companySessionControlSchema = z.object({
  action: z.enum(["pause", "resume", "stop"]),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

export const companySessionViewSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().min(1),
  mode: companySessionModeSchema,
  mission: z.string(),
  expectedOutcome: z.string().nullable(),
  ownerFocus: z.string().nullable(),
  state: companySessionStateSchema,
  stage: z.enum(["round_1", "ceo_synthesis", "round_2", "ceo_decision", "execution", "final_report"]),
  version: z.number().int().nonnegative(),
  stopRequested: z.boolean(),
  finalReport: z.string().nullable(),
  failureCode: z.string().nullable(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
  participants: z.array(z.object({
    agentId: companyAgentIdSchema,
    status: z.enum(["invited", "working", "contributed", "blocked", "skipped"]),
    order: z.number().int().min(0).max(9),
  }).strict()).max(10),
  contributions: z.array(z.object({
    id: z.string().uuid(),
    round: z.number().int().min(1).max(2),
    kind: z.enum(["proposal", "objection", "ceo_synthesis", "ceo_decision"]),
    authorAgentId: companyAgentIdSchema,
    title: z.string(),
    status: z.enum(["queued", "working", "completed", "failed", "blocked", "cancelled"]),
    body: z.string().nullable(),
    createdAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
  }).strict()).max(30),
  deliverables: z.array(z.object({
    id: z.string().uuid(),
    title: z.string(),
    summary: z.string(),
    status: z.enum(["ready", "verified", "rejected", "blocked"]),
    producerAgentId: companyAgentIdSchema,
    verifierAgentId: companyAgentIdSchema.nullable(),
    relativePath: z.string().nullable(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    createdAt: z.string().datetime(),
  }).strict()).max(30),
  events: z.array(z.object({
    sequence: z.string().regex(/^\d+$/),
    id: z.string().uuid(),
    eventType: z.string(),
    payload: z.record(z.string(), z.unknown()),
    occurredAt: z.string().datetime(),
  }).strict()).max(100),
}).strict();

export const companySessionsResponseSchema = z.object({
  sessions: z.array(companySessionViewSchema).max(20),
  localOnly: z.literal(true),
  realExecution: z.literal(true),
}).strict();

export type CompanySessionView = z.infer<typeof companySessionViewSchema>;
export type CreateCompanySession = z.infer<typeof createCompanySessionSchema>;
