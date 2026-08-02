# Owner Approval Templates

Approvals are single-use, expiring and bound to an exact action digest. An approval authorizes only the described side effect; it does not relax QA, safety, privacy, budget or legal gates.

## Common request envelope

```yaml
request_id: opaque-id
requesting_agent: canonical-agent-id
risk_class: financial|advertising|production|contractual|unusual_outbound
policy_version: integer
action_digest_sha256: exact-action-digest
environment: staging|production|external
objective: measurable outcome
artifact_refs: [verified-digest-or-redacted-document]
verifier_verdicts: [verifier, verdict, artifact_digest]
maximum_external_effect: explicit upper bound
estimated_cost_minor: 0
currency: GBP|USD|EUR|null
customer_data_touched: none|redacted|scoped
rollback_or_recovery: concrete procedure
expires_at_utc: timestamp
```

The owner grant adds `approved_by`, `approved_at_utc`, a nonce and optional tighter bounds. Consumption atomically records `used_at_utc`; replay, mutation, expiry or policy-version mismatch is denied.

## Production deployment

Required additions: commit and image digests, migration class, release verdict, safety/privacy verdicts, staging evidence, health metrics, rollback image, observation window and affected services. Destructive migrations require a separate explicit approval.

## Financial action

Required additions: payment/refund identifier, reason code, amount/currency maximum, policy eligibility, reconciliation evidence and customer-impact summary. Never include card/bank details or raw support content.

## Advertising campaign

Required additions: platform, market, creative/landing digests, audience constraints, start/end UTC, daily and total caps, stop-loss metrics, attribution plan and Finance verdict. Until consumed, every ad platform cap remains exactly zero. Approval of one campaign cannot authorize another audience, creative, date or budget.

## Contract or unusual outbound message

Required additions: recipient organization/category, final reviewed text digest, channel, number of recipients, legal/claim review and reply owner. Bulk outreach is never inferred from approval of a single message.

## Exceptional privacy/destructive operation

Required additions: incident ID, exact records/resources, necessity, least-destructive alternative considered, backup/restore point, deletion/rotation verification and two-person verifier. Secrets and customer content remain excluded from the approval artifact.

## Denial template

```yaml
request_id: opaque-id
decision: denied
reason_code: policy|scope|evidence|budget|safety|privacy|timing
required_changes: []
decided_at_utc: timestamp
```

A denial creates no residual authority. Resubmission requires a new request and digest.
