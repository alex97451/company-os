BEGIN;

CREATE TABLE cockpit_owner_state (
  id smallint PRIMARY KEY CHECK (id = 1),
  command_version integer NOT NULL DEFAULT 0 CHECK (command_version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO cockpit_owner_state (id, command_version) VALUES (1, 0);

COMMIT;
