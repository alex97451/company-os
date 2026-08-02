import { NextRequest } from "next/server";
import { z } from "zod";
import { CockpitRepository, getDatabasePool } from "@/lib/db";
import { apiError, noStoreJson } from "@/lib/http";
import { assertOwnerMutation } from "@/lib/ops/auth";

export const runtime = "nodejs";

const decisionSchema = z.object({
  approvalId: z.string().uuid(),
  actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  policyVersion: z.number().int().positive(),
  actionVersion: z.number().int().positive(),
  decision: z.enum(["approved", "refused"]),
}).strict();

export async function POST(request: NextRequest) {
  try {
    assertOwnerMutation(request);
    const input = decisionSchema.parse(await request.json());
    await new CockpitRepository(getDatabasePool()).decideApproval(input);
    return noStoreJson({ ok: true, decision: input.decision });
  } catch (error) {
    return apiError(error, "OPS_APPROVAL_FAILED");
  }
}
