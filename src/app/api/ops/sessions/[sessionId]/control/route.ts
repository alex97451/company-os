import { NextRequest } from "next/server";
import { StrategicCompanySessionService } from "@/lib/company-sessions";
import { getDatabasePool } from "@/lib/db";
import { apiError, noStoreJson } from "@/lib/http";
import { assertOpsMutation } from "@/lib/ops/auth";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  try {
    assertOpsMutation(request);
    const { sessionId } = await context.params;
    const session = await new StrategicCompanySessionService(getDatabasePool()).control(sessionId, await request.json());
    return noStoreJson({ session, localOnly: true, realExecution: true });
  } catch (error) {
    return apiError(error, "OPS_COMPANY_SESSION_CONTROL_FAILED");
  }
}
