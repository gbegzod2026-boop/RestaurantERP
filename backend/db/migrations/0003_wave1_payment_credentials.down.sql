-- 0003_wave1_payment_credentials.down.sql
-- Reverses 0003_wave1_payment_credentials.up.sql exactly. Role membership
-- (GRANT ... TO ...) is independent of the table's existence in Postgres,
-- so it must be revoked explicitly before DROP ROLE — dropping the table
-- first would leave the membership grant orphaned, not remove it.
BEGIN;

REVOKE nesta_payment_revealer FROM nesta_app;
REVOKE nesta_payment_revealer FROM CURRENT_USER;

DROP TABLE IF EXISTS payment_credentials;
DROP FUNCTION IF EXISTS sync_payment_credential_configured();

DROP ROLE IF EXISTS nesta_payment_revealer;

COMMIT;
