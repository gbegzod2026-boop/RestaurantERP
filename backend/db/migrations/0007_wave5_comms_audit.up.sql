-- 0007_wave5_comms_audit.up.sql
-- Wave 5 — communications, logging and claims: chats (+ messages),
-- activity_logs, audit_log, notifications_log, system_alerts, feedback,
-- customer_notes, approvals, discount_claims, import_history.
--
-- Depends on 0004 (apply_tenant_rls, customers, orders).
--
-- Two findings from the live scan shaped this wave:
--
--  1. THE AUDIT NAMING COLLISION. Three different trees log "what happened",
--     written by different parts of the app and never reconciled:
--         restaurants/$restId/auditLog     (backend, auditLog.js)
--         restaurants/$restId/audit_log    (admin frontend, admin.js)
--         restaurants/$restId/activityLogs (operational UI feed)
--     They are NOT merged here. auditLog and audit_log both become
--     `audit_log` rows distinguished by a `source_tree` column, because they
--     are the same kind of security record written by two code paths; merging
--     them without that column would make it impossible to tell which writer
--     produced an entry. activityLogs stays its own table: it is a
--     user-facing activity feed, not a security audit trail, and conflating
--     the two would corrupt both.
--
--  2. discountClaims DOES NOT EXIST in the live database. database.rules.json
--     defines rules for a root `discountClaims` node and claimsService.js
--     reads and transacts against it, but the root has no data at all. The
--     table is still created — the code path is live and will write to it —
--     but the migration will find zero records, and that is a finding worth
--     stating rather than an omission.
BEGIN;

-- ── chats / chat_messages ─────────────────────────────────────────────────
-- Firebase: restaurants/$restId/chats/$chatId/{meta,messages/$pushId} plus
-- the named channels admin_chef_$chefId and superadmin_chat. The channel
-- identity is data, not schema, so it is a column.
CREATE TABLE chats (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id    text,
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  chat_kind         text NOT NULL DEFAULT 'internal'
                      CHECK (chat_kind IN ('internal','admin_chef','superadmin','support','other')),
  title             text,
  participants      jsonb NOT NULL DEFAULT '[]'::jsonb,
  meta              jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_message_at   timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
CREATE INDEX idx_chats_restaurant_kind ON chats (restaurant_id, chat_kind);
CREATE INDEX idx_chats_last_message ON chats (restaurant_id, last_message_at DESC NULLS LAST);

CREATE TABLE chat_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id  text,
  chat_id         uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  sender_id       text,
  sender_name     text,
  sender_role     text,
  body            text,
  sent_at         timestamptz NOT NULL,
  read_by         jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (chat_id, legacy_rtdb_id)
);
CREATE INDEX idx_chat_messages_chat_sent ON chat_messages (chat_id, sent_at DESC);
CREATE INDEX idx_chat_messages_restaurant_id ON chat_messages (restaurant_id);

-- ── audit_log ─────────────────────────────────────────────────────────────
-- Sources: restaurants/$restId/auditLog (backend) and .../audit_log
-- (frontend). source_tree records which, so the collision described in the
-- header stays visible instead of being flattened away.
-- Queried live with orderByChild('createdAt').limitToLast(n), hence the
-- (restaurant_id, created_at DESC) index.
CREATE TABLE audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id  text,
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  source_tree     text NOT NULL CHECK (source_tree IN ('auditLog','audit_log')),
  action          text NOT NULL,
  entity_type     text,
  entity_id       text,
  actor_id        text,
  actor_name      text,
  actor_role      text,
  ip_address      text,
  before_state    jsonb,
  after_state     jsonb,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL,
  UNIQUE (restaurant_id, source_tree, legacy_rtdb_id)
);
CREATE INDEX idx_audit_log_restaurant_created ON audit_log (restaurant_id, created_at DESC);
CREATE INDEX idx_audit_log_action ON audit_log (restaurant_id, action);
CREATE INDEX idx_audit_log_entity ON audit_log (restaurant_id, entity_type, entity_id);

-- ── activity_logs ─────────────────────────────────────────────────────────
-- Firebase: restaurants/$restId/activityLogs/$pushId — 658 live records, the
-- largest per-restaurant log tree. Queried with
-- orderByChild('createdAt').limitToLast(150|100).
CREATE TABLE activity_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id  text,
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  activity_type   text,
  message         text,
  actor_id        text,
  actor_name      text,
  entity_type     text,
  entity_id       text,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL,
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
CREATE INDEX idx_activity_logs_restaurant_created ON activity_logs (restaurant_id, created_at DESC);
CREATE INDEX idx_activity_logs_type ON activity_logs (restaurant_id, activity_type);

-- ── notifications_log / system_alerts ─────────────────────────────────────
CREATE TABLE notifications_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id    text,
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  channel           text,
  recipient         text,
  subject           text,
  body              text,
  status            text,
  sent_at           timestamptz,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
CREATE INDEX idx_notifications_log_restaurant_sent ON notifications_log (restaurant_id, sent_at DESC NULLS LAST);

-- Firebase: restaurants/$restId/systemAlerts/$type — keyed by alert TYPE, so
-- there is at most one live alert per type per restaurant.
CREATE TABLE system_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  alert_type      text NOT NULL,
  severity        text,
  message         text,
  active          boolean NOT NULL DEFAULT true,
  raised_at       timestamptz,
  cleared_at      timestamptz,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (restaurant_id, alert_type)
);
CREATE INDEX idx_system_alerts_restaurant_active ON system_alerts (restaurant_id, active);

-- ── feedback / customer_notes / approvals ─────────────────────────────────
CREATE TABLE feedback (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id  text,
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_id        uuid REFERENCES orders(id) ON DELETE SET NULL,
  legacy_order_id text,
  customer_id     uuid REFERENCES customers(id) ON DELETE SET NULL,
  rating          integer CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
  comment         text,
  resolved        boolean NOT NULL DEFAULT false,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
CREATE INDEX idx_feedback_restaurant_created ON feedback (restaurant_id, created_at DESC);
CREATE INDEX idx_feedback_order ON feedback (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX idx_feedback_customer ON feedback (customer_id) WHERE customer_id IS NOT NULL;

-- Firebase: restaurants/$restId/customerNotes/$phoneKey/$pushId — the phone
-- key resolves to a customers FK, with the raw key retained for traceability.
CREATE TABLE customer_notes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id    text,
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_id       uuid REFERENCES customers(id) ON DELETE CASCADE,
  legacy_phone_key  text NOT NULL,
  body              text,
  author_id         text,
  author_name       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_phone_key, legacy_rtdb_id)
);
CREATE INDEX idx_customer_notes_customer ON customer_notes (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_customer_notes_restaurant_id ON customer_notes (restaurant_id);

CREATE TABLE approvals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id  text,
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  request_kind    text,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected','cancelled','unknown')),
  status_raw      text,
  requested_by    text,
  resolved_by     text,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
CREATE INDEX idx_approvals_restaurant_status ON approvals (restaurant_id, status);

-- ── import_history ────────────────────────────────────────────────────────
-- Firebase: restaurants/$restId/importHistory/$pushId (AI menu import runs).
CREATE TABLE import_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id  text,
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  import_kind     text,
  source_name     text,
  rows_total      integer,
  rows_imported   integer,
  rows_failed     integer,
  performed_by    text,
  performed_at    timestamptz,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
CREATE INDEX idx_import_history_restaurant_performed ON import_history (restaurant_id, performed_at DESC NULLS LAST);

-- ── discount_claims ───────────────────────────────────────────────────────
-- Firebase: discountClaims/$restId/$token — a ROOT-level tree, not under
-- restaurants/. Currently EMPTY in production (see file header), but
-- claimsService.js actively reads and transacts against it.
--
-- The RTDB code guards claiming with runTransaction on the token. Here the
-- token's primary-key uniqueness plus the usage_count/status columns do that
-- job, which is precisely the kind of hand-rolled concurrency control the
-- database should own.
CREATE TABLE discount_claims (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  token           text NOT NULL,
  status          text NOT NULL DEFAULT 'unclaimed'
                    CHECK (status IN ('unclaimed','available','exhausted','expired','revoked','unknown')),
  status_raw      text,
  customer_id     uuid REFERENCES customers(id) ON DELETE SET NULL,
  claimed_phone   text,
  order_id        uuid REFERENCES orders(id) ON DELETE SET NULL,
  legacy_order_id text,
  discount_percent numeric(5,2) CHECK (discount_percent IS NULL OR (discount_percent >= 0 AND discount_percent <= 100)),
  usage_count     integer NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  usage_limit     integer,
  issued_at       timestamptz,
  claimed_at      timestamptz,
  expires_at      timestamptz,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (restaurant_id, token)
);
CREATE INDEX idx_discount_claims_restaurant_status ON discount_claims (restaurant_id, status);
CREATE INDEX idx_discount_claims_customer ON discount_claims (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_discount_claims_order ON discount_claims (order_id) WHERE order_id IS NOT NULL;

-- ── RLS + grants ──────────────────────────────────────────────────────────
SELECT apply_tenant_rls('chats');
SELECT apply_tenant_rls('chat_messages');
SELECT apply_tenant_rls('audit_log');
SELECT apply_tenant_rls('activity_logs');
SELECT apply_tenant_rls('notifications_log');
SELECT apply_tenant_rls('system_alerts');
SELECT apply_tenant_rls('feedback');
SELECT apply_tenant_rls('customer_notes');
SELECT apply_tenant_rls('approvals');
SELECT apply_tenant_rls('import_history');
SELECT apply_tenant_rls('discount_claims');

COMMIT;
