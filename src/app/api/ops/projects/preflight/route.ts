import { NextRequest } from "next/server";
import { apiError, noStoreJson } from "@/lib/http";
import { inspectProjectWorkspace, projectPreflightRequestSchema } from "@/lib/projects";
import { assertOwnerMutation } from "@/lib/ops/auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertOwnerMutation(request);
    const input = projectPreflightRequestSchema.parse(await request.json());
    const discovery = await inspectProjectWorkspace(input.workspacePath);
    return noStoreJson({ ok: true, discovery });
  } catch (error) {
    return apiError(error, "OPS_PROJECT_PREFLIGHT_FAILED");
  }
}
