-- 0010_order_number_not_unique.down.sql
BEGIN;

DROP INDEX IF EXISTS idx_orders_restaurant_type_number;
CREATE UNIQUE INDEX uq_orders_restaurant_type_number
  ON orders (restaurant_id, order_type, order_number)
  WHERE order_number IS NOT NULL;

COMMIT;
