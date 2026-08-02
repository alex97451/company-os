import { NextRequest } from "next/server";
import { ConnectorRepository } from "@/lib/connectors";
import { getDatabasePool } from "@/lib/db";
import { apiError, noStoreJson } from "@/lib/http";
import { requireOpsSession } from "@/lib/ops/auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    requireOpsSession(request);
    const connectors = await new ConnectorRepository(getDatabasePool()).list();
    return noStoreJson({ connectors });
  } catch (error) {
    return apiError(error, "OPS_CONNECTORS_FAILED");
  }
}
