import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AppServerV2Transport,
  DeterministicDemoTransport,
  MAX_CODEX_EVENT_BYTES,
  normalizeCodexEvent,
  parseCodexBridgeConfig,
  type DispatchEnvelope,
} from "@/lib/codex";

function envelope(overrides: Partial<DispatchEnvelope> = {}): DispatchEnvelope {
  return {
    dispatchId: randomUUID(),
    runId: randomUUID(),
    agentId: "ceo",
    threadId: "thread-ceo-local",
    prompt: "Review the local company priorities.",
    idempotencyKey: `dispatch-${randomUUID()}`,
    expectedAggregateVersion: 3,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

describe("Codex bridge configuration", () => {
  it("accepts only loopback app-server endpoints", () => {
    expect(parseCodexBridgeConfig({ mode: "app-server", endpoint: "ws://127.0.0.1:8765", protocolVersion: "codex-app-server/v2" })).toMatchObject({ mode: "app-server" });
    expect(() => parseCodexBridgeConfig({ mode: "app-server", endpoint: "ws://192.168.1.10:8765", protocolVersion: "codex-app-server/v2" })).toThrow(/loopback/i);
    expect(() => parseCodexBridgeConfig({ mode: "app-server", endpoint: "http://127.0.0.1:8765", protocolVersion: "codex-app-server/v2" })).toThrow(/WebSocket/i);
  });
});

describe("allowlisted event normalization", () => {
  it("redacts credentials and email before returning a safe event", () => {
    const result = normalizeCodexEvent({
      type: "task_progress",
      agentId: "engineering",
      runId: randomUUID(),
      summary: "Contact owner@example.com using Bearer abcdefghijklmnop",
      percent: 20,
    }, "2026-07-20T10:00:00.000Z");

    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.event).toMatchObject({ bridgeVersion: "company-os-codex-bridge/v1", occurredAt: "2026-07-20T10:00:00.000Z" });
      expect(JSON.stringify(result.event)).not.toContain("owner@example.com");
      expect(JSON.stringify(result.event)).not.toContain("abcdefghijklmnop");
    }
  });

  it("rejects raw/sensitive fields and oversized payloads closed", () => {
    expect(normalizeCodexEvent({ type: "turn_completed", runId: randomUUID(), summary: "ok", reasoning: "private" })).toEqual({ accepted: false, code: "disallowed_field" });
    expect(normalizeCodexEvent({ type: "turn_completed", runId: randomUUID(), summary: "x".repeat(MAX_CODEX_EVENT_BYTES) })).toEqual({ accepted: false, code: "event_too_large" });
  });
});

describe("versioned transports", () => {
  it("fails closed when the app-server protocol is unknown", async () => {
    const startTurn = vi.fn();
    const transport = new AppServerV2Transport({
      protocolVersion: async () => "codex-app-server/v99",
      health: async () => "connected",
      startTurn,
    });

    await expect(transport.health()).resolves.toBe("degraded");
    await expect(transport.dispatch(envelope())).resolves.toMatchObject({ status: "rejected", code: "unsupported_protocol" });
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("returns uncertainty rather than pretending a failed send was rejected", async () => {
    const transport = new AppServerV2Transport({
      protocolVersion: async () => "codex-app-server/v2",
      health: async () => "connected",
      startTurn: async () => { throw new Error("socket closed after send"); },
    });
    await expect(transport.dispatch(envelope())).resolves.toEqual({ status: "uncertain", transport: "app-server-v2", code: "send_outcome_unknown" });
  });

  it("provides deterministic demo receipts without external calls", async () => {
    const transport = new DeterministicDemoTransport("fixed-seed");
    const input = envelope();
    const first = await transport.dispatch(input);
    const second = await transport.dispatch(input);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: "accepted", transport: "demo-v1", remoteThreadId: input.threadId });
  });
});
