BEGIN;

CREATE TABLE IF NOT EXISTS company_projects (
  id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{2,62}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 120),
  kind text NOT NULL CHECK (kind IN ('saas', 'web_app', 'api', 'library', 'generic')),
  workspace_path text UNIQUE,
  isolation_mode text NOT NULL DEFAULT 'dedicated_runtime'
    CHECK (isolation_mode = 'dedicated_runtime'),
  status text NOT NULL DEFAULT 'registered'
    CHECK (status IN ('registered', 'online', 'offline', 'blocked', 'error')),
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_heartbeat_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS company_projects_status_idx
  ON company_projects (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS company_project_runtimes (
  project_id text PRIMARY KEY REFERENCES company_projects(id) ON DELETE CASCADE,
  runtime_id text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('starting', 'online', 'stopping', 'offline', 'error')),
  process_id integer CHECK (process_id IS NULL OR process_id > 0),
  web_port integer CHECK (web_port IS NULL OR web_port BETWEEN 1024 AND 65535),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  last_heartbeat_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
