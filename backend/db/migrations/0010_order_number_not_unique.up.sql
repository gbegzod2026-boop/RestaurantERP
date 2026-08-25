-- 0010_order_number_not_unique.up.sql
-- Live apply dry-run found two restaurants where (order_type, order_number)
-- is NOT unique: rest_1784740340104 has two dine-in orders sharing a number.
-- The 0004 unique index encoded an assumption about RTDB counters that the
-- production data already violates. Identity remains UNIQUE (restaurant_id,
-- legacy_rtdb_id). Lookups by number stay indexed, just not unique.
BEGIN;

DROP INDEX IF EXISTS uq_orders_restaurant_type_number;
CREATE INDEX IF NOT EXISTS idx_orders_restaurant_type_number
  ON orders (restaurant_id, order_type, order_number)
  WHERE order_number IS NOT NULL;

COMMIT;
