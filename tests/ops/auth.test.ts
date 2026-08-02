import { describe, expect, it } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  assertOpsLoginOrigin,
  createOpsSession,
  opsAuthConfigured,
  readOpsSessionClaims,
  setOpsCookies,
  verifyOpsCredentials,
  verifyOpsSessionToken,
  verifyOwnerPassword,
} from "@/lib/ops/auth";

const env = {
  NODE_ENV: "test",
  OPS_OWNER_PASSWORD: "correct-horse-battery-staple",
  OPS_SESSION_SECRET: "0123456789abcdef0123456789abcdef",
  OPS_LAN_ENABLED: "true",
  OPS_LAN_ORIGIN: "http://192.168.1.25:3020",
  OPS_OPERATOR_USERNAME: "alice",
  OPS_OPERATOR_PASSWORD: "operator-password-strong",
} as NodeJS.ProcessEnv;

describe("owner cockpit authentication", () => {
  it("requires both local secrets", () => {
    expect(opsAuthConfigured({} as NodeJS.ProcessEnv)).toBe(false);
    expect(opsAuthConfigured(env)).toBe(true);
  });

  it("checks the owner password through the slow verifier", async () => {
    await expect(verifyOwnerPassword("correct-horse-battery-staple", env)).resolves.toBe(true);
    await expect(verifyOwnerPassword("wrong-password", env)).resolves.toBe(false);
  });

  it("signs expiring owner sessions", () => {
    const now = Date.UTC(2026, 6, 20, 12);
    const session = createOpsSession({ actorId: "owner", role: "owner" }, env, now);
    expect(verifyOpsSessionToken(session.token, env, now + 1_000)).toBe(true);
    expect(readOpsSessionClaims(session.token, env, now + 1_000)).toEqual({ actorId: "owner", role: "owner" });
    expect(verifyOpsSessionToken(`${session.token}tampered`, env, now + 1_000)).toBe(false);
    expect(verifyOpsSessionToken(session.token, env, session.expiresAt.getTime() + 1)).toBe(false);
  });

  it("authenticates and signs a distinct operator identity", async () => {
    await expect(verifyOpsCredentials("alice", "operator-password-strong", env))
      .resolves.toEqual({ actorId: "alice", role: "operator" });
    const session = createOpsSession({ actorId: "alice", role: "operator" }, env);
    expect(readOpsSessionClaims(session.token, env)).toEqual({ actorId: "alice", role: "operator" });
  });

  it("rejects cross-origin login attempts", () => {
    const original = process.env.APP_URL;
    process.env.APP_URL = "http://localhost:3020";
    expect(() => assertOpsLoginOrigin(new NextRequest("http://localhost:3020/api/ops/auth/login", {
      method: "POST",
      headers: { origin: "https://malicious.example" },
    }))).toThrow("ORIGIN_REJECTED");
    if (original === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = original;
  });

  it("keeps login cookies usable for a local HTTP production build", () => {
    const originalUrl = process.env.APP_URL;
    process.env.APP_URL = "http://localhost:3200";
    try {
      const response = NextResponse.json({ ok: true });
      setOpsCookies(response, createOpsSession({ actorId: "owner", role: "owner" }, env));
      const cookies = response.headers.getSetCookie();
      expect(cookies).toHaveLength(2);
      expect(cookies.every((cookie) => !cookie.includes("; Secure"))).toBe(true);
    } finally {
      if (originalUrl === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = originalUrl;
    }
  });
});
