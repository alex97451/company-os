BEGIN;

CREATE TABLE IF NOT EXISTS company_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id text NOT NULL REFERENCES company_projects(id) ON DELETE RESTRICT,
  mode text NOT NULL CHECK (mode IN ('global', 'targeted')),
  mission text NOT NULL CHECK (char_length(mission) BETWEEN 3 AND 2000),
  expected_outcome text CHECK (expected_outcome IS NULL OR char_length(expected_outcome) BETWEEN 1 AND 2000),
  owner_focus text CHECK (owner_focus IS NULL OR char_length(owner_focus) BETWEEN 1 AND 1000),
  state text NOT NULL DEFAULT 'starting'
    CHECK (state IN (
      'starting', 'council', 'planning', 'executing', 'waiting_approval',
      'verifying', 'blocked', 'completed', 'paused', 'stopping', 'stopped', 'failed'
    )),
  resume_state text CHECK (resume_state IS NULL OR resume_state IN ('council', 'planning', 'executing', 'verifying', 'blocked')),
  stage text NOT NULL DEFAULT 'round_1'
    CHECK (stage IN ('round_1', 'ceo_synthesis', 'round_2', 'ceo_decision', 'execution', 'final_report')),
  aggregate_version integer NOT NULL DEFAULT 0 CHECK (aggregate_version >= 0),
  fencing_token bigint NOT NULL DEFAULT 1 CHECK (fencing_token > 0),
  stop_requested boolean NOT NULL DEFAULT false,
  max_tasks smallint NOT NULL DEFAULT 5 CHECK (max_tasks BETWEEN 1 AND 5),
  max_duration_minutes smallint NOT NULL DEFAULT 90 CHECK (max_duration_minutes BETWEEN 5 AND 90),
  external_spend_cap_usd_micros bigint NOT NULL DEFAULT 0 CHECK (external_spend_cap_usd_micros = 0),
  final_report text CHECK (final_report IS NULL OR octet_length(final_report) <= 16384),
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9_.-]{1,100}$'),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS company_one_active_session_per_project_idx
  ON company_sessions(project_id)
  WHERE state IN ('starting','council','planning','executing','waiting_approval','verifying','blocked','paused','stopping');

CREATE TABLE IF NOT EXISTS company_session_participants (
  session_id uuid NOT NULL REFERENCES company_sessions(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES cockpit_agents(id) ON DELETE RESTRICT,
  invitation_order smallint NOT NULL CHECK (invitation_order BETWEEN 0 AND 9),
  status text NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited','working','contributed','blocked','skipped')),
  PRIMARY KEY (session_id, agent_id),
  UNIQUE (session_id, invitation_order)
);

CREATE TABLE IF NOT EXISTS company_session_contributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES company_sessions(id) ON DELETE CASCADE,
  round smallint NOT NULL CHECK (round BETWEEN 1 AND 2),
  contribution_kind text NOT NULL
    CHECK (contribution_kind IN ('proposal','objection','ceo_synthesis','ceo_decision')),
  author_agent_id text NOT NULL REFERENCES cockpit_agents(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','working','completed','failed','blocked','cancelled')),
  task_id uuid UNIQUE REFERENCES cockpit_tasks(id) ON DELETE SET NULL,
  run_id uuid UNIQUE REFERENCES cockpit_runs(id) ON DELETE SET NULL,
  safe_body text CHECK (safe_body IS NULL OR octet_length(safe_body) <= 8192),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS company_session_contributions_progress_idx
  ON company_session_contributions(session_id, round, contribution_kind, status);

CREATE TABLE IF NOT EXISTS company_session_execution_tasks (
  session_id uuid NOT NULL REFERENCES company_sessions(id) ON DELETE CASCADE,
  task_id uuid NOT NULL UNIQUE REFERENCES cockpit_tasks(id) ON DELETE RESTRICT,
  expected_deliverable text NOT NULL CHECK (char_length(expected_deliverable) BETWEEN 1 AND 1000),
  PRIMARY KEY (session_id, task_id)
);

CREATE TABLE IF NOT EXISTS company_session_deliverables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES company_sessions(id) ON DELETE CASCADE,
  task_id uuid REFERENCES cockpit_tasks(id) ON DELETE SET NULL,
  producer_agent_id text NOT NULL REFERENCES cockpit_agents(id) ON DELETE RESTRICT,
  verifier_agent_id text REFERENCES cockpit_agents(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  summary text NOT NULL CHECK (octet_length(summary) BETWEEN 1 AND 8192),
  status text NOT NULL CHECK (status IN ('ready','verified','rejected','blocked')),
  relative_path text CHECK (relative_path IS NULL OR char_length(relative_path) BETWEEN 1 AND 500),
  sha256 char(64) CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  CHECK (verifier_agent_id IS NULL OR verifier_agent_id <> producer_agent_id)
);
CREATE INDEX IF NOT EXISTS company_session_deliverables_session_idx
  ON company_session_deliverables(session_id, created_at);

CREATE TABLE IF NOT EXISTS company_session_events (
  sequence bigserial PRIMARY KEY,
  id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  session_id uuid NOT NULL REFERENCES company_sessions(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 100),
  safe_payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(safe_payload::text) <= 16384),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS company_session_events_session_idx
  ON company_session_events(session_id, sequence);

COMMIT;
