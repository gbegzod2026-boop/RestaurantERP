-- 0017_step2c_p1.up.sql
-- Step 2C: lossless identity for unnamed restaurants / empty-role employees /
-- colliding custom-role names, plus destination columns for modules and
-- subscription blobs. Additive only. Does not rewrite existing rows.
BEGIN;

-- Custom roles: Firebase source key is the migration identity. Display name
-- is a label and may repeat within a tenant. Dropping UNIQUE (restaurant_id,
-- name) is required to stop last-write-wins collapse (13 source keys -> 6 rows).
ALTER TABLE custom_roles DROP CONSTRAINT IF EXISTS custom_roles_restaurant_id_name_key;
DROP INDEX IF EXISTS uq_custom_roles_restaurant_legacy;
ALTER TABLE custom_roles
  ADD CONSTRAINT uq_custom_roles_restaurant_legacy UNIQUE (restaurant_id, legacy_rtdb_id);

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS extra jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE restaurant_modules
  ADD COLUMN IF NOT EXISTS extra jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS subscription jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN employees.extra IS
  'Migration/review metadata (raw_role, role_resolution_required). Never used as an authorization grant.';
COMMENT ON COLUMN restaurant_modules.extra IS
  'Full restaurants/$restId/modules tree preserved losslessly; enabled_modules is the derived enabled-key list.';
COMMENT ON COLUMN restaurants.subscription IS
  'Full restaurants/$restId/subscription object. Operational dates/plan/status live here; unknown fields stay in the jsonb.';

COMMIT;
