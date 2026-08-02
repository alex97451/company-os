BEGIN;

CREATE TABLE IF NOT EXISTS cockpit_runtime_health (
  component text PRIMARY KEY CHECK (component IN ('supervisor','bridge','codex')),
  status text NOT NULL CHECK (status IN ('connected','degraded','offline')),
  detail_code text,
  heartbeat_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO cockpit_runtime_health (component, status, detail_code, heartbeat_at) VALUES
  ('supervisor','offline','never_started',to_timestamp(0)),
  ('bridge','offline','never_started',to_timestamp(0)),
  ('codex','offline','never_started',to_timestamp(0))
ON CONFLICT (component) DO NOTHING;

COMMIT;
