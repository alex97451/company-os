import { NextRequest } from "next/server";
import { z } from "zod";
import { CockpitRepository, getDatabasePool } from "@/lib/db";
import { apiError, noStoreJson } from "@/lib/http";
import { assertOwnerMutation } from "@/lib/ops/auth";

export const runtime = "nodejs";

const pauseSchema = z.object({ paused: z.boolean(), reason: z.string().trim().min(1).max(500).optional() }).strict();

export async function POST(request: NextRequest) {
  try {
    const actor = assertOwnerMutation(request);
    const input = pauseSchema.parse(await request.json());
    // An interrupt request is not a claim that active Codex work has stopped.
    const state = input.paused ? "interruption_requested" : "running";
    await new CockpitRepository(getDatabasePool()).setGeneralPause(state, actor.actorId, input.reason);
    return noStoreJson({ ok: true, state });
  } catch (error) {
    return apiError(error, "OPS_PAUSE_FAILED");
  }
}
