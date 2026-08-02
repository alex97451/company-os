import { NextRequest } from "next/server";
import { StrategicCompanySessionService } from "@/lib/company-sessions";
import { getDatabasePool } from "@/lib/db";
import { apiError, noStoreJson } from "@/lib/http";
import { requireOpsSession } from "@/lib/ops/auth";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  try {
    requireOpsSession(request);
    const { sessionId } = await context.params;
    const session = await new StrategicCompanySessionService(getDatabasePool()).get(sessionId);
    return noStoreJson({ session, localOnly: true, realExecution: true });
  } catch (error) {
    return apiError(error, "OPS_COMPANY_SESSION_FAILED");
  }
}
