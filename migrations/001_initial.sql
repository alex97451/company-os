BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE company_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_agent text NOT NULL,
  verifier_agent text,
  trigger text NOT NULL,
  scope text NOT NULL,
  outcome_metric text NOT NULL,
  risk_class text NOT NULL CHECK (risk_class IN ('read','draft','write_safe','financial','advertising','production')),
  policy_version integer NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','active','verification','blocked','completed','failed')),
  dedupe_key char(64) NOT NULL,
  due_at timestamptz,
  artifact_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_agent, trigger, scope, policy_version, dedupe_key)
);

CREATE TABLE company_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL,
  schema_version integer NOT NULL,
  memory_type text NOT NULL CHECK (memory_type IN ('decision','experiment','aggregate_kpi','incident','approved_fact','retrospective')),
  payload jsonb NOT NULL,
  verification_state text NOT NULL DEFAULT 'quarantined' CHECK (verification_state IN ('quarantined','verified','rejected')),
  policy_version integer NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX company_memory_expiry_idx ON company_memory(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL,
  trigger text NOT NULL,
  scope text NOT NULL,
  policy_version integer NOT NULL,
  calls integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','completed','failed','blocked')),
  lease_owner text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE UNIQUE INDEX agent_runs_active_lease_idx ON agent_runs(agent_id, trigger, scope, policy_version) WHERE state = 'active';

CREATE TABLE agent_daily_usage (
  usage_date date NOT NULL,
  agent_id text NOT NULL,
  calls integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
  reserved_cost_usd_micros bigint NOT NULL DEFAULT 0 CHECK (reserved_cost_usd_micros >= 0),
  actual_cost_usd_micros bigint NOT NULL DEFAULT 0 CHECK (actual_cost_usd_micros >= 0),
  PRIMARY KEY (usage_date, agent_id)
);

CREATE TABLE agent_policies (
  agent_id text NOT NULL,
  policy_version integer NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  allowed_tools text[] NOT NULL DEFAULT '{}',
  allowed_scopes text[] NOT NULL DEFAULT '{}',
  allowed_risks text[] NOT NULL DEFAULT '{}',
  max_calls_per_run integer NOT NULL DEFAULT 0 CHECK (max_calls_per_run >= 0),
  max_calls_per_day integer NOT NULL DEFAULT 0 CHECK (max_calls_per_day >= 0),
  max_cost_usd_micros_per_day bigint NOT NULL DEFAULT 0 CHECK (max_cost_usd_micros_per_day >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, policy_version)
);

INSERT INTO agent_policies
  (agent_id, policy_version, enabled, allowed_tools, allowed_scopes, allowed_risks, max_calls_per_run, max_calls_per_day, max_cost_usd_micros_per_day)
VALUES
  ('ceo',1,true,ARRAY['kpi.read','task.create','briefing.write'],ARRAY['analytics:aggregate','tasks:scoped','memory:redacted'],ARRAY['read','draft'],10,20,500000),
  ('product',1,true,ARRAY['analytics.read','support.trends.read','backlog.write'],ARRAY['analytics:aggregate','support:aggregate','tasks:product'],ARRAY['read','draft'],10,20,500000),
  ('design_conversion',1,true,ARRAY['ui.read','analytics.read','artifact.write','staging.preview'],ARRAY['repo:project:ui','analytics:aggregate','artifacts:design','staging:web'],ARRAY['read','draft','write_safe'],10,20,750000),
  ('engineering',1,true,ARRAY['repo.read','repo.branch.write','tests.run','staging.deploy'],ARRAY['repo:project','staging:web','staging:worker'],ARRAY['read','draft','write_safe','production'],20,40,2000000),
  ('qa_safety',1,true,ARRAY['repo.diff.read','tests.run','staging.read','verdict.write'],ARRAY['repo:project','staging:web','fixtures:redacted','artifacts:verdict'],ARRAY['read','draft','write_safe'],20,30,500000),
  ('growth',1,true,ARRAY['analytics.read','research.public','creative.write','experiment.write','ads.manage'],ARRAY['analytics:aggregate','research:public','artifacts:growth','ads:bounded'],ARRAY['read','draft','advertising'],10,20,1000000),
  ('content_brand',1,true,ARRAY['product_facts.read','content.write','localization.check'],ARRAY['facts:approved','artifacts:content','locales:en-fr'],ARRAY['read','draft'],10,20,750000),
  ('video_creator',1,true,ARRAY['product_facts.read','content.read','brand_assets.read','video.brief.write','video.render.local'],ARRAY['facts:approved','artifacts:content','assets:licensed','artifacts:video','render:local'],ARRAY['read','draft','write_safe'],12,20,1000000),
  ('sales_partnerships',1,true,ARRAY['research.public','outreach.draft','crm.note.write','outreach.send'],ARRAY['research:public','artifacts:sales','crm:prospects','outreach:bounded'],ARRAY['read','draft','write_safe'],10,20,500000),
  ('customer_care',1,true,ARRAY['case.read','faq.read','reply.template.send','recovery.create','refund.issue'],ARRAY['support:assigned','faq:approved','recovery:bounded','payments:bounded'],ARRAY['read','draft','write_safe','financial'],10,20,500000),
  ('finance_risk',1,true,ARRAY['payments.aggregate.read','costs.read','analytics.read','alert.write','payment.move'],ARRAY['payments:aggregate','costs:aggregate','analytics:aggregate','artifacts:finance','payments:bounded'],ARRAY['read','draft','financial'],10,20,250000),
  ('reliability_privacy',1,true,ARRAY['telemetry.read','job.retry','purge.run','incident.write','production.change'],ARRAY['telemetry:aggregate','jobs:failed','storage:expired','artifacts:incident','production:bounded'],ARRAY['read','draft','write_safe','production'],10,20,250000);

CREATE TABLE agent_circuit_breaker (
  id smallint PRIMARY KEY CHECK (id = 1),
  state text NOT NULL CHECK (state IN ('closed','open')),
  reason text,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by text NOT NULL
);
INSERT INTO agent_circuit_breaker (id, state, changed_by) VALUES (1, 'closed', 'migration');

CREATE TABLE agent_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL,
  action_digest char(64) NOT NULL,
  risk_class text NOT NULL CHECK (risk_class IN ('financial','advertising','production')),
  policy_version integer NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, action_digest, policy_version)
);

CREATE TABLE agent_action_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  tool text NOT NULL,
  scope text NOT NULL,
  risk_class text NOT NULL,
  action_digest char(64) NOT NULL,
  policy_version integer NOT NULL,
  estimated_cost_usd_micros bigint NOT NULL CHECK (estimated_cost_usd_micros >= 0),
  actual_cost_usd_micros bigint CHECK (actual_cost_usd_micros >= 0),
  status text NOT NULL CHECK (status IN ('reserved','succeeded','failed','expired')),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (agent_id, action_digest, policy_version)
);

CREATE TABLE agent_schedules (
  agent_id text NOT NULL,
  trigger text NOT NULL,
  scope text NOT NULL,
  cron_utc text NOT NULL,
  policy_version integer NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, trigger, scope, policy_version)
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  actor_type text NOT NULL CHECK (actor_type IN ('system','customer','owner','agent','provider')),
  actor_id text,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  outcome text NOT NULL,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_target_idx ON audit_log(target_type, target_id, created_at DESC);

COMMIT;
