BEGIN;

INSERT INTO cockpit_budgets (
  scope, period_start, period_end,
  external_spend_limit_usd_micros,
  external_spend_reserved_usd_micros,
  external_spend_actual_usd_micros,
  model_usage_limit_usd_micros,
  usage_provenance
)
VALUES (
  'company:model:daily',
  date_trunc('day', now()),
  date_trunc('day', now()) + interval '1 day',
  0, 0, 0, 5000000, 'estimated'
)
ON CONFLICT (scope, period_start, period_end) DO NOTHING;

COMMIT;
