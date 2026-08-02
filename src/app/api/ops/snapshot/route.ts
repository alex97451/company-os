import { NextRequest } from "next/server";
import { CockpitRepository, getDatabasePool } from "@/lib/db";
import { apiError, noStoreJson } from "@/lib/http";
import { requireOpsSession } from "@/lib/ops/auth";
import { CompanyProjectRepository } from "@/lib/projects";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const access = requireOpsSession(request);
    const pool = getDatabasePool();
    await new CompanyProjectRepository(pool).ensureCurrent();
    const snapshot = await new CockpitRepository(pool).getSnapshot();
    return noStoreJson({
      mode: process.env.OPS_CODEX_MODE ?? "app-server-stdio",
      project: {
        id: process.env.COMPANY_OS_PROJECT_ID ?? "company-os",
        displayName: process.env.COMPANY_OS_PROJECT_NAME ?? "Company OS",
      },
      snapshot,
      access,
    });
  } catch (error) {
    return apiError(error, "OPS_SNAPSHOT_FAILED");
  }
}
