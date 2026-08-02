import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/http";
import {
  assertLoginAllowed,
  assertOpsLoginOrigin,
  clearLoginFailures,
  createOpsSession,
  recordFailedLogin,
  setOpsCookies,
  verifyOpsCredentials,
} from "@/lib/ops/auth";

export const runtime = "nodejs";

const loginSchema = z.object({
  username: z.string().trim().min(1).max(32).optional(),
  password: z.string().min(1).max(256),
}).strict();

export async function POST(request: NextRequest) {
  try {
    assertOpsLoginOrigin(request);
    const { username, password } = loginSchema.parse(await request.json());
    const normalizedUsername = username?.trim().toLowerCase() || "owner";
    const key = `ops-login:${normalizedUsername}`;
    assertLoginAllowed(key);
    const claims = await verifyOpsCredentials(normalizedUsername, password);
    if (!claims) {
      recordFailedLogin(key);
      return NextResponse.json({ error: "INVALID_CREDENTIALS" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    clearLoginFailures(key);
    const response = NextResponse.json({ ok: true, actorId: claims.actorId, role: claims.role }, { headers: { "Cache-Control": "no-store" } });
    setOpsCookies(response, createOpsSession(claims));
    return response;
  } catch (error) {
    return apiError(error, "OPS_LOGIN_FAILED");
  }
}
