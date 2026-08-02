# Company Memory Taxonomy

Company memory is a redacted operating ledger, not a customer-data lake and not a substitute for the product database.

## Allowed memory classes

| Class | Examples | Default retention | Required verifier |
|---|---|---:|---|
| `decision` | Approved architecture, price or policy decision | Until superseded; annual review | Relevant domain owner |
| `approved_fact` | Product capability or reviewed claim copy | Until source changes | QA/Safety |
| `aggregate_kpi` | Conversion, revenue, latency, refund rate | 13 months | Finance or Reliability |
| `experiment` | Hypothesis, variant, aggregate result, decision | 13 months | Product + verifier |
| `incident` | Timeline, aggregate impact, root cause, actions | 24 months | Reliability/QA |
| `task_retrospective` | Outcome, cost, failure mode, reusable lesson | 30 days; aggregate thereafter | Task verifier |
| `support_theme` | Redacted issue category and count | 30 days; aggregate thereafter | Customer Care/QA |
| `policy` | Versioned scopes, limits and owner approvals | Audit/legal policy | Reliability |

## Required record envelope

```yaml
memory_id: opaque-id
class: one_allowed_class
scope: explicit-company-scope
subject: short non-personal label
summary: redacted factual statement
evidence_refs: [aggregate-id-or-reviewed-artifact]
confidence: 0.0-1.0
status: quarantined|verified|superseded|expired
owner_agent: canonical-agent-id
verifier_agent: canonical-agent-id
policy_version: integer
created_at_utc: timestamp
verified_at_utc: timestamp-or-null
expires_at_utc: timestamp-or-null
supersedes: memory-id-or-null
redaction_version: integer
```

New learning enters `quarantined` and cannot guide an external side effect until independently verified. Conflicting records remain visible; the newer verified record links through `supersedes` instead of silently rewriting history.

## Never store

- Original uploads, raw or extracted customer content, private excerpts or screenshots.
- Customer/vendor names, emails, phone numbers, addresses or free-form support messages.
- Session/report tokens, presigned URLs, API keys, cookies or credentials.
- Raw prompts/responses containing customer material.
- Payment-card or bank data.
- Unverified accusations, legal conclusions or inferred sensitive attributes.

## Scope and recall

- CEO: verified aggregate KPI, decisions, incidents and task outcomes.
- Product/Growth/Finance: aggregate funnels and verified experiments only.
- Engineering/QA/Reliability: repository artifact IDs, test verdicts, incidents and policy versions; no source documents.
- Content/Sales/Care: approved facts/templates and redacted themes; no raw correspondence.

Recall queries are audited and scope-filtered. Exporting or widening memory scope is a production/privacy action requiring approval. A deletion or supersession event invalidates derived summaries at the next memory sweep.

## Maintenance

- Daily: expire task facts/support themes and quarantine unverifiable learning.
- Weekly: deduplicate equivalent verified memories and check source freshness.
- Monthly: sample redaction quality and prove expired records are absent.
- On incident: freeze only relevant audit metadata; never preserve prohibited customer content “for debugging.”
