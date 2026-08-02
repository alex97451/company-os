import { NextRequest } from "next/server";
import { z } from "zod";
import { CockpitRepository, getDatabasePool } from "@/lib/db";
import { apiError, noStoreJson } from "@/lib/http";
import { assertOpsMutation } from "@/lib/ops/auth";

export const runtime = "nodejs";

const commandSchema = z.object({
  idempotencyKey: z.string().uuid(),
  expectedAggregateVersion: z.number().int().min(0),
  message: z.string().trim().min(1).max(1_200),
}).strict();

export async function POST(request: NextRequest) {
  try {
    const actor = assertOpsMutation(request);
    const input = commandSchema.parse(await request.json());
    const commandId = await new CockpitRepository(getDatabasePool()).createOwnerCommand({
      idempotencyKey: input.idempotencyKey,
      expectedAggregateVersion: input.expectedAggregateVersion,
      commandType: "owner.message",
      safePayload: { message: input.message, actorId: actor.actorId, actorRole: actor.role },
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    return noStoreJson({ commandId, state: "waiting" }, { status: 202 });
  } catch (error) {
    return apiError(error, "OPS_COMMAND_FAILED");
  }
}
