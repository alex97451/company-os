BEGIN;

ALTER TABLE cockpit_tasks ADD COLUMN IF NOT EXISTS ceo_turn_id text;
ALTER TABLE cockpit_tasks ADD COLUMN IF NOT EXISTS delegation_index smallint;

CREATE UNIQUE INDEX IF NOT EXISTS cockpit_ceo_delegation_once_idx
  ON cockpit_tasks(ceo_turn_id, delegation_index) WHERE ceo_turn_id IS NOT NULL;

ALTER TABLE cockpit_tasks DROP CONSTRAINT IF EXISTS cockpit_tasks_delegation_index_check;
ALTER TABLE cockpit_tasks ADD CONSTRAINT cockpit_tasks_delegation_index_check
  CHECK ((ceo_turn_id IS NULL AND delegation_index IS NULL)
      OR (ceo_turn_id IS NOT NULL AND delegation_index BETWEEN 0 AND 4));

COMMIT;
