import { NextRequest } from "next/server";
import { getDatabasePool } from "@/lib/db";
import { apiError, noStoreJson } from "@/lib/http";
import {
  CompanyProjectRepository,
  configuredProjectRoots,
  initializeCompanyProject,
  registerCompanyProjectSchema,
} from "@/lib/projects";
import { assertOwnerMutation, requireOpsSession } from "@/lib/ops/auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    requireOpsSession(request);
    const repository = new CompanyProjectRepository(getDatabasePool());
    await repository.ensureCurrent();
    const { allowedRoots } = configuredProjectRoots();
    return noStoreJson({
      projects: await repository.list(),
      policy: { allowedRoots },
    });
  } catch (error) {
    return apiError(error, "OPS_PROJECTS_FAILED");
  }
}

export async function POST(request: NextRequest) {
  try {
    assertOwnerMutation(request);
    const input = registerCompanyProjectSchema.parse(await request.json());
    const pool = getDatabasePool();
    const repository = new CompanyProjectRepository(pool);
    await repository.register(input);
    const initialization = await initializeCompanyProject(pool, input.id);
    return noStoreJson({ ok: true, initialization });
  } catch (error) {
    return apiError(error, "OPS_PROJECT_REGISTER_FAILED");
  }
}
