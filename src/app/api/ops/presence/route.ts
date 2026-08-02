import { NextRequest } from "next/server";
import { z } from "zod";
import { getDatabasePool } from "@/lib/db";
import { apiError, noStoreJson } from "@/lib/http";
import { assertOpsMutation, requireOpsSession } from "@/lib/ops/auth";
import { listOpsPresence, opsViewSchema, recordOpsPresence } from "@/lib/ops/presence";

export const runtime = "nodejs";

const presenceInputSchema = z.object({ activeView: opsViewSchema }).strict();

export async function GET(request: NextRequest) {
  try {
    requireOpsSession(request);
    return noStoreJson({ presence: await listOpsPresence(getDatabasePool()) });
  } catch (error) {
    return apiError(error, "OPS_PRESENCE_FAILED");
  }
}

export async function POST(request: NextRequest) {
  try {
    const claims = assertOpsMutation(request);
    const input = presenceInputSchema.parse(await request.json());
    return noStoreJson({ presence: await recordOpsPresence(getDatabasePool(), claims, input.activeView) });
  } catch (error) {
    return apiError(error, "OPS_PRESENCE_UPDATE_FAILED");
  }
}
