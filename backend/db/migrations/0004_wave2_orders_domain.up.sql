-- 0004_wave2_orders_domain.up.sql
-- Wave 2 — the orders domain: customers (+ addresses), orders, order_items,
-- order_status_history, order_timeline, order_change_requests, order_chats
-- (+ messages), payments, couriers, courier_assignments, reservations
-- (+ reservation_slots), waiter_calls.
--
-- A NEW migration; 0001–0003 are untouched (same rule Wave 1 followed).
--
-- ─────────────────────────────────────────────────────────────────────────
-- EVERY design decision below is grounded in a full read of the live RTDB
-- performed by db/scripts/firebase-discover*.mjs, not in the audit docs.
-- The raw evidence is committed under docs/migration-reports/. The findings
-- that actually shaped this schema:
--
--  * Order status is FOUR overlapping fields, mixing machine keys with
--    Uzbek/Russian display text in the SAME column:
--        status      -> to'landi(34) order_created(14) served(6)
--                       tayyorlanmoqda(3) completed(1) ready(1)
--        statusKey   -> completed(35) order_created(14) served(6)
--                       cooking(3) ready(1)
--        statusV2    -> completed(35) order_created(12) served(5)
--        statusLabel -> localized display text, 7 variants incl. Russian
--    Plus statusHistory child keys that appear in NO status field at all:
--    payment, picked_up, preparing. The canonical set below is the union,
--    and docs/STATUS_MIGRATION_MAP.md is the authoritative mapping.
--
--  * payment.method holds the same concept in two languages:
--    Naqd(29) / cash(13), plus Payme(4) / Click(1). Normalized into
--    payments.method with the untouched original kept in method_raw.
--
--  * Money: every money field in all 46 restaurants was scanned. Maximum
--    observed precision is ONE decimal place, no negatives, max magnitude
--    10,000,000. numeric(14,2) is therefore provably lossless for the
--    current dataset (see docs/MONEY_MIGRATION_POLICY.md).
--
--  * Customers are keyed by phone (8/8 keys phone-shaped), so they get a
--    surrogate uuid PK plus normalized_phone, per Phase 1 requirement #7.
--
--  * orders.deliveryAddress is genuinely polymorphic in production — it is
--    an object for most orders but a bare string for some (a free-text
--    address someone typed). Stored as jsonb so BOTH shapes survive intact
--    rather than one of them being dropped to fit a column.
-- ─────────────────────────────────────────────────────────────────────────
BEGIN;

-- ── RLS helper ────────────────────────────────────────────────────────────
-- Waves 0–1 hand-wrote four near-identical policies per table (~25 lines
-- each). That is fine for 6 tables and a liability for 40: every copy is a
-- chance to typo a column name or silently omit the WITH CHECK half of an
-- UPDATE policy, which would open a cross-tenant write hole that still
-- passes a SELECT-only RLS test.
--
-- This function emits exactly the same policy text Waves 0–1 use (identical
-- NULLIF-guarded cast, identical platform-context escape hatch where the
-- setting is empty), just generated instead of transcribed. It is a DDL
-- helper only — never called at runtime.
CREATE OR REPLACE FUNCTION apply_tenant_rls(p_table text, p_tenant_col text DEFAULT 'restaurant_id')
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  pred text := format(
    $p$current_setting('app.current_restaurant_id', true) = ''
       OR %I = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid$p$,
    p_tenant_col
  );
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)', p_table || '_select', p_table, pred);
  EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s)', p_table || '_insert', p_table, pred);
  EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (%s) WITH CHECK (%s)', p_table || '_update', p_table, pred, pred);
  EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (%s)', p_table || '_delete', p_table, pred);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO nesta_app', p_table);
END;
$fn$;

-- Same idea for child tables that carry no tenant column of their own and
-- inherit visibility through a parent (the combo_items pattern from Wave 1).
CREATE OR REPLACE FUNCTION apply_inherited_rls(p_table text, p_fk_col text, p_parent text)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  pred text := format(
    $p$current_setting('app.current_restaurant_id', true) = ''
       OR %I IN (SELECT id FROM %I WHERE restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid)$p$,
    p_fk_col, p_parent
  );
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)', p_table || '_select', p_table, pred);
  EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s)', p_table || '_insert', p_table, pred);
  EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (%s) WITH CHECK (%s)', p_table || '_update', p_table, pred, pred);
  EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (%s)', p_table || '_delete', p_table, pred);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO nesta_app', p_table);
END;
$fn$;

-- ── customers ─────────────────────────────────────────────────────────────
-- Firebase: restaurants/$restId/customers/$phoneKey
-- Live keys are 8/8 phone-shaped ("+998902651475"), and the record's own
-- `id` field repeats the phone. Phase 1 requirement #7: phone must NOT be
-- the primary key.
--
-- Three phone columns, each with a distinct job — this is deliberate, not
-- redundancy:
--   legacy_rtdb_id      the RTDB key EXACTLY as it appears (may be
--                       percent-encoded: "%2B998..."), so the migration is
--                       idempotent and a row can always be traced back.
--   original_phone_key  the decoded-but-unnormalized key, so a human can
--                       see what was really there.
--   normalized_phone    digits-only E.164-ish form, the tenant-scoped
--                       uniqueness key the application should match on.
-- normalized_phone is nullable: a key that cannot be parsed as a phone must
-- still migrate (rule #20 — never invent data), it just does not
-- participate in the unique index.
CREATE TABLE customers (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id            text,
  restaurant_id             uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  original_phone_key        text,
  normalized_phone          text CHECK (normalized_phone IS NULL OR normalized_phone ~ '^\+?[0-9]{6,20}$'),
  name                      text,
  notes                     text,
  status                    text,
  personal_discount         numeric(5,2) NOT NULL DEFAULT 0 CHECK (personal_discount >= 0 AND personal_discount <= 100),
  personal_discount_reason  text,
  personal_discount_source  text,
  personal_discount_set_at  timestamptz,
  discount_percent          numeric(5,2) CHECK (discount_percent IS NULL OR (discount_percent >= 0 AND discount_percent <= 100)),
  total_spent               numeric(14,2) NOT NULL DEFAULT 0,
  orders_count              integer NOT NULL DEFAULT 0 CHECK (orders_count >= 0),
  visits                    integer NOT NULL DEFAULT 0 CHECK (visits >= 0),
  last_visit                timestamptz,
  loyalty_level             text,
  loyalty_points            numeric(14,2) NOT NULL DEFAULT 0,
  loyalty_card              jsonb,
  is_vip                    boolean NOT NULL DEFAULT false,
  vip_discount_percent      numeric(5,2),
  vip_orders_total          numeric(14,2) NOT NULL DEFAULT 0,
  -- Anything present in RTDB that has no column here is preserved verbatim
  -- rather than dropped — "no silent data loss" is an acceptance criterion,
  -- and this is the escape valve that makes it true for a tree nobody has a
  -- complete field list for.
  extra                     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
-- Tenant-scoped, not global: the same person may be a customer of two
-- different restaurants on this platform and those are legitimately two
-- rows. Partial, because normalized_phone is nullable for unparseable keys.
CREATE UNIQUE INDEX uq_customers_restaurant_phone
  ON customers (restaurant_id, normalized_phone)
  WHERE normalized_phone IS NOT NULL;
CREATE INDEX idx_customers_restaurant_id ON customers (restaurant_id);
CREATE INDEX idx_customers_last_visit ON customers (restaurant_id, last_visit DESC NULLS LAST);
CREATE TRIGGER trg_customers_updated_at BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── customer_addresses ────────────────────────────────────────────────────
-- Firebase: restaurants/$restId/customers/$phoneKey/savedAddresses/$pushId
-- (client.js writes/deletes these individually, so they are a real entity,
-- not a blob).
CREATE TABLE customer_addresses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id  text,
  customer_id     uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  label           text,
  street          text,
  house           text,
  apartment       text,
  entrance        text,
  floor           text,
  door_code       text,
  landmark        text,
  city            text,
  district        text,
  comment         text,
  lat             numeric(10,7),
  lng             numeric(10,7),
  raw             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, legacy_rtdb_id)
);
CREATE INDEX idx_customer_addresses_customer_id ON customer_addresses (customer_id);
CREATE INDEX idx_customer_addresses_restaurant_id ON customer_addresses (restaurant_id);

-- ── couriers ──────────────────────────────────────────────────────────────
-- Firebase: restaurants/$restId/couriers/$courierId. Live status values:
-- online(3), offline(2). A courier is frequently also an employees row
-- (role='courier'), hence the optional employee_id link.
CREATE TABLE couriers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id  text,
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  employee_id     uuid REFERENCES employees(id) ON DELETE SET NULL,
  name            text,
  phone           text,
  status          text NOT NULL DEFAULT 'offline',
  vehicle_type    text,
  active          boolean NOT NULL DEFAULT true,
  extra           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
CREATE INDEX idx_couriers_restaurant_id ON couriers (restaurant_id);
CREATE INDEX idx_couriers_employee_id ON couriers (employee_id) WHERE employee_id IS NOT NULL;
CREATE TRIGGER trg_couriers_updated_at BEFORE UPDATE ON couriers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── orders ────────────────────────────────────────────────────────────────
-- Firebase: restaurants/$restId/orders/$pushId (59 live orders, all push-id
-- keyed, across 3 restaurants).
--
-- status: canonical, CHECK-constrained. Waves 0–1 deliberately left status
-- unconstrained because the full value set was unknown and a CHECK might
-- reject real legacy data. That reasoning was correct then; it no longer
-- applies, because firebase-discover-enums.mjs enumerated EVERY status value
-- in EVERY restaurant (not a sample). The canonical set below is the union
-- of all four status fields plus all statusHistory child keys. The migration
-- maps into it via docs/STATUS_MIGRATION_MAP.md and REPORTS anything
-- unmapped instead of coercing it (requirement #9).
--
-- The four original values are all retained verbatim in status_raw /
-- status_key_raw / status_v2_raw / status_label_raw. Nothing is destroyed by
-- normalization — a reviewer can always reconstruct exactly what RTDB said.
CREATE TABLE orders (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id          text,
  restaurant_id           uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,

  order_number            integer,
  order_type              text NOT NULL DEFAULT 'dine_in'
                            CHECK (order_type IN ('dine_in','delivery','takeaway','pickup','unknown')),
  source                  text,

  table_id                uuid REFERENCES tables(id) ON DELETE SET NULL,
  table_label             text,   -- raw RTDB `table` value ("4"), kept even when the FK cannot resolve
  waiter_id               uuid REFERENCES employees(id) ON DELETE SET NULL,
  chef_id                 uuid REFERENCES employees(id) ON DELETE SET NULL,
  created_by_employee_id  uuid REFERENCES employees(id) ON DELETE SET NULL,
  customer_id             uuid REFERENCES customers(id) ON DELETE SET NULL,
  courier_id              uuid REFERENCES couriers(id) ON DELETE SET NULL,

  -- Denormalized customer identity AT ORDER TIME. Not redundant with the
  -- customers FK: the customer may later rename, change phone, or be
  -- deleted, and a historical order must still show who it was for.
  customer_name_snapshot  text,
  customer_phone_snapshot text,

  status                  text NOT NULL DEFAULT 'order_created'
                            CHECK (status IN (
                              'order_created','confirmed','cooking','ready','picked_up',
                              'served','payment_requested','paid','completed','cancelled','unknown'
                            )),
  status_raw              text,
  status_key_raw          text,
  status_v2_raw           text,
  status_label_raw        text,

  subtotal                numeric(14,2) NOT NULL DEFAULT 0,
  discount_amount         numeric(14,2) NOT NULL DEFAULT 0,
  discount_percent        numeric(5,2) CHECK (discount_percent IS NULL OR (discount_percent >= 0 AND discount_percent <= 100)),
  discount_source         text,
  discount_reason         text,
  service_fee_amount      numeric(14,2) NOT NULL DEFAULT 0,
  delivery_fee            numeric(14,2) NOT NULL DEFAULT 0,
  fast_fee_amount         numeric(14,2) NOT NULL DEFAULT 0,
  original_total          numeric(14,2) NOT NULL DEFAULT 0,
  total                   numeric(14,2) NOT NULL DEFAULT 0,

  payment_status          text NOT NULL DEFAULT 'unpaid'
                            CHECK (payment_status IN ('unpaid','pending','paid','refunded','partial','unknown')),
  payment_method          text,

  -- Polymorphic in production (object for structured addresses, bare string
  -- for typed-in ones). jsonb preserves both without inventing structure.
  delivery_address        jsonb,
  delivery_type           text,
  is_delivery             boolean NOT NULL DEFAULT false,

  notes                   text,
  priority                boolean NOT NULL DEFAULT false,
  loyalty_level           text,
  loyalty_visits          integer,
  loyalty_auto_applied    boolean NOT NULL DEFAULT false,
  inventory_deducted      boolean NOT NULL DEFAULT false,
  chef_score_awarded      boolean NOT NULL DEFAULT false,

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  confirmed_at            timestamptz,
  cooking_started_at      timestamptz,
  ready_at                timestamptz,
  served_at               timestamptz,
  delivered_at            timestamptz,
  paid_at                 timestamptz,
  cancelled_at            timestamptz,

  extra                   jsonb NOT NULL DEFAULT '{}'::jsonb,

  UNIQUE (restaurant_id, legacy_rtdb_id),
  CHECK (total >= 0 AND original_total >= 0 AND discount_amount >= 0)
);
-- Order numbers are generated by two SEPARATE RTDB counters
-- (meta/orderCounterOrd for dine-in, meta/orderCounterDvr for delivery), so
-- the same number legitimately appears twice in one restaurant under
-- different order types. Uniqueness is therefore per (restaurant, type,
-- number), not per (restaurant, number) — asserting the latter would fail
-- against real data.
CREATE UNIQUE INDEX uq_orders_restaurant_type_number
  ON orders (restaurant_id, order_type, order_number)
  WHERE order_number IS NOT NULL;
CREATE INDEX idx_orders_restaurant_created ON orders (restaurant_id, created_at DESC);
CREATE INDEX idx_orders_restaurant_status ON orders (restaurant_id, status);
CREATE INDEX idx_orders_customer_id ON orders (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_orders_table_id ON orders (table_id) WHERE table_id IS NOT NULL;
CREATE INDEX idx_orders_waiter_id ON orders (waiter_id) WHERE waiter_id IS NOT NULL;
CREATE INDEX idx_orders_chef_id ON orders (chef_id) WHERE chef_id IS NOT NULL;
CREATE INDEX idx_orders_courier_id ON orders (courier_id) WHERE courier_id IS NOT NULL;
CREATE INDEX idx_orders_created_by_employee_id ON orders (created_by_employee_id) WHERE created_by_employee_id IS NOT NULL;
CREATE INDEX idx_orders_payment_status ON orders (restaurant_id, payment_status);
CREATE TRIGGER trg_orders_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── order_items ───────────────────────────────────────────────────────────
-- Firebase: restaurants/$restId/orders/$orderId/items/$compositeKey where
-- the key is "{menuItemId}__{timestampMs}" (or "combo_{id}__{ts}", or a bare
-- "combo_{id}") — the same dish added twice gets two keys, so the composite
-- key IS the item identity and is preserved as legacy_rtdb_id.
--
-- SNAPSHOT SEMANTICS (Phase 1 requirement #5). name_snapshot / price_snapshot
-- record the dish AS IT WAS SOLD. menu_item_id is only a soft pointer for
-- reporting. Repricing or renaming a dish tomorrow must not retroactively
-- alter a receipt from last month, so nothing in this table is ever
-- recomputed from menu_items.
--
-- name_snapshot is jsonb because menu item names are {uz,ru,en} objects in
-- this app, but some order lines carry a plain string. Storing the raw JSON
-- value keeps both shapes exactly as sold instead of forcing a lossy pick.
--
-- menu_item_id is ON DELETE RESTRICT, deliberately unlike combo_items'
-- CASCADE (see 0002's note): deleting a dish must never quietly remove a
-- line from a historical order. Deleting a whole restaurant still works,
-- because orders/order_items cascade from restaurants first.
CREATE TABLE order_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id    text,
  order_id          uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  menu_item_id      uuid REFERENCES menu_items(id) ON DELETE RESTRICT,
  legacy_menu_id    text,          -- raw RTDB menu id, kept even when unresolvable

  name_snapshot     jsonb NOT NULL,
  price_snapshot    numeric(14,2) NOT NULL DEFAULT 0 CHECK (price_snapshot >= 0),
  qty               numeric(12,3) NOT NULL DEFAULT 1 CHECK (qty > 0),
  line_total        numeric(14,2) NOT NULL DEFAULT 0 CHECK (line_total >= 0),

  -- Chosen options as sold. Immutable snapshots for the same reason as
  -- price: today's modifier list must not rewrite last month's receipt.
  modifiers         jsonb NOT NULL DEFAULT '[]'::jsonb,
  extras            jsonb NOT NULL DEFAULT '[]'::jsonb,
  variant_snapshot  jsonb,

  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','cooking','ready','delivered','served','cancelled','unknown')),
  status_raw        text,
  kitchen_status    text,
  is_combo          boolean NOT NULL DEFAULT false,
  notes             text,
  extra             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, legacy_rtdb_id)
);
CREATE INDEX idx_order_items_order_id ON order_items (order_id);
CREATE INDEX idx_order_items_restaurant_id ON order_items (restaurant_id);
CREATE INDEX idx_order_items_menu_item_id ON order_items (menu_item_id) WHERE menu_item_id IS NOT NULL;

-- ── order_status_history ──────────────────────────────────────────────────
-- Firebase: restaurants/$restId/orders/$orderId/statusHistory — an OBJECT
-- keyed by status name whose value is the timestamp (sometimes an object
-- with more detail). Child keys observed live include payment, picked_up and
-- preparing, which never appear in any status field, so this tree is a real
-- source of states the order record alone does not reveal.
--
-- Because RTDB keys are unique per status, the same status cannot repeat in
-- the source data; the unique constraint mirrors that and makes the
-- migration idempotent on re-run.
CREATE TABLE order_status_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  status          text NOT NULL,
  status_raw      text,
  changed_at      timestamptz NOT NULL,
  changed_by      text,
  source          text NOT NULL DEFAULT 'rtdb_status_history',
  detail          jsonb,
  UNIQUE (order_id, status_raw, changed_at)
);
CREATE INDEX idx_order_status_history_order_id ON order_status_history (order_id);
CREATE INDEX idx_order_status_history_restaurant_id ON order_status_history (restaurant_id);
CREATE INDEX idx_order_status_history_changed_at ON order_status_history (restaurant_id, changed_at DESC);

-- ── order_timeline ────────────────────────────────────────────────────────
-- Firebase: restaurants/$restId/orderTimeline/$orderId/$pushId — a separate
-- tree from statusHistory, holding richer UI events
-- (order_sent_to_kitchen, order_served, payment_requested, …).
CREATE TABLE order_timeline (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id  text,
  order_id        uuid REFERENCES orders(id) ON DELETE CASCADE,
  legacy_order_id text NOT NULL,     -- kept so timeline for a missing order is still migratable
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  event_type      text NOT NULL,
  actor_id        text,
  actor_name      text,
  message         text,
  occurred_at     timestamptz NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (restaurant_id, legacy_order_id, legacy_rtdb_id)
);
CREATE INDEX idx_order_timeline_order_id ON order_timeline (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX idx_order_timeline_restaurant_occurred ON order_timeline (restaurant_id, occurred_at DESC);

-- ── order_change_requests ─────────────────────────────────────────────────
-- Firebase: restaurants/$restId/orderChangeRequests/$pushId. Live values:
-- requestType cancel_item(3) / replace_item(1); status approved(4).
-- The wider set below comes from the guarded runTransaction in shared.js
-- (approve/reject paths), which proves pending/rejected are reachable even
-- though no example is currently stored.
CREATE TABLE order_change_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id    text,
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_id          uuid REFERENCES orders(id) ON DELETE CASCADE,
  legacy_order_id   text,
  order_item_id     uuid REFERENCES order_items(id) ON DELETE SET NULL,
  legacy_item_key   text,
  request_type      text NOT NULL CHECK (request_type IN ('cancel_item','replace_item','change_qty','cancel_order','other')),
  request_type_raw  text,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled','unknown')),
  status_raw        text,
  requested_by      text,
  resolved_by       text,
  reason            text,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
CREATE INDEX idx_order_change_requests_order_id ON order_change_requests (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX idx_order_change_requests_restaurant_status ON order_change_requests (restaurant_id, status);

-- ── order_chats / order_chat_messages ─────────────────────────────────────
-- Firebase: restaurants/$restId/orderChats/$orderId/{chef}/meta and
-- .../messages/$pushId. The middle segment is a channel name (only "chef"
-- observed live, but the path shape allows others), so it becomes a column
-- rather than being hardcoded into the table name.
CREATE TABLE order_chats (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_id          uuid REFERENCES orders(id) ON DELETE CASCADE,
  legacy_order_id   text NOT NULL,
  channel           text NOT NULL DEFAULT 'chef',
  meta              jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_message_at   timestamptz,
  unread_count      integer NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_order_id, channel)
);
CREATE INDEX idx_order_chats_order_id ON order_chats (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX idx_order_chats_restaurant_id ON order_chats (restaurant_id);

CREATE TABLE order_chat_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id  text,
  order_chat_id   uuid NOT NULL REFERENCES order_chats(id) ON DELETE CASCADE,
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  sender_id       text,
  sender_name     text,
  sender_role     text,
  body            text,
  sent_at         timestamptz NOT NULL,
  read_by         jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (order_chat_id, legacy_rtdb_id)
);
CREATE INDEX idx_order_chat_messages_chat ON order_chat_messages (order_chat_id, sent_at DESC);
CREATE INDEX idx_order_chat_messages_restaurant_id ON order_chat_messages (restaurant_id);

-- ── payments ──────────────────────────────────────────────────────────────
-- Firebase: restaurants/$restId/orders/$orderId/payment — a single embedded
-- object today, promoted to its own table because (a) split/partial payment
-- is already visible in the data (finalTotal separate from order total), and
-- (b) payment.paid is mutated by its own guarded runTransaction, i.e. the
-- app already treats it as an independent unit of state.
--
-- method is normalized; the original string is kept in method_raw because
-- production stores the same concept as both "Naqd"(29) and "cash"(13).
CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id      text,
  restaurant_id       uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_id            uuid REFERENCES orders(id) ON DELETE CASCADE,
  legacy_order_id     text,
  method              text NOT NULL DEFAULT 'unknown'
                        CHECK (method IN ('cash','card','payme','click','uzum','transfer','mixed','pending','unknown')),
  method_raw          text,
  amount              numeric(14,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  service_fee_amount  numeric(14,2) NOT NULL DEFAULT 0,
  final_total         numeric(14,2),
  paid                boolean NOT NULL DEFAULT false,
  paid_at             timestamptz,
  requested           boolean NOT NULL DEFAULT false,
  approved            boolean NOT NULL DEFAULT false,
  admin_notified      boolean NOT NULL DEFAULT false,
  cashier_id          uuid REFERENCES employees(id) ON DELETE SET NULL,
  legacy_cashier      text,
  paid_by_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  external_tx_id      text,
  extra               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_order_id, legacy_rtdb_id)
);
CREATE INDEX idx_payments_order_id ON payments (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX idx_payments_restaurant_paid_at ON payments (restaurant_id, paid_at DESC NULLS LAST);
CREATE INDEX idx_payments_cashier_id ON payments (cashier_id) WHERE cashier_id IS NOT NULL;
CREATE INDEX idx_payments_paid_by_employee_id ON payments (paid_by_employee_id) WHERE paid_by_employee_id IS NOT NULL;

-- ── courier_assignments ───────────────────────────────────────────────────
-- Firebase: restaurants/$restId/courierAssignments/$pushId, queried live by
-- orderByChild('orderId').equalTo(...) — hence the (restaurant_id, order_id)
-- index below is required, not speculative.
CREATE TABLE courier_assignments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id    text,
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_id          uuid REFERENCES orders(id) ON DELETE CASCADE,
  legacy_order_id   text,
  courier_id        uuid REFERENCES couriers(id) ON DELETE SET NULL,
  legacy_courier_id text,
  status            text NOT NULL DEFAULT 'assigned'
                      CHECK (status IN ('assigned','accepted','heading_to_restaurant','picked_up','delivering','delivered','cancelled','unknown')),
  status_raw        text,
  sub_stage         text,
  assigned_at       timestamptz,
  accepted_at       timestamptz,
  picked_up_at      timestamptz,
  delivered_at      timestamptz,
  kpi_calculated    boolean NOT NULL DEFAULT false,
  stage_timestamps  jsonb NOT NULL DEFAULT '{}'::jsonb,
  extra             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
CREATE INDEX idx_courier_assignments_order ON courier_assignments (restaurant_id, order_id);
CREATE INDEX idx_courier_assignments_courier ON courier_assignments (courier_id) WHERE courier_id IS NOT NULL;
CREATE INDEX idx_courier_assignments_status ON courier_assignments (restaurant_id, status);
CREATE TRIGGER trg_courier_assignments_updated_at BEFORE UPDATE ON courier_assignments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── reservations / reservation_slots ──────────────────────────────────────
-- Firebase: restaurants/$restId/reservations/$pushId. Live status values:
-- no_show(2), pending(2), completed(1), seated(1).
CREATE TABLE reservations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id    text,
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_id          uuid REFERENCES tables(id) ON DELETE SET NULL,
  legacy_table_key  text,
  customer_id       uuid REFERENCES customers(id) ON DELETE SET NULL,
  customer_name     text,
  customer_phone    text,
  guests            integer CHECK (guests IS NULL OR guests > 0),
  -- The RTDB record carries a date string and a time string separately;
  -- both are preserved as typed columns plus a combined timestamptz so
  -- range queries are indexable.
  reserved_date     date,
  reserved_time     time,
  reserved_at       timestamptz,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','confirmed','seated','completed','no_show','cancelled','unknown')),
  status_raw        text,
  source            text,
  notes             text,
  extra             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
CREATE INDEX idx_reservations_restaurant_date ON reservations (restaurant_id, reserved_date);
CREATE INDEX idx_reservations_table_id ON reservations (table_id) WHERE table_id IS NOT NULL;
CREATE INDEX idx_reservations_customer_id ON reservations (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_reservations_status ON reservations (restaurant_id, status);
CREATE TRIGGER trg_reservations_updated_at BEFORE UPDATE ON reservations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Firebase: restaurants/$restId/reservationSlots/{date}_{time}_{tableNumber}
-- claimed via runTransaction. That composite string key is exactly the
-- double-booking guard, so it becomes a real unique constraint on typed
-- columns — the transaction is replaced by the database, which is the whole
-- point of the migration.
CREATE TABLE reservation_slots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id  text,
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  slot_date       date NOT NULL,
  slot_time       time NOT NULL,
  table_number    integer NOT NULL,
  reservation_id  uuid REFERENCES reservations(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, slot_date, slot_time, table_number)
);
CREATE INDEX idx_reservation_slots_reservation ON reservation_slots (reservation_id) WHERE reservation_id IS NOT NULL;
CREATE INDEX idx_reservation_slots_restaurant_id ON reservation_slots (restaurant_id);

-- ── waiter_calls ──────────────────────────────────────────────────────────
-- Firebase: restaurants/$restId/waiterCalls/$pushId
CREATE TABLE waiter_calls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id  text,
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_id        uuid REFERENCES tables(id) ON DELETE SET NULL,
  legacy_table_key text,
  order_id        uuid REFERENCES orders(id) ON DELETE SET NULL,
  call_type       text,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved','cancelled','unknown')),
  status_raw      text,
  handled_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  extra           jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
CREATE INDEX idx_waiter_calls_restaurant_status ON waiter_calls (restaurant_id, status);
CREATE INDEX idx_waiter_calls_table_id ON waiter_calls (table_id) WHERE table_id IS NOT NULL;
CREATE INDEX idx_waiter_calls_order_id ON waiter_calls (order_id) WHERE order_id IS NOT NULL;

-- ── Row-Level Security + grants ───────────────────────────────────────────
-- Every table here owns a restaurant_id, so all of them use the direct
-- tenant policy. order_chat_messages also carries restaurant_id (denormalized
-- on purpose) so it does not need the slower inherited-subquery form.
SELECT apply_tenant_rls('customers');
SELECT apply_tenant_rls('customer_addresses');
SELECT apply_tenant_rls('couriers');
SELECT apply_tenant_rls('orders');
SELECT apply_tenant_rls('order_items');
SELECT apply_tenant_rls('order_status_history');
SELECT apply_tenant_rls('order_timeline');
SELECT apply_tenant_rls('order_change_requests');
SELECT apply_tenant_rls('order_chats');
SELECT apply_tenant_rls('order_chat_messages');
SELECT apply_tenant_rls('payments');
SELECT apply_tenant_rls('courier_assignments');
SELECT apply_tenant_rls('reservations');
SELECT apply_tenant_rls('reservation_slots');
SELECT apply_tenant_rls('waiter_calls');

COMMIT;
