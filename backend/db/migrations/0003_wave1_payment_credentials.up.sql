-- 0003_wave1_payment_credentials.up.sql
-- Wave 1 follow-up — payment_credentials: a separate, column-gated home for
-- per-restaurant Click/Payme/Uzum secret keys, replacing the plan to keep
-- them inside restaurant_settings.settings (jsonb catch-all, no column-level
-- protection at all — see the Wave 1 post-migration security review that
-- prompted this file: nesta_app was proven able to SELECT
-- settings->>'clickSecretKey' directly, live, with zero extra privilege).
--
-- NOT applied by the same act that wrote this file — proposal only, per
-- task instruction. Live-validated once, in a transaction that was always
-- ROLLBACK'd (see the accompanying report), never left applied. Run
-- `node db/migrate.js up` yourself when ready to actually create this table.
--
-- Deliberately mirrors 0001_wave0_core.up.sql's employee_credentials
-- pattern column-for-column, not a new design:
--   - secret material lives in its own table, never a plaintext jsonb blob
--   - nesta_app gets INSERT + a narrow UPDATE (can WRITE a new secret) but
--     NEVER SELECT on the secret column itself
--   - a separate NOLOGIN "revealer" role holds the one SELECT grant that
--     matters, entered via SET ROLE only for the one code path that
--     actually needs to decrypt a real value (calling out to Click/Payme/
--     Uzum using the restaurant's own merchant credential) — the same
--     structural boundary the P0-2 fix and Wave 0 already established for
--     employee login credentials, reused rather than reinvented
--   - FORCE ROW LEVEL SECURITY applies to the revealer role too — SET ROLE
--     alone is not enough to see a row outside the current tenant context,
--     matching nesta_credential_revealer's own documented behavior
--
-- secret_enc stores the exact ciphertext format backend/security/crypto.js's
-- encryptSecret()/decryptSecret() already use elsewhere in this codebase
-- (AES-256-GCM, server-only ENCRYPTION_KEY from backend/.env, "iv.enc.tag"
-- base64 triplet) — the existing mechanism, not a new one.
--
-- restaurant_settings.settings keeps every NON-secret field as-is
-- (merchantId/serviceId/enabled flags/links) — no schema change needed
-- there, it's still the right home for those. The 3 secret fields
-- (clickSecretKey/paymeSecretKey/uzumSecretKey) already present in the 6
-- restaurant_settings rows Wave 1's real apply migrated are NOT touched by
-- this file — moving/stripping them is real production data movement,
-- explicitly out of scope until a future wave is told to do it.
BEGIN;

CREATE TABLE payment_credentials (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  provider       text NOT NULL CHECK (provider IN ('click', 'payme', 'uzum')),
  secret_enc     text,                      -- AES-256-GCM ciphertext (crypto.js's encryptSecret() output) or NULL if never configured
  configured     boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, provider)
);
CREATE INDEX idx_payment_credentials_restaurant_id ON payment_credentials (restaurant_id);
CREATE TRIGGER trg_payment_credentials_updated_at BEFORE UPDATE ON payment_credentials FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- `configured` is trigger-maintained, not app-maintained — this means
-- nesta_app (which cannot SELECT secret_enc) can never accidentally desync
-- the two: the boolean is always exactly "was secret_enc set to a non-empty
-- value", computed as part of the same write, regardless of which role or
-- code path performed it.
CREATE OR REPLACE FUNCTION sync_payment_credential_configured() RETURNS trigger AS $$
BEGIN
  NEW.configured := (NEW.secret_enc IS NOT NULL AND NEW.secret_enc <> '');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_payment_credentials_sync_configured
  BEFORE INSERT OR UPDATE ON payment_credentials
  FOR EACH ROW EXECUTE FUNCTION sync_payment_credential_configured();

-- ── Row-Level Security ────────────────────────────────────────────────
-- Same session contract and NULLIF-guarded cast as every other Wave 0/1
-- tenant-scoped table.
ALTER TABLE payment_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_credentials FORCE ROW LEVEL SECURITY;

CREATE POLICY payment_credentials_select ON payment_credentials FOR SELECT USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);
-- INSERT/UPDATE restricted to platform or same-restaurant owner/admin —
-- identical shape to employee_credentials' own policy (0001_wave0_core.up.sql):
-- setting a payment credential is exactly as sensitive as setting a login
-- credential, same authorization bar applies.
CREATE POLICY payment_credentials_insert ON payment_credentials FOR INSERT WITH CHECK (
  current_setting('app.current_restaurant_id', true) = ''
  OR (restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
      AND current_setting('app.current_employee_role', true) IN ('owner', 'admin'))
);
CREATE POLICY payment_credentials_update ON payment_credentials FOR UPDATE USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR (restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
      AND current_setting('app.current_employee_role', true) IN ('owner', 'admin'))
) WITH CHECK (
  current_setting('app.current_restaurant_id', true) = ''
  OR (restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
      AND current_setting('app.current_employee_role', true) IN ('owner', 'admin'))
);
-- No DELETE policy — default-deny for every role but the table owner,
-- matching employee_credentials: a credential is rotated (UPDATE), never
-- hard-deleted while the restaurant exists (deleting the restaurant
-- CASCADEs this row instead).

-- ── Roles ─────────────────────────────────────────────────────────────
-- nesta_payment_revealer: judged actually required, not decorative — without
-- it, the only role that could ever decrypt a real secret would be the
-- table owner/superuser connection, which is a strictly bigger privilege
-- footprint than a purpose-built narrow role for the one legitimate need
-- (calling out to a payment provider using the restaurant's own
-- credential). Exactly mirrors nesta_credential_revealer's existing,
-- accepted precedent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nesta_payment_revealer') THEN
    CREATE ROLE nesta_payment_revealer NOLOGIN;
  END IF;
END $$;
GRANT nesta_payment_revealer TO nesta_app WITH INHERIT FALSE; -- membership without automatic inheritance — see 0001's WITH INHERIT FALSE note, same live-verified lesson applies here
GRANT nesta_payment_revealer TO CURRENT_USER; -- lets the migrator/test runner SET ROLE into it, same as 0001's `GRANT nesta_app TO CURRENT_USER`

-- ── Column-level privilege boundary (the real secret-reveal gate) ─────
REVOKE ALL ON payment_credentials FROM PUBLIC;
GRANT SELECT (id, restaurant_id, provider, configured, created_at, updated_at) ON payment_credentials TO nesta_app; -- secret_enc excluded
GRANT INSERT ON payment_credentials TO nesta_app; -- full-row insert (the app supplies secret_enc at write time; INSERT doesn't require reading it back)
GRANT UPDATE (secret_enc, updated_at) ON payment_credentials TO nesta_app; -- can WRITE a new secret (or clear it) without ever being able to SELECT one back
GRANT SELECT (id, restaurant_id, provider, secret_enc) ON payment_credentials TO nesta_payment_revealer;

COMMIT;
