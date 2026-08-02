import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { HttpSecurityError } from "@/lib/http/security";

export const OPS_SESSION_COOKIE = "company_os_ops_session";
export const OPS_CSRF_COOKIE = "company_os_ops_csrf";
const SESSION_SECONDS = 8 * 60 * 60;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const actorIdPattern = /^[a-z][a-z0-9_-]{1,31}$/;

export type OpsSessionClaims = {
  actorId: string;
  role: "owner" | "operator";
};

function requireSecret(name: "OPS_OWNER_PASSWORD" | "OPS_SESSION_SECRET", env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name]?.trim();
  if (!value || Buffer.byteLength(value) < (name === "OPS_SESSION_SECRET" ? 32 : 12)) {
    throw new HttpSecurityError("OPS_AUTH_NOT_CONFIGURED", 503);
  }
  return value;
}

export function opsAuthConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    requireSecret("OPS_OWNER_PASSWORD", env);
    requireSecret("OPS_SESSION_SECRET", env);
    return true;
  } catch {
    return false;
  }
}

export function opsOperatorConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const username = env.OPS_OPERATOR_USERNAME?.trim() ?? "";
  const password = env.OPS_OPERATOR_PASSWORD?.trim() ?? "";
  return env.OPS_LAN_ENABLED === "true"
    && actorIdPattern.test(username)
    && Buffer.byteLength(password) >= 12;
}

export function assertLoginAllowed(key: string, now = Date.now()): void {
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, { count: 0, resetAt: now + 15 * 60_000 });
    return;
  }
  if (current.count >= 5) throw new HttpSecurityError("OPS_LOGIN_THROTTLED", 429);
}

export function assertOpsLoginOrigin(request: NextRequest): void {
  const origin = request.headers.get("origin");
  if (!origin || !allowedOpsOrigins().has(origin)) throw new HttpSecurityError("ORIGIN_REJECTED", 403);
}

export function recordFailedLogin(key: string, now = Date.now()): void {
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + 15 * 60_000 });
    return;
  }
  current.count += 1;
}

export function clearLoginFailures(key: string): void {
  loginAttempts.delete(key);
}

export async function verifyOwnerPassword(candidate: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const expected = requireSecret("OPS_OWNER_PASSWORD", env);
  if (candidate.length < 1 || candidate.length > 256) return false;
  const salt = Buffer.from("company-os-owner-login-v1", "utf8");
  const derive = (value: string) => new Promise<Buffer>((resolve, reject) => {
    scryptCallback(value, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
  const [candidateKey, expectedKey] = await Promise.all([derive(candidate), derive(expected)]);
  return timingSafeEqual(candidateKey, expectedKey);
}

export async function verifyOpsCredentials(
  usernameRaw: string | undefined,
  candidate: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OpsSessionClaims | null> {
  const username = usernameRaw?.trim().toLowerCase() || "owner";
  if (username === "owner") {
    return await verifyOwnerPassword(candidate, env) ? { actorId: "owner", role: "owner" } : null;
  }
  if (!opsOperatorConfigured(env) || username !== env.OPS_OPERATOR_USERNAME?.trim().toLowerCase()) return null;
  const expected = env.OPS_OPERATOR_PASSWORD?.trim() ?? "";
  if (candidate.length < 1 || candidate.length > 256) return null;
  const salt = Buffer.from(`company-os-operator-login-v1:${username}`, "utf8");
  const derive = (value: string) => new Promise<Buffer>((resolve, reject) => {
    scryptCallback(value, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
  const [candidateKey, expectedKey] = await Promise.all([derive(candidate), derive(expected)]);
  return timingSafeEqual(candidateKey, expectedKey) ? { actorId: username, role: "operator" } : null;
}

export function createOpsSession(
  claims: OpsSessionClaims = { actorId: "owner", role: "owner" },
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): {
  token: string;
  csrfToken: string;
  expiresAt: Date;
} {
  if (!actorIdPattern.test(claims.actorId)) throw new HttpSecurityError("OPS_ACTOR_INVALID", 500);
  const expiresAt = new Date(now + SESSION_SECONDS * 1000);
  const payload = `v2.${Math.floor(expiresAt.getTime() / 1000)}.${randomBytes(18).toString("base64url")}.${claims.actorId}.${claims.role}`;
  const signature = createHmac("sha256", requireSecret("OPS_SESSION_SECRET", env)).update(payload).digest("base64url");
  return { token: `${payload}.${signature}`, csrfToken: randomBytes(32).toString("base64url"), expiresAt };
}

export function readOpsSessionClaims(
  token: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): OpsSessionClaims | null {
  if (!token || token.length > 256) return null;
  const parts = token.split(".");
  if (parts.length === 4) {
    const [expires, nonce, signature] = parts;
    if (!expires || !nonce || !signature) return null;
    const expiry = Number(expires);
    if (!Number.isSafeInteger(expiry) || expiry * 1000 <= now) return null;
    const expected = createHmac("sha256", requireSecret("OPS_SESSION_SECRET", env)).update(`${expires}.${nonce}`).digest("base64url");
    const left = Buffer.from(signature);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right)
      ? { actorId: "owner", role: "owner" }
      : null;
  }
  const [version, expires, nonce, actorId, role, signature, extra] = parts;
  if (version !== "v2" || !expires || !nonce || !actorId || !signature || extra) return null;
  if (!actorIdPattern.test(actorId) || (role !== "owner" && role !== "operator")) return null;
  const expiry = Number(expires);
  if (!Number.isSafeInteger(expiry) || expiry * 1000 <= now) return null;
  const payload = `${version}.${expires}.${nonce}.${actorId}.${role}`;
  const expected = createHmac("sha256", requireSecret("OPS_SESSION_SECRET", env)).update(payload).digest("base64url");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right) ? { actorId, role } : null;
}

export function verifyOpsSessionToken(token: string | undefined, env: NodeJS.ProcessEnv = process.env, now = Date.now()): boolean {
  return readOpsSessionClaims(token, env, now) !== null;
}

export function requireOpsSession(request: NextRequest): OpsSessionClaims {
  const claims = readOpsSessionClaims(request.cookies.get(OPS_SESSION_COOKIE)?.value);
  if (!claims) {
    throw new HttpSecurityError("OPS_SESSION_REQUIRED", 401);
  }
  return claims;
}

export function assertOpsMutation(request: NextRequest): OpsSessionClaims {
  const claims = requireOpsSession(request);
  const origin = request.headers.get("origin");
  if (!origin || !allowedOpsOrigins().has(origin)) throw new HttpSecurityError("ORIGIN_REJECTED", 403);
  const cookie = request.cookies.get(OPS_CSRF_COOKIE)?.value ?? "";
  const header = request.headers.get("x-company-os-csrf") ?? "";
  const left = Buffer.from(cookie);
  const right = Buffer.from(header);
  if (left.length < 32 || left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new HttpSecurityError("CSRF_REJECTED", 403);
  }
  return claims;
}

export function assertOwnerMutation(request: NextRequest): OpsSessionClaims {
  const claims = assertOpsMutation(request);
  if (claims.role !== "owner") throw new HttpSecurityError("OWNER_ROLE_REQUIRED", 403);
  return claims;
}

export function requireOwnerSession(request: NextRequest): OpsSessionClaims {
  const claims = requireOpsSession(request);
  if (claims.role !== "owner") throw new HttpSecurityError("OWNER_ROLE_REQUIRED", 403);
  return claims;
}

function allowedOpsOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const origins = new Set<string>([
    new URL(env.APP_URL ?? "http://localhost:3020").origin,
    "http://localhost:3020",
    "http://127.0.0.1:3020",
  ]);
  if (env.OPS_LAN_ENABLED === "true" && env.OPS_LAN_ORIGIN?.trim()) {
    origins.add(new URL(env.OPS_LAN_ORIGIN.trim()).origin);
  }
  return origins;
}

export function setOpsCookies(response: NextResponse, session: ReturnType<typeof createOpsSession>): void {
  // Company OS can run a production Next.js build over plain HTTP on the local
  // machine or LAN. Cookie transport must follow the configured URL, not the
  // build mode, otherwise browsers silently discard the local login cookies.
  const secure = new URL(process.env.APP_URL ?? "http://localhost:3020").protocol === "https:";
  response.cookies.set(OPS_SESSION_COOKIE, session.token, {
    httpOnly: true,
    secure,
    sameSite: "strict",
    path: "/",
    expires: session.expiresAt,
  });
  response.cookies.set(OPS_CSRF_COOKIE, session.csrfToken, {
    httpOnly: false,
    secure,
    sameSite: "strict",
    path: "/",
    expires: session.expiresAt,
  });
}

export function clearOpsCookies(response: NextResponse): void {
  response.cookies.set(OPS_SESSION_COOKIE, "", { httpOnly: true, sameSite: "strict", path: "/", maxAge: 0 });
  response.cookies.set(OPS_CSRF_COOKIE, "", { httpOnly: false, sameSite: "strict", path: "/", maxAge: 0 });
}
