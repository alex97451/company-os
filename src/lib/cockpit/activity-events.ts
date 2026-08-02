import type { OpsEvent } from "@/lib/cockpit/client-contracts";

/**
 * Snapshot refreshes and the live stream can briefly contain the same event.
 * Keep one item per durable UUID so rendered identities stay stable.
 */
export function normalizeActivityEvents(events: readonly OpsEvent[], limit = 20): OpsEvent[] {
  const uniqueEvents = new Map<string, OpsEvent>();

  for (const event of events) {
    uniqueEvents.set(event.id, event);
  }

  return [...uniqueEvents.values()]
    .sort((left, right) => {
      const sequenceOrder = BigInt(right.sequence) - BigInt(left.sequence);
      return sequenceOrder > 0n ? 1 : sequenceOrder < 0n ? -1 : right.id.localeCompare(left.id);
    })
    .slice(0, limit);
}
