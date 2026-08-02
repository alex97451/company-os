import { readFile } from "node:fs/promises";
import { NextRequest } from "next/server";
import { z } from "zod";
import { getDatabasePool } from "@/lib/db";
import { apiError } from "@/lib/http";
import { requireOpsSession } from "@/lib/ops/auth";
import { VideoStudioService } from "@/lib/videos";

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: Promise<{ videoId: string; kind: string }> }) {
  try {
    requireOpsSession(request);
    const { videoId, kind: rawKind } = await context.params;
    const kind = z.enum(["video", "thumbnail"]).parse(rawKind);
    const service = new VideoStudioService(getDatabasePool());
    const job = await service.get(videoId);
    if (!job || job.state !== "completed" || (kind === "video" ? !job.hasVideo : !job.hasThumbnail)) {
      throw new Error("VIDEO_MEDIA_NOT_FOUND");
    }
    const bytes = await readFile(service.mediaPath(videoId, kind));
    const range = kind === "video" ? parseRange(request.headers.get("range"), bytes.byteLength) : null;
    const body = range ? bytes.subarray(range.start, range.end + 1) : bytes;
    return new Response(body, {
      status: range ? 206 : 200,
      headers: {
        "content-type": kind === "video" ? "video/mp4" : "image/png",
        "content-length": String(body.byteLength),
        "cache-control": "private, no-store",
        "content-disposition": `${request.nextUrl.searchParams.get("download") === "1" ? "attachment" : "inline"}; filename="${kind === "video" ? `video-${videoId}.mp4` : `miniature-${videoId}.png`}"`,
        "x-content-type-options": "nosniff",
        ...(kind === "video" ? { "accept-ranges": "bytes" } : {}),
        ...(range ? { "content-range": `bytes ${range.start}-${range.end}/${bytes.byteLength}` } : {}),
      },
    });
  } catch (error) {
    return apiError(error, "OPS_VIDEO_MEDIA_FAILED");
  }
}

function parseRange(header: string | null, length: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : length - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= length || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, length - 1) };
}
