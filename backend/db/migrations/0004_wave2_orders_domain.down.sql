-- 0004_wave2_orders_domain.down.sql
-- Reverses 0004. Drop order is child-before-parent so the FKs never block a
-- rollback; CASCADE is intentionally NOT used, because a silent cascade here
-- could take Wave 0/1 tables with it if a future migration adds a dependency
-- nobody remembered.
BEGIN;

DROP TABLE IF EXISTS waiter_calls;
DROP TABLE IF EXISTS reservation_slots;
DROP TABLE IF EXISTS reservations;
DROP TABLE IF EXISTS courier_assignments;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS order_chat_messages;
DROP TABLE IF EXISTS order_chats;
DROP TABLE IF EXISTS order_change_requests;
DROP TABLE IF EXISTS order_timeline;
DROP TABLE IF EXISTS order_status_history;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS couriers;
DROP TABLE IF EXISTS customer_addresses;
DROP TABLE IF EXISTS customers;

-- The RLS helpers are created by 0004, so 0004's rollback removes them.
-- Later migrations that also use them therefore depend on 0004 remaining
-- applied — which the numbered-migration contract already guarantees.
DROP FUNCTION IF EXISTS apply_inherited_rls(text, text, text);
DROP FUNCTION IF EXISTS apply_tenant_rls(text, text);

COMMIT;
