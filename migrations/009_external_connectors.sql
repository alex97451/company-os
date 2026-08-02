BEGIN;

CREATE TABLE IF NOT EXISTS ops_connectors (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  auth_kind text NOT NULL CHECK (auth_kind IN ('api_key', 'oauth2')),
  status text NOT NULL DEFAULT 'not_connected'
    CHECK (status IN ('not_connected', 'connected', 'expired', 'error')),
  public_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  encrypted_credentials text,
  token_expires_at timestamptz,
  connected_at timestamptz,
  last_tested_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ops_oauth_states (
  state_digest text PRIMARY KEY,
  connector_id text NOT NULL REFERENCES ops_connectors(id) ON DELETE CASCADE,
  encrypted_payload text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ops_oauth_states_expiry_idx
  ON ops_oauth_states (expires_at)
  WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS community_conversation_state (
  id bigserial PRIMARY KEY,
  connector_id text NOT NULL REFERENCES ops_connectors(id) ON DELETE CASCADE,
  external_thread_id text NOT NULL,
  public_url text,
  locale text CHECK (locale IN ('en', 'fr')),
  redacted_summary text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'awaiting_approval', 'replied', 'closed')),
  last_external_activity_at timestamptz,
  last_reply_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connector_id, external_thread_id)
);

INSERT INTO ops_connectors (id, display_name, auth_kind)
VALUES
  ('postiz', 'Postiz', 'api_key'),
  ('ayrshare', 'Ayrshare', 'api_key'),
  ('meta', 'Meta', 'oauth2'),
  ('reddit', 'Reddit', 'oauth2'),
  ('discourse', 'Discourse', 'api_key'),
  ('figma', 'Figma', 'api_key')
ON CONFLICT (id) DO UPDATE
SET display_name = EXCLUDED.display_name,
    auth_kind = EXCLUDED.auth_kind,
    updated_at = now();

COMMIT;
