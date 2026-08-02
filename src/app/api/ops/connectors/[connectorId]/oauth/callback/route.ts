import { NextRequest, NextResponse } from "next/server";
import { ConnectorRepository, completeOAuthAuthorization, connectorIdSchema } from "@/lib/connectors";
import { getDatabasePool } from "@/lib/db";

export const runtime = "nodejs";

type Context = { params: Promise<{ connectorId: string }> };

export async function GET(request: NextRequest, context: Context) {
  const appUrl = process.env.APP_URL ?? "http://localhost:3020";
  try {
    const id = connectorIdSchema.parse((await context.params).connectorId);
    if (id !== "meta" && id !== "reddit") throw new Error("CONNECTOR_OAUTH_UNSUPPORTED");
    const code = request.nextUrl.searchParams.get("code");
    const state = request.nextUrl.searchParams.get("state");
    const providerError = request.nextUrl.searchParams.get("error");
    if (providerError || !code || !state) throw new Error("OAUTH_CALLBACK_REJECTED");
    await completeOAuthAuthorization(new ConnectorRepository(getDatabasePool()), id, code, state);
    return redirect(appUrl, id, "connected");
  } catch {
    return redirect(appUrl, "oauth", "error");
  }
}

function redirect(appUrl: string, connector: string, result: string): NextResponse {
  const url = new URL("/ops", appUrl);
  url.searchParams.set("view", "integrations");
  url.searchParams.set("connector", connector);
  url.searchParams.set("result", result);
  return NextResponse.redirect(url, { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
