-- 0013_customer_session_rls.up.sql
-- Customer least-privilege DB context: bind orders to customer_session_id,
-- set actingRole=customer GUCs, and RESTRICTIVE policies so customer is
-- never equivalent to waiter tenant-wide visibility.
BEGIN;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS customer_session_id text;

CREATE INDEX IF NOT EXISTS idx_orders_customer_session
  ON orders (restaurant_id, customer_session_id)
  WHERE customer_session_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app_is_customer() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.current_employee_role', true) = 'customer'
$$;

CREATE OR REPLACE FUNCTION app_customer_uid() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_customer_uid', true), '')
$$;

CREATE OR REPLACE FUNCTION app_customer_table() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_customer_table', true), '')
$$;

CREATE OR REPLACE FUNCTION app_customer_owns_order(p_order_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM orders o
     WHERE o.id = p_order_id
       AND o.customer_session_id IS NOT NULL
       AND o.customer_session_id = app_customer_uid()
  )
$$;

-- Own-session orders only (fail closed if binding is missing).
DROP POLICY IF EXISTS orders_customer_own ON orders;
CREATE POLICY orders_customer_own ON orders
  AS RESTRICTIVE FOR ALL TO nesta_app
  USING (
    NOT app_is_customer()
    OR (customer_session_id IS NOT NULL AND customer_session_id = app_customer_uid())
  )
  WITH CHECK (
    NOT app_is_customer()
    OR (customer_session_id IS NOT NULL AND customer_session_id = app_customer_uid())
  );

DROP POLICY IF EXISTS orders_customer_no_delete ON orders;
CREATE POLICY orders_customer_no_delete ON orders
  AS RESTRICTIVE FOR DELETE TO nesta_app
  USING (NOT app_is_customer());

DROP POLICY IF EXISTS order_items_customer_own ON order_items;
CREATE POLICY order_items_customer_own ON order_items
  AS RESTRICTIVE FOR ALL TO nesta_app
  USING (NOT app_is_customer() OR app_customer_owns_order(order_id))
  WITH CHECK (NOT app_is_customer() OR app_customer_owns_order(order_id));

DROP POLICY IF EXISTS payments_customer_own ON payments;
CREATE POLICY payments_customer_own ON payments
  AS RESTRICTIVE FOR ALL TO nesta_app
  USING (NOT app_is_customer() OR app_customer_owns_order(order_id))
  WITH CHECK (NOT app_is_customer() OR app_customer_owns_order(order_id));

DROP POLICY IF EXISTS order_status_history_customer_own ON order_status_history;
CREATE POLICY order_status_history_customer_own ON order_status_history
  AS RESTRICTIVE FOR ALL TO nesta_app
  USING (NOT app_is_customer() OR app_customer_owns_order(order_id))
  WITH CHECK (NOT app_is_customer() OR app_customer_owns_order(order_id));

DROP POLICY IF EXISTS order_timeline_customer_own ON order_timeline;
CREATE POLICY order_timeline_customer_own ON order_timeline
  AS RESTRICTIVE FOR ALL TO nesta_app
  USING (NOT app_is_customer() OR app_customer_owns_order(order_id))
  WITH CHECK (NOT app_is_customer() OR app_customer_owns_order(order_id));

DROP POLICY IF EXISTS order_change_requests_customer_own ON order_change_requests;
CREATE POLICY order_change_requests_customer_own ON order_change_requests
  AS RESTRICTIVE FOR ALL TO nesta_app
  USING (NOT app_is_customer() OR app_customer_owns_order(order_id))
  WITH CHECK (NOT app_is_customer() OR app_customer_owns_order(order_id));

DROP POLICY IF EXISTS order_chats_customer_own ON order_chats;
CREATE POLICY order_chats_customer_own ON order_chats
  AS RESTRICTIVE FOR ALL TO nesta_app
  USING (NOT app_is_customer() OR app_customer_owns_order(order_id))
  WITH CHECK (NOT app_is_customer() OR app_customer_owns_order(order_id));

DROP POLICY IF EXISTS order_chat_messages_customer_own ON order_chat_messages;
CREATE POLICY order_chat_messages_customer_own ON order_chat_messages
  AS RESTRICTIVE FOR ALL TO nesta_app
  USING (
    NOT app_is_customer()
    OR order_chat_id IN (SELECT id FROM order_chats WHERE app_customer_owns_order(order_id))
  )
  WITH CHECK (
    NOT app_is_customer()
    OR order_chat_id IN (SELECT id FROM order_chats WHERE app_customer_owns_order(order_id))
  );

DROP POLICY IF EXISTS waiter_calls_customer_own ON waiter_calls;
CREATE POLICY waiter_calls_customer_own ON waiter_calls
  AS RESTRICTIVE FOR ALL TO nesta_app
  USING (
    NOT app_is_customer()
    OR (
      app_customer_table() IS NOT NULL
      AND (
        legacy_table_key = app_customer_table()
        OR legacy_table_key = 'table_' || app_customer_table()
        OR ('table_' || COALESCE(legacy_table_key, '')) = app_customer_table()
      )
    )
  )
  WITH CHECK (
    NOT app_is_customer()
    OR (
      app_customer_table() IS NOT NULL
      AND (
        legacy_table_key = app_customer_table()
        OR legacy_table_key = 'table_' || app_customer_table()
        OR ('table_' || COALESCE(legacy_table_key, '')) = app_customer_table()
      )
    )
  );

DROP POLICY IF EXISTS waiter_calls_customer_no_mutate ON waiter_calls;
CREATE POLICY waiter_calls_customer_no_mutate ON waiter_calls
  AS RESTRICTIVE FOR UPDATE TO nesta_app
  USING (NOT app_is_customer())
  WITH CHECK (NOT app_is_customer());

DROP POLICY IF EXISTS tables_customer_own ON tables;
CREATE POLICY tables_customer_own ON tables
  AS RESTRICTIVE FOR SELECT TO nesta_app
  USING (
    NOT app_is_customer()
    OR (
      app_customer_table() IS NOT NULL
      AND (
        number::text = app_customer_table()
        OR legacy_rtdb_id = app_customer_table()
        OR legacy_rtdb_id = 'table_' || app_customer_table()
      )
    )
  );

DROP POLICY IF EXISTS tables_customer_no_write ON tables;
CREATE POLICY tables_customer_no_write ON tables
  AS RESTRICTIVE FOR INSERT TO nesta_app
  WITH CHECK (NOT app_is_customer());
DROP POLICY IF EXISTS tables_customer_no_update ON tables;
CREATE POLICY tables_customer_no_update ON tables
  AS RESTRICTIVE FOR UPDATE TO nesta_app
  USING (NOT app_is_customer())
  WITH CHECK (NOT app_is_customer());
DROP POLICY IF EXISTS tables_customer_no_delete ON tables;
CREATE POLICY tables_customer_no_delete ON tables
  AS RESTRICTIVE FOR DELETE TO nesta_app
  USING (NOT app_is_customer());

DROP POLICY IF EXISTS restaurant_settings_customer_deny ON restaurant_settings;
CREATE POLICY restaurant_settings_customer_deny ON restaurant_settings
  AS RESTRICTIVE FOR ALL TO nesta_app
  USING (NOT app_is_customer())
  WITH CHECK (NOT app_is_customer());

CREATE OR REPLACE FUNCTION public_restaurant_settings(p_restaurant uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT settings FROM restaurant_settings WHERE restaurant_id = p_restaurant), '{}'::jsonb)
$$;
REVOKE ALL ON FUNCTION public_restaurant_settings(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_restaurant_settings(uuid) TO nesta_app;

-- Public catalog: customers may read, never write.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['menu_items','menu_categories','combo_items','kitchen_stations']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_customer_no_ins', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I AS RESTRICTIVE FOR INSERT TO nesta_app WITH CHECK (NOT app_is_customer())',
      t || '_customer_no_ins', t
    );
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_customer_no_upd', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I AS RESTRICTIVE FOR UPDATE TO nesta_app USING (NOT app_is_customer()) WITH CHECK (NOT app_is_customer())',
      t || '_customer_no_upd', t
    );
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_customer_no_del', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I AS RESTRICTIVE FOR DELETE TO nesta_app USING (NOT app_is_customer())',
      t || '_customer_no_del', t
    );
  END LOOP;
END $$;

-- All other tenant tables: customer sees nothing.
DO $$
DECLARE
  r record;
  allowed text[] := ARRAY[
    'menu_items','menu_categories','combo_items','kitchen_stations',
    'orders','order_items','order_status_history','order_timeline',
    'order_change_requests','order_chats','order_chat_messages',
    'payments','waiter_calls','tables'
  ];
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'restaurant_id' AND NOT a.attisdropped AND a.attnum > 0
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND c.relname <> ALL(allowed)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', r.relname || '_customer_deny', r.relname);
    EXECUTE format(
      'CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL TO nesta_app USING (NOT app_is_customer()) WITH CHECK (NOT app_is_customer())',
      r.relname || '_customer_deny', r.relname
    );
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public_restaurant_settings(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_restaurant_settings(uuid) TO nesta_app;

COMMIT;
