import type { Pool } from "pg";
import { z } from "zod";
import { safeOperationalPayloadSchema } from "@/lib/cockpit/domain";
import type { OpsSessionClaims } from "./auth";

export const opsViewSchema = z.enum(["overview", "work", "team", "health", "integrations"]);
export type OpsViewId = z.infer<typeof opsViewSchema>;

export const opsPresenceSchema = z.object({
  actorId: z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),
  role: z.enum(["owner", "operator"]),
  activeView: opsViewSchema,
  lastSeenAt: z.string().datetime(),
}).strict();

export type OpsPresence = z.infer<typeof opsPresenceSchema>;

export async function recordOpsPresence(
  pool: Pool,
  claims: OpsSessionClaims,
  activeViewRaw: unknown,
): Promise<OpsPresence[]> {
  const activeView = opsViewSchema.parse(activeViewRaw);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const previous = await client.query<{ active_view: string; last_seen_at: Date }>(
      "SELECT active_view, last_seen_at FROM ops_collaborator_presence WHERE actor_id = $1 FOR UPDATE",
      [claims.actorId],
    );
    await client.query(
      `INSERT INTO ops_collaborator_presence (actor_id, role, active_view)
       VALUES ($1,$2,$3)
       ON CONFLICT (actor_id) DO UPDATE
         SET role = EXCLUDED.role, active_view = EXCLUDED.active_view, last_seen_at = now()`,
      [claims.actorId, claims.role, activeView],
    );
    const prior = previous.rows[0];
    if (!prior || prior.active_view !== activeView || Date.now() - prior.last_seen_at.getTime() > 30_000) {
      await client.query(
        `INSERT INTO cockpit_events (event_type, aggregate_type, aggregate_id, safe_payload)
         VALUES ('ops.presence.updated','system',$1,$2)`,
        [claims.actorId, safeOperationalPayloadSchema.parse({
          actorId: claims.actorId,
          actorRole: claims.role,
          activeView,
        })],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return listOpsPresence(pool);
}

export async function listOpsPresence(pool: Pool): Promise<OpsPresence[]> {
  const result = await pool.query<{
    actorId: string;
    role: "owner" | "operator";
    activeView: OpsViewId;
    lastSeenAt: Date;
  }>(
    `SELECT actor_id AS "actorId", role, active_view AS "activeView", last_seen_at AS "lastSeenAt"
       FROM ops_collaborator_presence
      WHERE last_seen_at > now() - interval '45 seconds'
      ORDER BY role, actor_id`,
  );
  return result.rows.map((row) => opsPresenceSchema.parse({
    ...row,
    lastSeenAt: row.lastSeenAt.toISOString(),
  }));
}
