-- 0009_tenant_fk_integrity.down.sql
BEGIN;

ALTER TABLE discount_claims DROP CONSTRAINT IF EXISTS discount_claims_order_restaurant_fkey;
ALTER TABLE discount_claims
  ADD CONSTRAINT discount_claims_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL;

ALTER TABLE feedback DROP CONSTRAINT IF EXISTS feedback_order_restaurant_fkey;
ALTER TABLE feedback
  ADD CONSTRAINT feedback_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL;

ALTER TABLE debts DROP CONSTRAINT IF EXISTS debts_order_restaurant_fkey;
ALTER TABLE debts
  ADD CONSTRAINT debts_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL;

ALTER TABLE waiter_calls DROP CONSTRAINT IF EXISTS waiter_calls_order_restaurant_fkey;
ALTER TABLE waiter_calls
  ADD CONSTRAINT waiter_calls_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL;

ALTER TABLE courier_assignments DROP CONSTRAINT IF EXISTS courier_assignments_order_restaurant_fkey;
ALTER TABLE courier_assignments
  ADD CONSTRAINT courier_assignments_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_order_restaurant_fkey;
ALTER TABLE payments
  ADD CONSTRAINT payments_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;

ALTER TABLE order_chats DROP CONSTRAINT IF EXISTS order_chats_order_restaurant_fkey;
ALTER TABLE order_chats
  ADD CONSTRAINT order_chats_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;

ALTER TABLE order_change_requests DROP CONSTRAINT IF EXISTS order_change_requests_order_restaurant_fkey;
ALTER TABLE order_change_requests
  ADD CONSTRAINT order_change_requests_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;

ALTER TABLE order_timeline DROP CONSTRAINT IF EXISTS order_timeline_order_restaurant_fkey;
ALTER TABLE order_timeline
  ADD CONSTRAINT order_timeline_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;

ALTER TABLE order_status_history DROP CONSTRAINT IF EXISTS order_status_history_order_restaurant_fkey;
ALTER TABLE order_status_history
  ADD CONSTRAINT order_status_history_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;

ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_order_restaurant_fkey;
ALTER TABLE order_items
  ADD CONSTRAINT order_items_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_id_restaurant_id_key;

DROP INDEX IF EXISTS idx_order_change_requests_order_item_id;
DROP INDEX IF EXISTS idx_menu_items_subcategory_id;
DROP INDEX IF EXISTS idx_menu_items_kitchen_station_id;
DROP INDEX IF EXISTS idx_employees_custom_role_id;
DROP INDEX IF EXISTS idx_courier_assignments_order_id;

COMMIT;
