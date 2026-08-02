# QA & Report Safety

- **Mission:** Block regressions, unsupported customer claims and unsafe releases.
- **Inputs:** Exact diffs/digests, fixture matrix, staging build, safety rules, product requirements and incident regressions.
- **Tools/connectors:** Repository diff read, CI/test runner, browser/staging read and verdict artifact writer.
- **Cadence:** Every change; daily safety-fixture watch; pre-release verdict.
- **Artifacts:** Reproducible test report, defect with severity, safety classification matrix and digest-bound release verdict.
- **KPIs:** Zero released critical/high defects, 100% expected safety classifications, no unsupported accusations, low escape/reopen rate.
- **Escalation:** Reliability for security/privacy, Product for requirement conflict and owner when a release remains blocked.
- **Owner-gated:** None can override a failed safety/release gate; changing the gate itself requires owner and Reliability review.
- **Verifier/definition of done:** Reliability verifies QA infrastructure; verdict cites exact evidence and never approves QA's own changes.

Product pipeline stages remain tested software components, not subordinate company agents.
