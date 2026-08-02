BEGIN;

CREATE TABLE cockpit_agents (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  role text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (id IN ('ceo','product','design_conversion','engineering','qa_safety','growth','content_brand','video_creator','sales_partnerships','customer_care','finance_risk','reliability_privacy'))
);

INSERT INTO cockpit_agents (id, display_name, role) VALUES
  ('ceo','CEO / General Manager','ceo'),
  ('product','Product Manager','specialist'),
  ('design_conversion','Design & Conversion','specialist'),
  ('engineering','CTO / Engineering','specialist'),
  ('qa_safety','QA & Report Safety','verifier'),
  ('growth','Growth & Marketing','specialist'),
  ('content_brand','Content & Brand','specialist'),
  ('video_creator','Short-form Video Creator','specialist'),
  ('sales_partnerships','Sales & Partnerships','specialist'),
  ('customer_care','Customer Care','specialist'),
  ('finance_risk','Finance & Revenue Risk','verifier'),
  ('reliability_privacy','Reliability, Security & Privacy','verifier');

CREATE TABLE cockpit_agent_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL REFERENCES cockpit_agents(id) ON DELETE RESTRICT,
  thread_id text NOT NULL UNIQUE,
  transport text NOT NULL CHECK (transport IN ('app_server','exec_resume')),
  protocol_version text NOT NULL,
  state text NOT NULL DEFAULT 'offline' CHECK (state IN ('offline','waiting','working','action_required','problem','paused','uncertain')),
  heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  UNIQUE (agent_id, id)
);
CREATE UNIQUE INDEX cockpit_one_live_instance_per_agent_idx
  ON cockpit_agent_instances(agent_id) WHERE retired_at IS NULL;

CREATE TABLE cockpit_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  target_agent_id text NOT NULL DEFAULT 'ceo' REFERENCES cockpit_agents(id) ON DELETE RESTRICT CHECK (target_agent_id = 'ceo'),
  expected_aggregate_version integer NOT NULL CHECK (expected_aggregate_version >= 0),
  command_type text NOT NULL,
  safe_payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(safe_payload::text) <= 16384),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','dispatched','acknowledged','completed','rejected','expired','reconciliation_required')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  completed_at timestamptz,
  remote_thread_id text,
  remote_turn_id text,
  CHECK (expires_at > created_at)
);
CREATE INDEX cockpit_commands_pending_idx ON cockpit_commands(created_at) WHERE state = 'pending';
CREATE UNIQUE INDEX cockpit_command_remote_turn_idx
  ON cockpit_commands(remote_turn_id) WHERE remote_turn_id IS NOT NULL;

CREATE TABLE cockpit_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender text NOT NULL CHECK (sender IN ('owner','ceo')),
  command_id uuid NOT NULL REFERENCES cockpit_commands(id) ON DELETE CASCADE,
  safe_body text NOT NULL CHECK (octet_length(safe_body) BETWEEN 1 AND 16384),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','dispatched','completed','failed','reconciliation_required','demo')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  CHECK (expires_at <= created_at + interval '30 days')
);
CREATE INDEX cockpit_messages_recent_idx ON cockpit_messages(created_at DESC);
CREATE INDEX cockpit_messages_expiry_idx ON cockpit_messages(expires_at);
CREATE UNIQUE INDEX cockpit_one_ceo_message_per_command_idx
  ON cockpit_messages(command_id) WHERE sender = 'ceo';

CREATE TABLE cockpit_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_task_id uuid REFERENCES cockpit_tasks(id) ON DELETE SET NULL,
  source_command_id uuid REFERENCES cockpit_commands(id) ON DELETE SET NULL,
  assigned_agent_id text NOT NULL REFERENCES cockpit_agents(id) ON DELETE RESTRICT,
  verifier_agent_id text REFERENCES cockpit_agents(id) ON DELETE RESTRICT,
  title text NOT NULL,
  intended_outcome text NOT NULL,
  risk_class text NOT NULL CHECK (risk_class IN ('read','draft','write_safe','financial','advertising','production')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','working','action_required','verification','done','problem','paused')),
  aggregate_version integer NOT NULL DEFAULT 0 CHECK (aggregate_version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (verifier_agent_id IS NULL OR verifier_agent_id <> assigned_agent_id)
);
CREATE INDEX cockpit_tasks_status_updated_idx ON cockpit_tasks(status, updated_at DESC);

CREATE TABLE cockpit_model_allowlist (
  profile text NOT NULL CHECK (profile IN ('rapid','balanced','expert','critical')),
  model text NOT NULL,
  reasoning_effort text NOT NULL CHECK (reasoning_effort IN ('low','medium','high','xhigh','max','ultra')),
  enabled boolean NOT NULL DEFAULT true,
  priority smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile, model, reasoning_effort)
);

INSERT INTO cockpit_model_allowlist (profile, model, reasoning_effort) VALUES
  ('rapid','gpt-5.6-terra','low'),
  ('balanced','gpt-5.6-terra','medium'),
  ('expert','gpt-5.6-sol','high'),
  ('critical','gpt-5.6-sol','xhigh');

CREATE TABLE cockpit_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES cockpit_tasks(id) ON DELETE CASCADE,
  agent_instance_id uuid NOT NULL REFERENCES cockpit_agent_instances(id) ON DELETE RESTRICT,
  transport text NOT NULL CHECK (transport IN ('app_server','exec_resume')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','dispatching','working','verification','completed','failed','blocked','interruption_requested','reconciliation_required','orphaned')),
  router_version text NOT NULL,
  model_profile text NOT NULL CHECK (model_profile IN ('rapid','balanced','expert','critical')),
  selected_model text NOT NULL,
  reasoning_effort text NOT NULL CHECK (reasoning_effort IN ('low','medium','high','xhigh','max','ultra')),
  routing_score integer NOT NULL,
  routing_factors jsonb NOT NULL CHECK (octet_length(routing_factors::text) <= 4096),
  routing_overridden boolean NOT NULL DEFAULT false,
  fallback_reason text,
  requires_distinct_verifier boolean NOT NULL DEFAULT false,
  codex_thread_id text,
  codex_turn_id text,
  lease_owner text,
  lease_expires_at timestamptz,
  estimated_cost_usd_micros bigint NOT NULL DEFAULT 0 CHECK (estimated_cost_usd_micros >= 0),
  actual_cost_usd_micros bigint CHECK (actual_cost_usd_micros >= 0),
  usage_provenance text CHECK (usage_provenance IN ('measured','estimated')),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);
CREATE UNIQUE INDEX cockpit_one_unfinished_run_per_task_idx
  ON cockpit_runs(task_id) WHERE state IN ('queued','dispatching','working','verification','interruption_requested','reconciliation_required','orphaned');
CREATE UNIQUE INDEX cockpit_turn_correlation_idx
  ON cockpit_runs(codex_thread_id, codex_turn_id) WHERE codex_turn_id IS NOT NULL;

CREATE TABLE cockpit_events (
  sequence bigserial PRIMARY KEY,
  id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  event_type text NOT NULL,
  aggregate_type text NOT NULL CHECK (aggregate_type IN ('agent','command','task','run','approval','budget','pause','system')),
  aggregate_id text NOT NULL,
  safe_payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(safe_payload::text) <= 16384),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  CHECK (expires_at <= occurred_at + interval '30 days')
);
CREATE INDEX cockpit_events_expiry_idx ON cockpit_events(expires_at);
CREATE INDEX cockpit_events_aggregate_idx ON cockpit_events(aggregate_type, aggregate_id, sequence DESC);

CREATE TABLE cockpit_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES cockpit_tasks(id) ON DELETE CASCADE,
  requested_by_agent_id text NOT NULL REFERENCES cockpit_agents(id) ON DELETE RESTRICT,
  canonical_action jsonb NOT NULL CHECK (octet_length(canonical_action::text) <= 16384),
  owner_explanation jsonb NOT NULL CHECK (octet_length(owner_explanation::text) <= 4096),
  action_digest char(64) NOT NULL,
  policy_version integer NOT NULL CHECK (policy_version > 0),
  action_version integer NOT NULL CHECK (action_version > 0),
  risk_class text NOT NULL CHECK (risk_class IN ('financial','advertising','production')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','refused','expired','consumed')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  consumed_at timestamptz,
  UNIQUE (requested_by_agent_id, action_digest, policy_version, action_version),
  CHECK (expires_at > created_at)
);
CREATE INDEX cockpit_approvals_pending_idx ON cockpit_approvals(created_at) WHERE state = 'pending';

CREATE TABLE cockpit_budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  external_spend_limit_usd_micros bigint NOT NULL DEFAULT 0 CHECK (external_spend_limit_usd_micros >= 0),
  external_spend_reserved_usd_micros bigint NOT NULL DEFAULT 0 CHECK (external_spend_reserved_usd_micros >= 0),
  external_spend_actual_usd_micros bigint NOT NULL DEFAULT 0 CHECK (external_spend_actual_usd_micros >= 0),
  model_usage_limit_usd_micros bigint NOT NULL CHECK (model_usage_limit_usd_micros >= 0),
  model_usage_reserved_usd_micros bigint NOT NULL DEFAULT 0 CHECK (model_usage_reserved_usd_micros >= 0),
  model_usage_actual_usd_micros bigint NOT NULL DEFAULT 0 CHECK (model_usage_actual_usd_micros >= 0),
  usage_provenance text NOT NULL DEFAULT 'estimated' CHECK (usage_provenance IN ('measured','estimated')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope, period_start, period_end),
  CHECK (period_end > period_start),
  CHECK (external_spend_reserved_usd_micros + external_spend_actual_usd_micros <= external_spend_limit_usd_micros),
  CHECK (model_usage_reserved_usd_micros + model_usage_actual_usd_micros <= model_usage_limit_usd_micros)
);

CREATE TABLE cockpit_pause (
  id smallint PRIMARY KEY CHECK (id = 1),
  state text NOT NULL CHECK (state IN ('running','pause_active','interruption_requested','work_still_active','confirmed_stopped')),
  reason text,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  changed_by text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO cockpit_pause (id, state, changed_by) VALUES (1, 'running', 'migration');

CREATE TABLE cockpit_outbox (
  id bigserial PRIMARY KEY,
  command_id uuid REFERENCES cockpit_commands(id) ON DELETE CASCADE,
  run_id uuid REFERENCES cockpit_runs(id) ON DELETE CASCADE,
  destination text NOT NULL,
  safe_payload jsonb NOT NULL CHECK (octet_length(safe_payload::text) <= 16384),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','sent','failed','reconciliation_required')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CHECK (command_id IS NOT NULL OR run_id IS NOT NULL)
);
CREATE INDEX cockpit_outbox_pending_idx ON cockpit_outbox(available_at, id) WHERE state = 'pending';

COMMIT;
