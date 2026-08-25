-- 0011_phase2_runtime.down.sql
BEGIN;

DROP TABLE IF EXISTS realtime_events;
ALTER TABLE menu_categories DROP COLUMN IF EXISTS extra;
ALTER TABLE menu_items DROP COLUMN IF EXISTS extra;
ALTER TABLE employees DROP COLUMN IF EXISTS extra;
ALTER TABLE tables DROP COLUMN IF EXISTS extra;

COMMIT;
