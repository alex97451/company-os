import { NextRequest } from "next/server";
import { getDatabasePool } from "@/lib/db";
import { apiError, noStoreJson } from "@/lib/http";
import { CompanyProjectRepository, projectIdSchema } from "@/lib/projects";
import { assertOwnerMutation } from "@/lib/ops/auth";

export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

export async function DELETE(request: NextRequest, context: Context) {
  try {
    assertOwnerMutation(request);
    const id = projectIdSchema.parse((await context.params).projectId);
    await new CompanyProjectRepository(getDatabasePool()).disconnect(id);
    return noStoreJson({ ok: true });
  } catch (error) {
    return apiError(error, "OPS_PROJECT_DISCONNECT_FAILED");
  }
}
