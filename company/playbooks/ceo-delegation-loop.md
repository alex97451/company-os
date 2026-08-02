# CEO Delegation Loop

## Purpose

The CEO converts bounded aggregate evidence into a small, deduplicated task queue. It coordinates the company but cannot override release safety, finance, privacy or owner gates.

## Trigger and lease

- Scheduled run: 08:00 UTC daily.
- Event run: material revenue anomaly, funnel break, repeated customer failure, release verdict or SEV incident.
- Acquire a PostgreSQL lease on `(ceo, trigger, company, policy_version)`. If a live lease exists, skip; never run overlapping CEO cycles.
- Maximum output: one owner briefing and five active priorities. Existing unresolved tasks count toward five.

## 1. Build the evidence packet

Read only aggregate/scoped data:

- revenue, payments, refunds and provider cost totals;
- visit → sample → upload → preview → checkout → paid → delivered funnel;
- queue age, delivery latency, purge compliance and incident status;
- QA/release verdicts and unsafe-language counts;
- redacted support themes and experiment outcomes;
- active tasks, dependencies, budgets and prior owner decisions.

Reject the packet if it contains raw customer content, personal data, private file contents, tokens or secrets.

## 2. Rank outcomes

Score candidate outcomes from 0–3 on customer impact, revenue impact, urgency and confidence, then subtract effort and risk. Privacy/safety incidents always outrank growth. Paid-user recovery outranks new acquisition. Do not optimize traffic while delivery, purge, solvency or release gates are unhealthy.

## 3. Dedupe and create tasks

Before creating a task, search open/recent tasks with the same `(owner, trigger, scope, policy_version)`. Merge evidence into the existing task when the desired outcome is unchanged.

Every task must contain:

```yaml
task_id: generated-opaque-id
outcome: measurable customer or company result
owner_agent: one canonical roster id
verifier_agent: a different canonical roster id
evidence_refs: aggregate or redacted references only
scope: explicit allowlisted scope
risk_class: read|draft|write_safe|financial|advertising|production
success_metric: name, baseline, target, measurement window
deadline_utc: timestamp
call_budget: integer
cost_budget_usd_micros: integer
dependencies: []
approval_required: true|false
stop_conditions: []
```

One task has one accountable owner. Cross-functional work is split into dependent tasks with explicit handoffs.

## 4. Authorize and delegate

- Reserve the task's call/cost budget atomically.
- Give the owner only the minimum read/write scopes needed for its artifact.
- Assign a verifier before execution. Engineering is verified by QA; customer claims by QA/Safety; growth/spend proposals by Finance; reliability changes by QA; owner approval remains separate.
- If risk is owner-gated, the agent may prepare the artifact and approval request but must stop before the side effect.

## 5. Execute and verify

The owner produces the named artifact and evidence. The verifier returns `approved`, `changes_required` or `blocked`, tied to the artifact/commit digest. A verifier cannot approve its own work. Failed checks create defects; they are never converted into warnings by the CEO.

## 6. Close, remember and brief

Close only when the success metric is measured or a concrete artifact is verified. Store only the redacted outcome in the permitted memory taxonomy. Release unused budget reservations.

The daily owner brief contains:

1. KPI movement and data freshness.
2. Customer/revenue/reliability risks.
3. Completed verified artifacts.
4. Five or fewer active priorities with owner/verifier/deadline.
5. Approval requests, each with maximum impact, expiry and rollback.
6. Spend: actual, reserved and cap; advertising must show zero unless approved.

## Stop and escalate

Stop the cycle and open an incident when policy configuration is missing, the circuit breaker is open, data freshness is outside its SLA, a privacy/safety/finance blocker exists, task budgets cannot be reserved atomically, or a requested action would exceed the validated product/market boundaries.
