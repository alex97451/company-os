BEGIN;

ALTER TABLE cockpit_commands ADD COLUMN IF NOT EXISTS remote_thread_id text;
ALTER TABLE cockpit_commands ADD COLUMN IF NOT EXISTS remote_turn_id text;
CREATE UNIQUE INDEX IF NOT EXISTS cockpit_command_remote_turn_idx
  ON cockpit_commands(remote_turn_id) WHERE remote_turn_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS cockpit_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender text NOT NULL CHECK (sender IN ('owner','ceo')),
  command_id uuid NOT NULL REFERENCES cockpit_commands(id) ON DELETE CASCADE,
  safe_body text NOT NULL CHECK (octet_length(safe_body) BETWEEN 1 AND 16384),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','dispatched','completed','failed','reconciliation_required','demo')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  CHECK (expires_at <= created_at + interval '30 days')
);
CREATE INDEX IF NOT EXISTS cockpit_messages_recent_idx ON cockpit_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS cockpit_messages_expiry_idx ON cockpit_messages(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS cockpit_one_ceo_message_per_command_idx
  ON cockpit_messages(command_id) WHERE sender = 'ceo';

COMMIT;
