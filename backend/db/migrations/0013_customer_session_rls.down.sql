-- 0013_customer_session_rls.down.sql
BEGIN;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname, p.polname
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND (
         p.polname LIKE '%_customer_deny'
         OR p.polname LIKE '%_customer_own'
         OR p.polname LIKE '%_customer_no_%'
         OR p.polname LIKE '%_customer_no_mutate'
       )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', r.polname, r.relname);
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS public_restaurant_settings(uuid);
DROP FUNCTION IF EXISTS app_customer_owns_order(uuid);
DROP FUNCTION IF EXISTS app_customer_table();
DROP FUNCTION IF EXISTS app_customer_uid();
DROP FUNCTION IF EXISTS app_is_customer();

DROP INDEX IF EXISTS idx_orders_customer_session;
ALTER TABLE orders DROP COLUMN IF EXISTS customer_session_id;

COMMIT;
