import { describe, expect, it } from "vitest";
import type { OpsEvent } from "@/lib/cockpit/client-contracts";
import { normalizeActivityEvents } from "@/lib/cockpit/activity-events";

const baseEvent: OpsEvent = {
  sequence: "53",
  id: "11111111-1111-4111-8111-111111111111",
  eventType: "owner.command.created",
  aggregateType: "command",
  aggregateId: "22222222-2222-4222-8222-222222222222",
  safePayload: { commandType: "owner.message" },
  occurredAt: "2026-07-29T10:00:00.000Z",
};

describe("normalizeActivityEvents", () => {
  it("deduplicates one durable event received from snapshot and live stream", () => {
    expect(normalizeActivityEvents([baseEvent, { ...baseEvent }])).toEqual([baseEvent]);
  });

  it("keeps distinct events when two sources reuse the same sequence", () => {
    const secondEvent: OpsEvent = {
      ...baseEvent,
      id: "33333333-3333-4333-8333-333333333333",
      aggregateId: "44444444-4444-4444-8444-444444444444",
    };

    const normalized = normalizeActivityEvents([baseEvent, secondEvent]);

    expect(normalized).toHaveLength(2);
    expect(new Set(normalized.map((event) => event.id)).size).toBe(2);
  });

  it("returns the newest unique events first and respects the limit", () => {
    const newerEvent: OpsEvent = {
      ...baseEvent,
      sequence: "54",
      id: "55555555-5555-4555-8555-555555555555",
    };

    expect(normalizeActivityEvents([baseEvent, newerEvent], 1)).toEqual([newerEvent]);
  });
});
