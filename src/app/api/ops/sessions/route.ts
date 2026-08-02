import { NextRequest } from "next/server";
import { StrategicCompanySessionService } from "@/lib/company-sessions";
import { getDatabasePool } from "@/lib/db";
import { apiError, noStoreJson } from "@/lib/http";
import { assertOpsMutation, requireOpsSession } from "@/lib/ops/auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    requireOpsSession(request);
    const sessions = await new StrategicCompanySessionService(getDatabasePool()).list();
    return noStoreJson({ sessions, localOnly: true, realExecution: true });
  } catch (error) {
    return apiError(error, "OPS_COMPANY_SESSIONS_FAILED");
  }
}
export async function POST(request: NextRequest) {
  try {
    assertOpsMutation(request);
    const session = await new StrategicCompanySessionService(getDatabasePool()).create(await request.json());
    return noStoreJson({ session, localOnly: true, realExecution: true }, { status: 202 });
  } catch (error) {
    return apiError(error, "OPS_COMPANY_SESSION_START_FAILED");
  }
}
