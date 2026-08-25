-- 0008_custom_roles_legacy_id.down.sql
-- Reverses 0008. Dropping the column discards any migrated Firebase role
-- ids, so re-running the role migration is required after a rollback.
BEGIN;

DROP INDEX IF EXISTS uq_custom_roles_restaurant_legacy;
ALTER TABLE custom_roles DROP COLUMN IF EXISTS legacy_rtdb_id;

COMMIT;
