-- 0018_production_migration_attempts.up.sql
-- Platform-only Step 2D.5 production migration provenance.
-- Not tenant-owned: no restaurant_id, no RLS, no GRANT to nesta_app.
-- Stores durable attempt identity so Wave1 → full and resume cannot be
-- authorized by env flags, PREFLIGHT.json, or a populated restaurants count.
-- Phase/status combinations are closed. Concurrent transitions use
-- compare-and-swap on (status, phase, transition_epoch).
BEGIN;

CREATE TABLE production_migration_attempts (
  attempt_id uuid PRIMARY KEY,
  target_fingerprint text NOT NULL,
  candidate_commit text NOT NULL,
  reviewed_tag text NOT NULL,
  cutover_window_identity text NOT NULL,
  firebase_project text NOT NULL,
  freeze_generated_at timestamptz NOT NULL,
  freeze_identity text NOT NULL,
  phase text NOT NULL,
  status text NOT NULL,
  transition_epoch integer NOT NULL DEFAULT 0,
  wave1_batch_id text,
  full_checkpoint_id text,
  started_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT production_migration_attempts_status_chk CHECK (
    status IN (
      'AUTHORIZED',
      'WAVE1_IN_PROGRESS',
      'WAVE1_COMPLETE',
      'FULL_IN_PROGRESS',
      'FULL_COMPLETE',
      'FAILED'
    )
  ),
  CONSTRAINT production_migration_attempts_phase_chk CHECK (
    phase IN (
      'wave1-initial',
      'full-after-wave1',
      'resume-wave1',
      'resume-full'
    )
  ),
  CONSTRAINT production_migration_attempts_state_chk CHECK (
    (status = 'AUTHORIZED' AND phase = 'wave1-initial')
    OR (status = 'WAVE1_IN_PROGRESS' AND phase IN ('wave1-initial', 'resume-wave1'))
    OR (status = 'WAVE1_COMPLETE' AND phase = 'full-after-wave1')
    OR (status = 'FULL_IN_PROGRESS' AND phase IN ('full-after-wave1', 'resume-full'))
    OR (status = 'FULL_COMPLETE' AND phase = 'full-after-wave1')
    OR (status = 'FAILED' AND phase IN ('wave1-initial', 'resume-wave1', 'full-after-wave1', 'resume-full'))
  ),
  CONSTRAINT production_migration_attempts_epoch_chk CHECK (transition_epoch >= 0),
  CONSTRAINT production_migration_attempts_fingerprint_chk CHECK (
    target_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT production_migration_attempts_freeze_identity_chk CHECK (
    freeze_identity ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX uq_production_migration_attempts_binding
  ON production_migration_attempts (
    target_fingerprint,
    candidate_commit,
    cutover_window_identity,
    freeze_identity
  );

REVOKE ALL ON TABLE production_migration_attempts FROM PUBLIC;
REVOKE ALL ON TABLE production_migration_attempts FROM nesta_app;

CREATE FUNCTION production_migration_attempts_protect_terminal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'FULL_COMPLETE' THEN
    RAISE EXCEPTION 'production_migration_attempts: FULL_COMPLETE cannot be overwritten';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER production_migration_attempts_protect_terminal
  BEFORE UPDATE ON production_migration_attempts
  FOR EACH ROW
  EXECUTE FUNCTION production_migration_attempts_protect_terminal();

REVOKE ALL ON FUNCTION production_migration_attempts_protect_terminal() FROM PUBLIC;
REVOKE ALL ON FUNCTION production_migration_attempts_protect_terminal() FROM nesta_app;

COMMENT ON TABLE production_migration_attempts IS
  'Step 2D.5 durable production migration attempt provenance. Platform-only; never tenant-scoped.';

COMMIT;
