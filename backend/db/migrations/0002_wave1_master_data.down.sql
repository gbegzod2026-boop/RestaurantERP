-- 0002_wave1_master_data.down.sql
-- Full reversal of 0002_wave1_master_data.up.sql. Drops in reverse
-- dependency order; policies/triggers/grants drop implicitly with their
-- table. Does not touch Wave 0's tables/roles/functions at all.
BEGIN;

DROP TABLE IF EXISTS combo_items;
DROP TABLE IF EXISTS menu_items;
DROP TABLE IF EXISTS kitchen_stations;
DROP TABLE IF EXISTS menu_categories;
DROP TABLE IF EXISTS tables;
DROP TABLE IF EXISTS restaurant_settings;

ALTER TABLE restaurants DROP COLUMN IF EXISTS info;
ALTER TABLE restaurants DROP COLUMN IF EXISTS business_type;

COMMIT;
