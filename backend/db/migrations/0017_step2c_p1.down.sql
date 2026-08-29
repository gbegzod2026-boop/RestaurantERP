-- 0017_step2c_p1.down.sql
BEGIN;

ALTER TABLE restaurants DROP COLUMN IF EXISTS subscription;
ALTER TABLE restaurant_modules DROP COLUMN IF EXISTS extra;
ALTER TABLE employees DROP COLUMN IF EXISTS extra;

ALTER TABLE custom_roles DROP CONSTRAINT IF EXISTS uq_custom_roles_restaurant_legacy;
CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_roles_restaurant_legacy
  ON custom_roles (restaurant_id, legacy_rtdb_id)
  WHERE legacy_rtdb_id IS NOT NULL;
ALTER TABLE custom_roles ADD CONSTRAINT custom_roles_restaurant_id_name_key UNIQUE (restaurant_id, name);

COMMIT;
