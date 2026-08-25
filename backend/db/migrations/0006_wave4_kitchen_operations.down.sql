-- 0006_wave4_kitchen_operations.down.sql — reverses 0006, children first.
BEGIN;

DROP TABLE IF EXISTS equipment_printers;
DROP TABLE IF EXISTS terminal_settings;
DROP TABLE IF EXISTS print_settings;
DROP TABLE IF EXISTS promotions;
DROP TABLE IF EXISTS discounts;
DROP TABLE IF EXISTS stop_list;
DROP TABLE IF EXISTS extras;
DROP TABLE IF EXISTS modifiers;
DROP TABLE IF EXISTS production_plans;
DROP TABLE IF EXISTS kitchen_announcements;
DROP TABLE IF EXISTS kitchen_inventory;
DROP TABLE IF EXISTS equipment_status;
DROP TABLE IF EXISTS waste_log;
DROP TABLE IF EXISTS prep_schedule;
DROP TABLE IF EXISTS chef_tasks;
DROP TABLE IF EXISTS shifts;
DROP TABLE IF EXISTS attendance;

COMMIT;
