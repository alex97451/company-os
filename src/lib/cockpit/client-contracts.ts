import { z } from "zod";

const ownerStatusSchema = z.enum(["waiting", "working", "action_required", "done", "problem"]);
const modelProfileSchema = z.enum(["rapid", "balanced", "expert", "critical"]);

const agentSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  role: z.string().min(1),
  status: z.enum(["offline", "waiting", "working", "action_required", "problem", "paused", "uncertain"]),
  currentTaskId: z.string().uuid().nullable(),
  currentTaskTitle: z.string().nullable(),
  modelProfile: modelProfileSchema.nullable(),
  heartbeatAt: z.string().datetime().nullable(),
  ownerStatus: ownerStatusSchema,
}).strict();

const agentActivitySchema = z.object({
  agentId: z.string().min(1),
  taskId: z.string().uuid().nullable(),
  runId: z.string().uuid().nullable(),
  taskTitle: z.string().nullable(),
  intendedOutcome: z.string().nullable(),
  phase: z.enum(["idle", "preparing", "dispatching", "working", "verification", "completed", "problem"]),
  startedAt: z.string().datetime().nullable(),
  lastSignalAt: z.string().datetime().nullable(),
  modelProfile: modelProfileSchema.nullable(),
  events: z.array(z.object({
    sequence: z.string().regex(/^\d+$/),
    id: z.string().uuid(),
    eventType: z.string().min(1),
    occurredAt: z.string().datetime(),
    tone: z.enum(["neutral", "working", "success", "problem"]),
    detail: z.string().max(4_000).nullable(),
  }).strict()).max(20),
}).strict();

const taskSchema = z.object({
  id: z.string().uuid(),
  assignedAgentId: z.string().min(1),
  verifierAgentId: z.string().min(1).nullable(),
  title: z.string().min(1),
  intendedOutcome: z.string(),
  completionSummary: z.string().nullable(),
  riskClass: z.string().min(1),
  status: z.enum(["queued", "working", "action_required", "verification", "done", "problem", "paused"]),
  aggregateVersion: z.number().int().min(0),
  updatedAt: z.string().datetime(),
  ownerStatus: ownerStatusSchema,
}).strict();

const approvalSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  requestedByAgentId: z.string().min(1),
  actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  policyVersion: z.number().int().positive(),
  actionVersion: z.number().int().positive(),
  riskClass: z.enum(["financial", "advertising", "production"]),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  ownerExplanation: z.object({
    willHappen: z.string().min(1).max(2_000),
    willNotHappen: z.string().min(1).max(2_000),
    refusalEffect: z.string().min(1).max(2_000),
    reversible: z.string().min(1).max(2_000),
  }).strict(),
}).strict();

const pauseSchema = z.object({
  state: z.enum(["running", "pause_active", "interruption_requested", "work_still_active", "confirmed_stopped"]),
  reason: z.string().nullable(),
  version: z.number().int().min(0),
  changedBy: z.string(),
  changedAt: z.string().datetime(),
}).strict();

const messageSchema = z.object({
  id: z.string().uuid(),
  sender: z.enum(["owner", "ceo"]),
  commandId: z.string().uuid(),
  safeBody: z.string().min(1).max(16_384),
  status: z.enum(["pending", "dispatched", "completed", "failed", "reconciliation_required", "demo"]),
  createdAt: z.string().datetime(),
}).strict();

const runtimeComponentSchema = z.object({
  component: z.enum(["supervisor", "bridge", "codex"]),
  status: z.enum(["connected", "degraded", "offline"]),
  detailCode: z.string().nullable(),
  heartbeatAt: z.string().datetime(),
}).strict();

const runtimeHealthSchema = z.object({
  database: z.object({
    status: z.literal("connected"),
    heartbeatAt: z.string().datetime(),
  }).strict(),
  supervisor: runtimeComponentSchema,
  bridge: runtimeComponentSchema,
  codex: runtimeComponentSchema,
}).strict();

export const cockpitEventSchema = z.object({
  sequence: z.string().regex(/^\d+$/),
  id: z.string().uuid(),
  eventType: z.string().min(1),
  aggregateType: z.enum(["agent", "command", "task", "run", "approval", "budget", "pause", "system"]),
  aggregateId: z.string(),
  safePayload: z.record(z.string(), z.unknown()),
  occurredAt: z.string().datetime(),
}).strict();

export const snapshotResponseSchema = z.object({
  mode: z.string().min(1),
  project: z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]{2,62}$/),
    displayName: z.string().min(2).max(120),
  }).strict(),
  access: z.object({
    actorId: z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),
    role: z.enum(["owner", "operator"]),
  }).strict(),
  snapshot: z.object({
    agents: z.array(agentSchema),
    agentActivity: z.array(agentActivitySchema),
    tasks: z.array(taskSchema),
    approvals: z.array(approvalSchema),
    messages: z.array(messageSchema),
    pause: pauseSchema,
    health: runtimeHealthSchema,
    latestEvents: z.array(cockpitEventSchema),
    lastSequence: z.string().regex(/^\d+$/),
    commandVersion: z.number().int().min(0),
  }).strict(),
}).strict();

export const commandResponseSchema = z.object({
  commandId: z.string().uuid(),
  state: z.literal("waiting"),
}).strict();

export const approvalResponseSchema = z.object({
  ok: z.literal(true),
  decision: z.enum(["approved", "refused"]),
}).strict();

export const pauseResponseSchema = z.object({
  ok: z.literal(true),
  state: z.enum(["interruption_requested", "running"]),
}).strict();

export const opsPresenceResponseSchema = z.object({
  presence: z.array(z.object({
    actorId: z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),
    role: z.enum(["owner", "operator"]),
    activeView: z.enum(["overview", "work", "team", "health", "integrations"]),
    lastSeenAt: z.string().datetime(),
  }).strict()).max(20),
}).strict();

export const opsOperatorAccessResponseSchema = z.discriminatedUnion("configured", [
  z.object({ configured: z.literal(false) }).strict(),
  z.object({
    configured: z.literal(true),
    username: z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),
    password: z.string().min(12).max(256),
    url: z.string().url(),
  }).strict(),
]);

export type OpsSnapshotResponse = z.infer<typeof snapshotResponseSchema>;
export type OpsSnapshot = OpsSnapshotResponse["snapshot"];
export type OpsProjectIdentity = OpsSnapshotResponse["project"];
export type OpsAccess = OpsSnapshotResponse["access"];
export type OpsEvent = z.infer<typeof cockpitEventSchema>;
export type OpsApproval = OpsSnapshot["approvals"][number];
export type OpsPresence = z.infer<typeof opsPresenceResponseSchema>["presence"][number];
export type OpsOperatorAccess = z.infer<typeof opsOperatorAccessResponseSchema>;

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${encodeURIComponent(name)}=`;
  const match = document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(prefix));
  if (!match) return null;
  try {
    return decodeURIComponent(match.slice(prefix.length));
  } catch {
    return null;
  }
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return null;
  return response.json();
}

export async function fetchOpsSnapshot(signal?: AbortSignal): Promise<OpsSnapshotResponse> {
  const response = await fetch("/api/ops/snapshot", { cache: "no-store", credentials: "same-origin", signal });
  const payload = await readJson(response);
  if (!response.ok) throw new Error(response.status === 401 ? "SESSION_EXPIRED" : "SNAPSHOT_UNAVAILABLE");
  const parsed = snapshotResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error("INVALID_SNAPSHOT");
  return parsed.data;
}

export async function postOpsJson<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  const csrf = readCookie("company_os_ops_csrf");
  if (!csrf) throw new Error("CSRF_UNAVAILABLE");
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-company-os-csrf": csrf },
    body: JSON.stringify(body),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    if (response.status === 401) throw new Error("SESSION_EXPIRED");
    if (response.status === 409) throw new Error("STALE_STATE");
    if (response.status === 422 && payload && typeof payload === "object" && "error" in payload
      && payload.error === "OWNER_MESSAGE_SENSITIVE_DATA") throw new Error("OWNER_MESSAGE_SENSITIVE_DATA");
    if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") {
      throw new Error(payload.error);
    }
    throw new Error("REQUEST_FAILED");
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new Error("INVALID_RESPONSE");
  return parsed.data;
}
