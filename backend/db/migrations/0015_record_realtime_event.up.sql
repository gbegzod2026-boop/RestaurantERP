-- 0015_record_realtime_event.up.sql
-- INSERT ... RETURNING on realtime_events requires SELECT on the new row.
-- Customer restrictive SELECT blocked staff-visible event recording.
-- Persist events via SECURITY DEFINER so customer writes can notify staff
-- without granting customers a tenant event feed.
BEGIN;

CREATE OR REPLACE FUNCTION record_realtime_event(p_restaurant uuid, p_type text, p_payload jsonb)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_seq bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_restaurant::text, 0));
  INSERT INTO realtime_events (restaurant_id, seq, event_type, payload)
  SELECT p_restaurant, COALESCE(MAX(seq), 0) + 1, p_type, COALESCE(p_payload, '{}'::jsonb)
    FROM realtime_events WHERE restaurant_id = p_restaurant
  RETURNING seq INTO new_seq;
  RETURN new_seq;
END;
$$;

REVOKE ALL ON FUNCTION record_realtime_event(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_realtime_event(uuid, text, jsonb) TO nesta_app;

COMMIT;
