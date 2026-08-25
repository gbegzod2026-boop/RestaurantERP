-- 0005_wave3_finance_inventory.down.sql — reverses 0005, children first.
BEGIN;

DROP TABLE IF EXISTS debts;
DROP TABLE IF EXISTS supplier_payments;
DROP TABLE IF EXISTS purchase_order_items;
DROP TABLE IF EXISTS purchase_orders;
DROP TABLE IF EXISTS semi_finished_acts;
DROP TABLE IF EXISTS semi_finished;
DROP TABLE IF EXISTS recipe_items;
DROP TABLE IF EXISTS recipes;
DROP TABLE IF EXISTS daily_usage;
DROP TABLE IF EXISTS stock_movements;
DROP TABLE IF EXISTS inventory_items;

-- expenses gained this FK after suppliers existed; drop it before suppliers.
ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_supplier_id_fkey;
DROP TABLE IF EXISTS suppliers;

DROP TABLE IF EXISTS staff_stats;
DROP TABLE IF EXISTS payroll_entries;
DROP TABLE IF EXISTS finance_entries;
DROP TABLE IF EXISTS cash_counts;
DROP TABLE IF EXISTS expenses;

COMMIT;
