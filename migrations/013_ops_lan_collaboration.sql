BEGIN;

CREATE TABLE IF NOT EXISTS ops_collaborator_presence (
  actor_id text PRIMARY KEY CHECK (actor_id ~ '^[a-z][a-z0-9_-]{1,31}$'),
  role text NOT NULL CHECK (role IN ('owner', 'operator')),
  active_view text NOT NULL CHECK (active_view IN ('overview', 'work', 'team', 'video', 'health', 'integrations')),
  connected_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ops_collaborator_presence_recent_idx
  ON ops_collaborator_presence(last_seen_at DESC);

COMMIT;
