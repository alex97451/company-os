import { NextRequest } from "next/server";
import { getDatabasePool } from "@/lib/db";
import { apiError, noStoreJson } from "@/lib/http";
import { requireOpsSession } from "@/lib/ops/auth";
import { VideoStudioService } from "@/lib/videos";

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: Promise<{ videoId: string }> }) {
  try {
    requireOpsSession(request);
    const { videoId } = await context.params;
    const job = await new VideoStudioService(getDatabasePool()).get(videoId);
    if (!job) throw new Error("VIDEO_JOB_NOT_FOUND");
    return noStoreJson({ job, localOnly: true, autoPublishing: false });
  } catch (error) {
    return apiError(error, "OPS_VIDEO_GET_FAILED");
  }
}
