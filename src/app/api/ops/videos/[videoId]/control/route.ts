import { NextRequest } from "next/server";
import { z } from "zod";
import { getDatabasePool } from "@/lib/db";
import { apiError, noStoreJson } from "@/lib/http";
import { assertOwnerMutation } from "@/lib/ops/auth";
import { VideoStudioService } from "@/lib/videos";

export const runtime = "nodejs";
const inputSchema = z.object({ action: z.enum(["cancel", "retry"]) }).strict();

export async function POST(request: NextRequest, context: { params: Promise<{ videoId: string }> }) {
  try {
    assertOwnerMutation(request);
    const input = inputSchema.parse(await request.json());
    const { videoId } = await context.params;
    const service = new VideoStudioService(getDatabasePool());
    const job = input.action === "cancel" ? await service.cancel(videoId) : await service.retry(videoId);
    return noStoreJson({ job, localOnly: true, autoPublishing: false });
  } catch (error) {
    return apiError(error, "OPS_VIDEO_CONTROL_FAILED");
  }
}
