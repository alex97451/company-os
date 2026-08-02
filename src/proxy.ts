import { NextRequest, NextResponse } from "next/server";

const OPS_COOKIE = "company_os_ops_session";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function normalizedHost(value: string | null): string {
  if (!value) return "";
  const host = value.split(",")[0]?.trim().toLowerCase() ?? "";
  return host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : host.replace(/:\d+$/, "");
}

function isAllowedOpsHost(value: string | null): boolean {
  const host = normalizedHost(value);
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (process.env.OPS_LAN_ENABLED !== "true" || !process.env.OPS_LAN_ORIGIN) return false;
  try {
    return host === normalizedHost(new URL(process.env.OPS_LAN_ORIGIN).host);
  } catch {
    return false;
  }
}

async function validOpsCookie(token: string | undefined): Promise<boolean> {
  try {
    const secret = process.env.OPS_SESSION_SECRET?.trim();
    if (!token || !secret || secret.length < 32 || token.length > 256) return false;
    const parts = token.split(".");
    const legacy = parts.length === 4;
    const [version, expires, nonce, actorId, role, signature, extra] = legacy
      ? ["v1", parts[0], parts[1], "owner", "owner", parts[2], parts[3]]
      : parts;
    if (!expires || !nonce || !signature || extra) return false;
    if (version !== "v1" && version !== "v2") return false;
    if (version === "v2" && (!actorId || !/^[a-z][a-z0-9_-]{1,31}$/.test(actorId) || !["owner", "operator"].includes(role ?? ""))) return false;
    const expiry = Number(expires);
    if (!Number.isSafeInteger(expiry) || expiry * 1000 <= Date.now()) return false;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const base64 = signature.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(signature.length / 4) * 4, "=");
    const signatureBytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const payload = version === "v1" ? `${expires}.${nonce}` : `${version}.${expires}.${nonce}.${actorId}.${role}`;
    return crypto.subtle.verify("HMAC", key, signatureBytes, new TextEncoder().encode(payload));
  } catch {
    return false;
  }
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (!isAllowedOpsHost(request.headers.get("host")) || (forwardedHost && !isAllowedOpsHost(forwardedHost))) {
    return new NextResponse(null, {
      status: 404,
      headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive" },
    });
  }
  if (pathname === "/ops/login" || pathname === "/api/ops/auth/login") return NextResponse.next();
  if (/^\/api\/ops\/connectors\/(?:meta|reddit)\/oauth\/callback$/.test(pathname)) return NextResponse.next();
  if (await validOpsCookie(request.cookies.get(OPS_COOKIE)?.value)) return NextResponse.next();
  if (pathname.startsWith("/api/ops/")) {
    return NextResponse.json({ error: "OPS_SESSION_REQUIRED" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const login = request.nextUrl.clone();
  login.pathname = "/ops/login";
  login.search = "";
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/ops/:path*", "/api/ops/:path*"]
};
