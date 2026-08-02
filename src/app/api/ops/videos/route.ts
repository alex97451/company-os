import { NextRequest } from "next/server";
import { getDatabasePool } from "@/lib/db";
import { apiError, noStoreJson } from "@/lib/http";
import { assertOwnerMutation, requireOpsSession } from "@/lib/ops/auth";
import { VideoStudioService } from "@/lib/videos";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    requireOpsSession(request);
    const jobs = await new VideoStudioService(getDatabasePool()).list();
    return noStoreJson({ jobs, localOnly: true, autoPublishing: false });
  } catch (error) {
    return apiError(error, "OPS_VIDEO_LIST_FAILED");
  }
}

export async function POST(request: NextRequest) {
  try {
    assertOwnerMutation(request);
    const job = await new VideoStudioService(getDatabasePool()).create(await request.json());
    return noStoreJson({ job, localOnly: true, autoPublishing: false }, { status: 202 });
  } catch (error) {
    return apiError(error, "OPS_VIDEO_CREATE_FAILED");
  }
}
