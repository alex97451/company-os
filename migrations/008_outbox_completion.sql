BEGIN;

ALTER TABLE cockpit_outbox DROP CONSTRAINT IF EXISTS cockpit_outbox_state_check;
ALTER TABLE cockpit_outbox ADD CONSTRAINT cockpit_outbox_state_check
  CHECK (state IN ('pending','leased','sent','completed','failed','reconciliation_required'));

COMMIT;
