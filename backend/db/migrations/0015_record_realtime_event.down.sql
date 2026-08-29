-- 0015_record_realtime_event.down.sql
BEGIN;
DROP FUNCTION IF EXISTS record_realtime_event(uuid, text, jsonb);
COMMIT;
