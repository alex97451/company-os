import { describe, expect, it } from "vitest";
import {
  digestAgentAction,
  evaluateAgentAction,
  type AgentActionRequest,
  type AgentApproval
} from "@/lib/agents/policy";

function request(overrides: Partial<AgentActionRequest> = {}): AgentActionRequest {
  return {
    agentId: "engineering",
    runId: "run-synthetic-001",
    tool: "repo.read",
    scope: "repo:project",
    riskClass: "read",
    policyVersion: 1,
    actionDigest: "digest-synthetic-001",
    estimatedCostUsdMicros: 0,
    ...overrides
  };
}

function approval(forRequest: AgentActionRequest, overrides: Partial<AgentApproval> = {}): AgentApproval {
  return {
    id: "approval-synthetic-001",
    agentId: forRequest.agentId,
    actionDigest: forRequest.actionDigest,
    riskClass: forRequest.riskClass,
    policyVersion: forRequest.policyVersion,
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    usedAt: null,
    ...overrides
  };
}

describe("autonomous company policy gateway", () => {
  it("allows a bounded in-scope read", () => {
    expect(evaluateAgentAction(request())).toMatchObject({ allowed: true, code: "ALLOW" });
  });

  it("denies by default when no active agent policy exists", () => {
    expect(evaluateAgentAction(request(), { agent: null })).toMatchObject({ allowed: false, code: "DENY_UNKNOWN_AGENT" });
  });

  it("denies a scope matching a configured forbidden root", () => {
    expect(evaluateAgentAction(
      request({ scope: "repo:C:\\CompanyProjects\\restricted" }),
      { forbiddenScopeMarkers: ["C:\\CompanyProjects\\restricted"] },
    ))
      .toMatchObject({ allowed: false, code: "DENY_SCOPE" });
  });

  it("denies tools, scopes and risks outside the role allowlist", () => {
    expect(evaluateAgentAction(request({ tool: "payment.move" })).code).toBe("DENY_TOOL");
    expect(evaluateAgentAction(request({ scope: "payments:raw" })).code).toBe("DENY_SCOPE");
    expect(evaluateAgentAction(request({ riskClass: "financial" })).code).toBe("DENY_RISK");
  });

  it("stops all side effects when the global circuit breaker is open", () => {
    expect(evaluateAgentAction(request(), { circuitBreaker: { state: "open", reason: "synthetic incident" } }))
      .toMatchObject({ allowed: false, code: "DENY_CIRCUIT_OPEN" });
  });

  it("enforces run, day and cost ceilings before execution", () => {
    expect(evaluateAgentAction(request(), { usage: { runCalls: 20, dayCalls: 20, dayCostUsdMicros: 0 } }).code)
      .toBe("DENY_RUN_BUDGET");
    expect(evaluateAgentAction(request(), { usage: { runCalls: 0, dayCalls: 40, dayCostUsdMicros: 0 } }).code)
      .toBe("DENY_DAY_BUDGET");
    expect(evaluateAgentAction(request({ estimatedCostUsdMicros: 1 }), {
      usage: { runCalls: 0, dayCalls: 0, dayCostUsdMicros: 2_000_000 }
    }).code).toBe("DENY_COST_BUDGET");
  });

  it("requires an exact unexpired single-use approval for production", () => {
    const production = request({
      tool: "staging.deploy",
      scope: "staging:web",
      riskClass: "production",
      actionDigest: "digest-release-001"
    });
    expect(evaluateAgentAction(production)).toMatchObject({
      allowed: false,
      code: "DENY_APPROVAL_REQUIRED",
      requiresApproval: true
    });
    expect(evaluateAgentAction({ ...production, approval: approval(production) }, { now: new Date("2029-01-01T00:00:00.000Z") }))
      .toMatchObject({ allowed: true, code: "ALLOW" });
    expect(evaluateAgentAction({
      ...production,
      approval: approval(production, { usedAt: new Date("2028-01-01T00:00:00.000Z") })
    })).toMatchObject({ allowed: false, code: "DENY_APPROVAL_REPLAY" });
    expect(evaluateAgentAction({
      ...production,
      approval: approval(production, { actionDigest: "different-digest" })
    })).toMatchObject({ allowed: false, code: "DENY_APPROVAL_INVALID" });
  });

  it("creates a stable digest that changes with the bounded action", () => {
    const action = request();
    const base = {
      agentId: action.agentId,
      runId: action.runId,
      tool: action.tool,
      scope: action.scope,
      riskClass: action.riskClass,
      policyVersion: action.policyVersion,
      estimatedCostUsdMicros: action.estimatedCostUsdMicros,
      callCount: action.callCount
    };
    const digest = digestAgentAction(base);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digestAgentAction({ ...base, scope: "repo:project:src" })).not.toBe(digest);
  });
});
