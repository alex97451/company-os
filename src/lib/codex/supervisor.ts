import type { BridgeHealth, CodexDispatchOutbox, CodexTransport, DispatchReceipt } from "./contracts";

export type SupervisorResult =
  | { status: "idle" }
  | { status: "supervisor_halted" }
  | { status: "accepted"; dispatchId: string; receipt: Extract<DispatchReceipt, { status: "accepted" }> }
  | { status: "rejected"; dispatchId: string; receipt: Extract<DispatchReceipt, { status: "rejected" }> }
  | { status: "reconciliation_required"; dispatchId: string }
  | { status: "transport_unavailable"; dispatchId: string };

/**
 * Processes at most one leased record. The caller controls cadence. A fallback
 * is considered only before any send attempt; an uncertain send always stops.
 */
export class CodexDispatchSupervisor {
  private healthState: BridgeHealth = "offline";

  constructor(
    private readonly outbox: CodexDispatchOutbox,
    private readonly primary: CodexTransport,
    private readonly degradedFallback?: CodexTransport,
  ) {}

  health(): BridgeHealth {
    return this.healthState;
  }

  async processOne(ownerId: string, leaseMs = 15_000): Promise<SupervisorResult> {
    if (this.healthState === "reconciliation_required") return { status: "supervisor_halted" };

    const record = await this.outbox.claimNext(ownerId, new Date(Date.now() + leaseMs));
    if (!record) return { status: "idle" };

    const primaryHealth = await safeHealth(this.primary);
    let transport: CodexTransport | undefined = primaryHealth === "connected" ? this.primary : undefined;

    if (!transport && this.degradedFallback) {
      const fallbackHealth = await safeHealth(this.degradedFallback);
      if (fallbackHealth !== "offline") transport = this.degradedFallback;
    }

    if (!transport) {
      this.healthState = "offline";
      await this.outbox.releaseClaim(record.envelope.dispatchId, "transport_unavailable");
      return { status: "transport_unavailable", dispatchId: record.envelope.dispatchId };
    }

    this.healthState = transport === this.primary ? primaryHealth : "degraded";
    let receipt: DispatchReceipt;
    try {
      receipt = await transport.dispatch(record.envelope);
    } catch {
      // Adapters are expected to convert errors, but the supervisor still fails
      // closed if an injected implementation violates that contract.
      receipt = { status: "uncertain", transport: transport.kind, code: "send_outcome_unknown" };
    }
    if (receipt.status === "accepted") {
      try {
        await this.outbox.markAccepted(record.envelope.dispatchId, receipt);
      } catch {
        this.healthState = "reconciliation_required";
        try {
          await this.outbox.markReconciliationRequired(record.envelope.dispatchId, {
            transport: receipt.transport,
            code: "persistence_after_accept_failed",
          });
        } catch {
          // The in-process circuit remains open even if persistence is unavailable.
        }
        return { status: "reconciliation_required", dispatchId: record.envelope.dispatchId };
      }
      return { status: "accepted", dispatchId: record.envelope.dispatchId, receipt };
    }
    if (receipt.status === "rejected") {
      await this.outbox.markRejected(record.envelope.dispatchId, receipt);
      return { status: "rejected", dispatchId: record.envelope.dispatchId, receipt };
    }

    this.healthState = "reconciliation_required";
    await this.outbox.markReconciliationRequired(record.envelope.dispatchId, {
      transport: receipt.transport,
      code: receipt.code,
    });
    return { status: "reconciliation_required", dispatchId: record.envelope.dispatchId };
  }
}

async function safeHealth(transport: CodexTransport): Promise<"connected" | "degraded" | "offline"> {
  try {
    return await transport.health();
  } catch {
    return "offline";
  }
}
