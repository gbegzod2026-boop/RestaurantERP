-- 0014_customer_event_insert.up.sql
-- Customer order/chat/call writes must be able to record realtime_events
-- for staff subscribers without gaining SELECT on the tenant event feed.
BEGIN;

DROP POLICY IF EXISTS realtime_events_customer_deny ON realtime_events;

CREATE POLICY realtime_events_customer_no_select ON realtime_events
  AS RESTRICTIVE FOR SELECT TO nesta_app
  USING (NOT app_is_customer());

CREATE POLICY realtime_events_customer_no_update ON realtime_events
  AS RESTRICTIVE FOR UPDATE TO nesta_app
  USING (NOT app_is_customer())
  WITH CHECK (NOT app_is_customer());

CREATE POLICY realtime_events_customer_no_delete ON realtime_events
  AS RESTRICTIVE FOR DELETE TO nesta_app
  USING (NOT app_is_customer());

COMMIT;
