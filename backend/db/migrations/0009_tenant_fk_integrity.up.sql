-- 0009_tenant_fk_integrity.up.sql
-- Live RLS verification (rls-wave2.test.mjs) found two real defects:
--
-- 1. Five single-column FKs had no *leading* index. PostgreSQL cannot use a
--    later column of a composite index to satisfy ON DELETE scans, so those
--    FKs would seq-scan the child on parent delete.
--
-- 2. RLS does not apply to foreign-key lookups. A tenant that stamps its own
--    restaurant_id (WITH CHECK passes) could still point order_id at another
--    restaurant's order. A composite FK (order_id, restaurant_id) →
--    orders(id, restaurant_id) makes that physically impossible.
--
-- Additive only. No existing column is dropped or rewritten.
BEGIN;

CREATE INDEX IF NOT EXISTS idx_courier_assignments_order_id
  ON courier_assignments (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employees_custom_role_id
  ON employees (custom_role_id) WHERE custom_role_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_menu_items_kitchen_station_id
  ON menu_items (kitchen_station_id) WHERE kitchen_station_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_menu_items_subcategory_id
  ON menu_items (subcategory_id) WHERE subcategory_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_order_change_requests_order_item_id
  ON order_change_requests (order_item_id) WHERE order_item_id IS NOT NULL;

ALTER TABLE orders
  ADD CONSTRAINT orders_id_restaurant_id_key UNIQUE (id, restaurant_id);

ALTER TABLE order_items DROP CONSTRAINT order_items_order_id_fkey;
ALTER TABLE order_items
  ADD CONSTRAINT order_items_order_restaurant_fkey
  FOREIGN KEY (order_id, restaurant_id) REFERENCES orders (id, restaurant_id) ON DELETE CASCADE;

ALTER TABLE order_status_history DROP CONSTRAINT order_status_history_order_id_fkey;
ALTER TABLE order_status_history
  ADD CONSTRAINT order_status_history_order_restaurant_fkey
  FOREIGN KEY (order_id, restaurant_id) REFERENCES orders (id, restaurant_id) ON DELETE CASCADE;

ALTER TABLE order_timeline DROP CONSTRAINT order_timeline_order_id_fkey;
ALTER TABLE order_timeline
  ADD CONSTRAINT order_timeline_order_restaurant_fkey
  FOREIGN KEY (order_id, restaurant_id) REFERENCES orders (id, restaurant_id) ON DELETE CASCADE;

ALTER TABLE order_change_requests DROP CONSTRAINT order_change_requests_order_id_fkey;
ALTER TABLE order_change_requests
  ADD CONSTRAINT order_change_requests_order_restaurant_fkey
  FOREIGN KEY (order_id, restaurant_id) REFERENCES orders (id, restaurant_id) ON DELETE CASCADE;

ALTER TABLE order_chats DROP CONSTRAINT order_chats_order_id_fkey;
ALTER TABLE order_chats
  ADD CONSTRAINT order_chats_order_restaurant_fkey
  FOREIGN KEY (order_id, restaurant_id) REFERENCES orders (id, restaurant_id) ON DELETE CASCADE;

ALTER TABLE payments DROP CONSTRAINT payments_order_id_fkey;
ALTER TABLE payments
  ADD CONSTRAINT payments_order_restaurant_fkey
  FOREIGN KEY (order_id, restaurant_id) REFERENCES orders (id, restaurant_id) ON DELETE CASCADE;

ALTER TABLE courier_assignments DROP CONSTRAINT courier_assignments_order_id_fkey;
ALTER TABLE courier_assignments
  ADD CONSTRAINT courier_assignments_order_restaurant_fkey
  FOREIGN KEY (order_id, restaurant_id) REFERENCES orders (id, restaurant_id) ON DELETE CASCADE;

ALTER TABLE waiter_calls DROP CONSTRAINT waiter_calls_order_id_fkey;
ALTER TABLE waiter_calls
  ADD CONSTRAINT waiter_calls_order_restaurant_fkey
  FOREIGN KEY (order_id, restaurant_id) REFERENCES orders (id, restaurant_id) ON DELETE SET NULL;

ALTER TABLE debts DROP CONSTRAINT debts_order_id_fkey;
ALTER TABLE debts
  ADD CONSTRAINT debts_order_restaurant_fkey
  FOREIGN KEY (order_id, restaurant_id) REFERENCES orders (id, restaurant_id) ON DELETE SET NULL;

ALTER TABLE feedback DROP CONSTRAINT feedback_order_id_fkey;
ALTER TABLE feedback
  ADD CONSTRAINT feedback_order_restaurant_fkey
  FOREIGN KEY (order_id, restaurant_id) REFERENCES orders (id, restaurant_id) ON DELETE SET NULL;

ALTER TABLE discount_claims DROP CONSTRAINT discount_claims_order_id_fkey;
ALTER TABLE discount_claims
  ADD CONSTRAINT discount_claims_order_restaurant_fkey
  FOREIGN KEY (order_id, restaurant_id) REFERENCES orders (id, restaurant_id) ON DELETE SET NULL;

COMMIT;
