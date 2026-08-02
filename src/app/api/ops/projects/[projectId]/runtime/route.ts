import { NextRequest } from "next/server";
import { getDatabasePool } from "@/lib/db";
import { apiError, noStoreJson } from "@/lib/http";
import {
  initializeCompanyProject,
  projectIdSchema,
  stopCompanyProjectRuntime,
} from "@/lib/projects";
import { assertOwnerMutation } from "@/lib/ops/auth";

export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

export async function POST(request: NextRequest, context: Context) {
  try {
    assertOwnerMutation(request);
    const projectId = projectIdSchema.parse((await context.params).projectId);
    const initialization = await initializeCompanyProject(getDatabasePool(), projectId);
    return noStoreJson({ ok: true, initialization });
  } catch (error) {
    return apiError(error, "OPS_PROJECT_INITIALIZATION_FAILED");
  }
}

export async function DELETE(request: NextRequest, context: Context) {
  try {
    assertOwnerMutation(request);
    const projectId = projectIdSchema.parse((await context.params).projectId);
    await stopCompanyProjectRuntime(getDatabasePool(), projectId);
    return noStoreJson({ ok: true });
  } catch (error) {
    return apiError(error, "OPS_PROJECT_STOP_FAILED");
  }
}
