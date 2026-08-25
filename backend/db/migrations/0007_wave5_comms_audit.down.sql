-- 0007_wave5_comms_audit.down.sql — reverses 0007, children first.
BEGIN;

DROP TABLE IF EXISTS discount_claims;
DROP TABLE IF EXISTS import_history;
DROP TABLE IF EXISTS approvals;
DROP TABLE IF EXISTS customer_notes;
DROP TABLE IF EXISTS feedback;
DROP TABLE IF EXISTS system_alerts;
DROP TABLE IF EXISTS notifications_log;
DROP TABLE IF EXISTS activity_logs;
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS chat_messages;
DROP TABLE IF EXISTS chats;

COMMIT;
