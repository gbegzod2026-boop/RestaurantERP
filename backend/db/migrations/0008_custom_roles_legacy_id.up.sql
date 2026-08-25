-- 0008_custom_roles_legacy_id.up.sql
-- Adds the missing legacy_rtdb_id to custom_roles.
--
-- Found by db/tests/schema.test.mjs, which requires every migrated entity to
-- carry its Firebase key. custom_roles was the one table that did not.
--
-- This is not cosmetic. Live production data depends on it: the Firebase
-- discovery scan found an employee whose `users/$uid/role` field holds a
-- custom-role PUSH ID rather than a role name --
--
--     restaurants/$restId/users/$uid/role = "-OyrlzxVx-_w5fMcKKy9"
--
-- and that push id is the key of a record under
-- `restaurants/$restId/customRoles/$roleId`. Without legacy_rtdb_id on
-- custom_roles there is no way to resolve that reference after migration, and
-- the employee's actual permissions would be silently lost -- exactly the
-- silent data loss Phase 1 forbids.
--
-- 0001_wave0_core.up.sql has already been applied to real databases, so it is
-- NOT edited. This is an additive follow-up: a nullable column plus a
-- tenant-scoped partial unique index. Nothing is rewritten, nothing is
-- dropped, and existing rows keep working with the column left NULL.
BEGIN;

ALTER TABLE custom_roles ADD COLUMN IF NOT EXISTS legacy_rtdb_id text;

COMMENT ON COLUMN custom_roles.legacy_rtdb_id IS
  'Firebase RTDB push id from restaurants/$restId/customRoles/$roleId. Required to resolve employees whose users/$uid/role field stores a custom-role id instead of a role name.';

-- Partial, because rows created natively in PostgreSQL (post-migration) have
-- no Firebase ancestry and must not all collide on NULL. Tenant-scoped for
-- the same reason every other legacy id is: two restaurants can legitimately
-- hold the same push id in their own subtrees.
CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_roles_restaurant_legacy
  ON custom_roles (restaurant_id, legacy_rtdb_id)
  WHERE legacy_rtdb_id IS NOT NULL;

COMMIT;
