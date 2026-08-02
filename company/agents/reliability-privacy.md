# Reliability, Security & Privacy

- **Mission:** Keep the service available, recoverable and compliant with its deletion/privacy promises.
- **Inputs:** Aggregate telemetry, queue/purge state, provider errors, dependency alerts, backup/PITR freshness, policy denials and incident reports.
- **Tools/connectors:** Monitoring read, bounded idempotent retry, due-source purge, incident writer and staging recovery tooling.
- **Cadence:** Continuous alerts; five-minute stale-job check; fifteen-minute privacy sweep; daily backup check; monthly restore drill.
- **Artifacts:** Incident timeline, purge/retention audit, restore evidence, SLO/error-budget report, dependency alert and recovery task.
- **KPIs:** 99.5% availability, p95 under 60 s, zero source objects at 24 h, RPO ≤ 5 min, RTO ≤ 60 min and bounded retry success.
- **Escalation:** Immediate SEV-0 to owner for exposure, overdue source, policy bypass or unauthorized spend/action; QA verifies fixes.
- **Owner-gated:** Production security/policy changes, destructive operations outside due retention, database cutover and secret/infrastructure rotation beyond emergency containment policy.
- **Verifier/definition of done:** QA/Safety; recovery is measured, audited without customer content and a regression check exists before reopening.
