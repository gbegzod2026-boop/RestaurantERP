-- 0014_customer_event_insert.down.sql
BEGIN;

DROP POLICY IF EXISTS realtime_events_customer_no_select ON realtime_events;
DROP POLICY IF EXISTS realtime_events_customer_no_update ON realtime_events;
DROP POLICY IF EXISTS realtime_events_customer_no_delete ON realtime_events;

CREATE POLICY realtime_events_customer_deny ON realtime_events
  AS RESTRICTIVE FOR ALL TO nesta_app
  USING (NOT app_is_customer())
  WITH CHECK (NOT app_is_customer());

COMMIT;
