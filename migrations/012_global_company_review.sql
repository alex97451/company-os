BEGIN;

ALTER TABLE company_session_participants
  DROP CONSTRAINT IF EXISTS company_session_participants_invitation_order_check;

ALTER TABLE company_session_participants
  ADD CONSTRAINT company_session_participants_invitation_order_check
  CHECK (invitation_order BETWEEN 0 AND 9);

COMMIT;
