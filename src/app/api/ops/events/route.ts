import { NextRequest } from "next/server";
import { z } from "zod";
import { CockpitRepository, getDatabasePool } from "@/lib/db";
import { apiError } from "@/lib/http";
import { requireOpsSession } from "@/lib/ops/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sequenceSchema = z.string().regex(/^\d+$/).default("0");
const encoder = new TextEncoder();

export async function GET(request: NextRequest) {
  try {
    requireOpsSession(request);
    let sequence = sequenceSchema.parse(request.headers.get("last-event-id") ?? request.nextUrl.searchParams.get("after") ?? "0");
    const repository = new CockpitRepository(getDatabasePool());
    await repository.listEventsAfter(sequence, 1);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const close = () => {
          if (closed) return;
          closed = true;
          if (timer) clearTimeout(timer);
          try { controller.close(); } catch { /* stream already closed */ }
        };
        const poll = async () => {
          if (closed || request.signal.aborted) return close();
          try {
            const events = await repository.listEventsAfter(sequence);
            if (closed || request.signal.aborted) return close();
            for (const event of events) {
              sequence = event.sequence;
              controller.enqueue(encoder.encode(`id: ${event.sequence}\nevent: cockpit\ndata: ${JSON.stringify(event)}\n\n`));
            }
            if (events.length === 0) controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
            timer = setTimeout(poll, 1_000);
          } catch {
            if (closed || request.signal.aborted) return close();
            try {
              controller.enqueue(encoder.encode("event: degraded\ndata: {\"code\":\"EVENT_STREAM_DEGRADED\"}\n\n"));
            } catch {
              return close();
            }
            close();
          }
        };
        request.signal.addEventListener("abort", close, { once: true });
        controller.enqueue(encoder.encode("retry: 1500\n\n"));
        void poll();
      },
    });
    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "Content-Type": "text/event-stream; charset=utf-8",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return apiError(error, "OPS_EVENT_STREAM_FAILED");
  }
}
