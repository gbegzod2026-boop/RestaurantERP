-- 0005_wave3_finance_inventory.up.sql
-- Wave 3 — money out and stock: expenses, cash_counts, finance_entries,
-- payroll_entries, staff_stats, inventory_items, ingredients,
-- stock_movements, daily_usage, recipes, recipe_items, semi_finished (+acts),
-- suppliers, purchase_orders, purchase_order_items, supplier_payments, debts.
--
-- Depends on 0004 for apply_tenant_rls().
--
-- Evidence base (docs/migration-reports/):
--   * inventory and ingredients are a DUAL-WRITE PAIR in the app — nearly
--     every write to one is mirrored to the other, and the live field
--     profiles are identical (13 records each, same units kg/gr/dona, same
--     price range 4..200000). They are modelled as ONE table,
--     inventory_items, with ingredients kept as a view-like alias concept
--     rather than a duplicated table, because two tables would institutionalize
--     a bug. The migration writes each RTDB pair once and reports any case
--     where the two trees disagree instead of silently preferring one.
--   * finance/ is not a flat collection: it is a namespace of date-keyed
--     sub-trees (staff_stats/$staffId/$monthKey, payroll/$monthKey/$staffId,
--     adjustments/$staffId/$monthKey, staff_pay_history/$staffId, payments).
--     Requirement #8 — every one of those date/month keys becomes a typed
--     column here, never an opaque id.
--   * Money columns are numeric(14,2); stock is numeric(14,3) because units
--     are kg/gr and sub-unit precision is real (live values include 0.5 kg).
BEGIN;

-- ── expenses ──────────────────────────────────────────────────────────────
-- Firebase: restaurants/$restId/expenses/$pushId (20 live records).
-- Live categories: utilities(14), salary(6). Left unconstrained: the app
-- lets an admin type a new category, so a CHECK would reject valid future
-- data for no safety gain.
CREATE TABLE expenses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id  text,
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category        text,
  description     text,
  amount          numeric(14,2) NOT NULL DEFAULT 0,
  payment_method  text,
  spent_at        timestamptz,
  created_by      uuid REFERENCES employees(id) ON DELETE SET NULL,
  legacy_created_by text,
  supplier_id     uuid,   -- FK added after suppliers exists, below
  extra           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
CREATE INDEX idx_expenses_restaurant_spent ON expenses (restaurant_id, spent_at DESC NULLS LAST);
CREATE INDEX idx_expenses_category ON expenses (restaurant_id, category);
CREATE INDEX idx_expenses_created_by ON expenses (created_by) WHERE created_by IS NOT NULL;
CREATE TRIGGER trg_expenses_updated_at BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── cash_counts ───────────────────────────────────────────────────────────
-- Firebase: restaurants/$restId/cashCounts/$pushId — end-of-shift till counts.
CREATE TABLE cash_counts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id    text,
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  counted_by        uuid REFERENCES employees(id) ON DELETE SET NULL,
  legacy_counted_by text,
  shift_label       text,
  expected_amount   numeric(14,2),
  counted_amount    numeric(14,2),
  -- Stored, not derived: the app records the discrepancy it computed at the
  -- time, and recomputing it later from possibly-corrected inputs would
  -- rewrite history.
  difference        numeric(14,2),
  notes             text,
  counted_at        timestamptz,
  extra             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
CREATE INDEX idx_cash_counts_restaurant_counted ON cash_counts (restaurant_id, counted_at DESC NULLS LAST);
CREATE INDEX idx_cash_counts_counted_by ON cash_counts (counted_by) WHERE counted_by IS NOT NULL;

-- ── finance_entries ───────────────────────────────────────────────────────
-- Firebase: restaurants/$restId/finance/payments/$pushId and the generic
-- finance ledger writes. A single ledger with a signed direction rather than
-- separate income/outgoing tables — the app already treats them as one list.
CREATE TABLE finance_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id  text,
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  entry_type      text NOT NULL DEFAULT 'other'
                    CHECK (entry_type IN ('income','expense','payroll','adjustment','transfer','other')),
  category        text,
  description     text,
  amount          numeric(14,2) NOT NULL DEFAULT 0,
  direction       smallint NOT NULL DEFAULT 1 CHECK (direction IN (-1, 1)),
  employee_id     uuid REFERENCES employees(id) ON DELETE SET NULL,
  legacy_employee_id text,
  occurred_at     timestamptz,
  extra           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
CREATE INDEX idx_finance_entries_restaurant_occurred ON finance_entries (restaurant_id, occurred_at DESC NULLS LAST);
CREATE INDEX idx_finance_entries_type ON finance_entries (restaurant_id, entry_type);
CREATE INDEX idx_finance_entries_employee ON finance_entries (employee_id) WHERE employee_id IS NOT NULL;

-- ── payroll_entries ───────────────────────────────────────────────────────
-- Firebase: restaurants/$restId/finance/payroll/$monthKey/$staffId
--       and restaurants/$restId/finance/adjustments/$staffId/$monthKey
-- Requirement #8: "$monthKey" ("2026-04") becomes a real `period_month` DATE
-- (first of month), NOT a text id. The original key is kept in
-- legacy_period_key so a row is still traceable to its RTDB path.
CREATE TABLE payroll_entries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  employee_id         uuid REFERENCES employees(id) ON DELETE SET NULL,
  legacy_employee_id  text NOT NULL,
  period_month        date NOT NULL,
  legacy_period_key   text NOT NULL,
  entry_kind          text NOT NULL DEFAULT 'payroll' CHECK (entry_kind IN ('payroll','adjustment')),
  base_salary         numeric(14,2),
  bonus               numeric(14,2),
  penalty             numeric(14,2),
  total_paid          numeric(14,2),
  paid                boolean NOT NULL DEFAULT false,
  paid_at             timestamptz,
  notes               text,
  extra               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_employee_id, period_month, entry_kind)
);
CREATE INDEX idx_payroll_entries_restaurant_period ON payroll_entries (restaurant_id, period_month DESC);
CREATE INDEX idx_payroll_entries_employee ON payroll_entries (employee_id) WHERE employee_id IS NOT NULL;
CREATE TRIGGER trg_payroll_entries_updated_at BEFORE UPDATE ON payroll_entries FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── staff_stats ───────────────────────────────────────────────────────────
-- Firebase: restaurants/$restId/finance/staff_stats/$staffId/$monthKey and
-- .../finance/courier_stats/$courierId/$monthKey — both maintained by
-- runTransaction merges. Same date-key normalization as payroll_entries.
CREATE TABLE staff_stats (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  employee_id         uuid REFERENCES employees(id) ON DELETE SET NULL,
  legacy_employee_id  text NOT NULL,
  stat_scope          text NOT NULL DEFAULT 'staff' CHECK (stat_scope IN ('staff','courier')),
  period_month        date NOT NULL,
  legacy_period_key   text NOT NULL,
  total_earned        numeric(14,2) NOT NULL DEFAULT 0,
  order_count         integer NOT NULL DEFAULT 0 CHECK (order_count >= 0),
  delivered_count     integer NOT NULL DEFAULT 0 CHECK (delivered_count >= 0),
  kpi_score           numeric(10,2),
  extra               jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_employee_id, stat_scope, period_month)
);
CREATE INDEX idx_staff_stats_restaurant_period ON staff_stats (restaurant_id, period_month DESC);
CREATE INDEX idx_staff_stats_employee ON staff_stats (employee_id) WHERE employee_id IS NOT NULL;
CREATE TRIGGER trg_staff_stats_updated_at BEFORE UPDATE ON staff_stats FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── suppliers ─────────────────────────────────────────────────────────────
-- Firebase: restaurants/$restId/suppliers/$pushId. Live status: active, paused.
CREATE TABLE suppliers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id  text,
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            text NOT NULL,
  contact_person  text,
  phone           text,
  email           text,
  address         text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived','unknown')),
  status_raw      text,
  notes           text,
  extra           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
CREATE INDEX idx_suppliers_restaurant_id ON suppliers (restaurant_id);
CREATE INDEX idx_suppliers_status ON suppliers (restaurant_id, status);
CREATE TRIGGER trg_suppliers_updated_at BEFORE UPDATE ON suppliers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- expenses.supplier_id could not be declared inline (suppliers is created
-- after expenses to keep the finance block together); added here.
ALTER TABLE expenses
  ADD CONSTRAINT expenses_supplier_id_fkey
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL;
CREATE INDEX idx_expenses_supplier_id ON expenses (supplier_id) WHERE supplier_id IS NOT NULL;

-- ── inventory_items ───────────────────────────────────────────────────────
-- Firebase: restaurants/$restId/inventory/$pushId AND
--           restaurants/$restId/ingredients/$pushId
-- These two trees are written in lockstep by the app and profile identically
-- in live data. Modelling them as one table with `tracked_as` recording which
-- tree(s) a row came from preserves that provenance without duplicating the
-- entity — and lets the migration flag any pair that actually disagreed.
CREATE TABLE inventory_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id    text,
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name              text NOT NULL,
  category          text,
  unit              text NOT NULL DEFAULT 'dona',
  stock             numeric(14,3) NOT NULL DEFAULT 0,
  min_stock         numeric(14,3),
  price             numeric(14,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  supplier_id       uuid REFERENCES suppliers(id) ON DELETE SET NULL,
  legacy_supplier_id text,
  -- 'inventory' | 'ingredients' | 'both' — which RTDB tree(s) this came from.
  tracked_as        text NOT NULL DEFAULT 'both' CHECK (tracked_as IN ('inventory','ingredients','both')),
  extra             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
CREATE INDEX idx_inventory_items_restaurant_id ON inventory_items (restaurant_id);
CREATE INDEX idx_inventory_items_supplier_id ON inventory_items (supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX idx_inventory_items_low_stock ON inventory_items (restaurant_id, stock) WHERE min_stock IS NOT NULL;
CREATE TRIGGER trg_inventory_items_updated_at BEFORE UPDATE ON inventory_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── stock_movements ───────────────────────────────────────────────────────
-- No single RTDB tree holds this: today stock changes are applied in place by
-- runTransaction on inventory/$id/stock, so the history is lost the moment it
-- happens. This table is the durable ledger that replaces that pattern in
-- Phase 2. The migration seeds it ONLY from data that genuinely exists
-- (dailyUsage), and does not fabricate movements for stock levels whose
-- history was never recorded (rule #20).
CREATE TABLE stock_movements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id      text,
  restaurant_id       uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  inventory_item_id   uuid REFERENCES inventory_items(id) ON DELETE CASCADE,
  legacy_item_id      text,
  movement_type       text NOT NULL CHECK (movement_type IN ('purchase','usage','waste','adjustment','transfer','opening')),
  qty_delta           numeric(14,3) NOT NULL,
  unit                text,
  reference_kind      text,        -- 'order' | 'purchase_order' | 'waste_log' | ...
  reference_id        uuid,
  occurred_at         timestamptz NOT NULL,
  created_by          uuid REFERENCES employees(id) ON DELETE SET NULL,
  notes               text,
  extra               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_stock_movements_item ON stock_movements (inventory_item_id, occurred_at DESC);
CREATE INDEX idx_stock_movements_restaurant_occurred ON stock_movements (restaurant_id, occurred_at DESC);
CREATE INDEX idx_stock_movements_created_by ON stock_movements (created_by) WHERE created_by IS NOT NULL;

-- ── daily_usage ───────────────────────────────────────────────────────────
-- Firebase: restaurants/$restId/dailyUsage/$dateKey/$ingredientId (a
-- runTransaction-incremented counter). Requirement #8: $dateKey becomes a
-- real date column, and (date, item) becomes the natural key the transaction
-- was emulating.
CREATE TABLE daily_usage (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  usage_date        date NOT NULL,
  legacy_date_key   text NOT NULL,
  inventory_item_id uuid REFERENCES inventory_items(id) ON DELETE CASCADE,
  legacy_item_id    text NOT NULL,
  qty_used          numeric(14,3) NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, usage_date, legacy_item_id)
);
CREATE INDEX idx_daily_usage_restaurant_date ON daily_usage (restaurant_id, usage_date DESC);
CREATE INDEX idx_daily_usage_item ON daily_usage (inventory_item_id) WHERE inventory_item_id IS NOT NULL;
CREATE TRIGGER trg_daily_usage_updated_at BEFORE UPDATE ON daily_usage FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── recipes / recipe_items ────────────────────────────────────────────────
-- Firebase: restaurants/$restId/menu/$menuId/recipe — an ARRAY embedded in
-- the menu item (the separate restaurants/$restId/recipes/$menuId tree is
-- legacy and read-only in the app). Wave 1 deferred this because it needs
-- ingredients, which now exist.
--
-- recipes is 1:1 with a menu item today, but is its own table rather than
-- columns on menu_items so that versioning a recipe later does not require
-- rewriting the menu row.
-- legacy_menu_id is the Firebase key ($menuId) and is mandatory: without it a
-- recipe whose menu item cannot be resolved would be unmigratable AND leave no
-- trace of where it came from. It is also the conflict target that makes the
-- recipe migration idempotent, since the resolved uuid is not knowable from
-- Firebase alone.
CREATE TABLE recipes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  menu_item_id    uuid REFERENCES menu_items(id) ON DELETE CASCADE,
  legacy_menu_id  text NOT NULL,
  yield_qty       numeric(14,3) NOT NULL DEFAULT 1 CHECK (yield_qty > 0),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_menu_id),
  UNIQUE (menu_item_id)
);
CREATE INDEX idx_recipes_restaurant_id ON recipes (restaurant_id);
CREATE INDEX idx_recipes_menu_item ON recipes (menu_item_id) WHERE menu_item_id IS NOT NULL;
CREATE TRIGGER trg_recipes_updated_at BEFORE UPDATE ON recipes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE recipe_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id         uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  inventory_item_id uuid REFERENCES inventory_items(id) ON DELETE RESTRICT,
  legacy_item_id    text,
  qty               numeric(14,3) NOT NULL CHECK (qty > 0),
  unit              text,
  sort_order        integer NOT NULL DEFAULT 0,
  UNIQUE (recipe_id, legacy_item_id)
);
CREATE INDEX idx_recipe_items_recipe ON recipe_items (recipe_id);
CREATE INDEX idx_recipe_items_item ON recipe_items (inventory_item_id) WHERE inventory_item_id IS NOT NULL;
CREATE INDEX idx_recipe_items_restaurant_id ON recipe_items (restaurant_id);

-- ── semi_finished / semi_finished_acts ────────────────────────────────────
-- Firebase: restaurants/$restId/semiFinished/$id and .../semiFinishedActs/$id
-- (prepared components produced in-house, plus the production acts).
CREATE TABLE semi_finished (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id  text,
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            text NOT NULL,
  unit            text,
  yield_qty       numeric(14,3),
  cost            numeric(14,2),
  components      jsonb NOT NULL DEFAULT '[]'::jsonb,
  extra           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
CREATE INDEX idx_semi_finished_restaurant_id ON semi_finished (restaurant_id);
CREATE TRIGGER trg_semi_finished_updated_at BEFORE UPDATE ON semi_finished FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE semi_finished_acts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id    text,
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  semi_finished_id  uuid REFERENCES semi_finished(id) ON DELETE SET NULL,
  legacy_semi_id    text,
  qty_produced      numeric(14,3),
  produced_at       timestamptz,
  produced_by       uuid REFERENCES employees(id) ON DELETE SET NULL,
  notes             text,
  extra             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
CREATE INDEX idx_semi_finished_acts_restaurant_produced ON semi_finished_acts (restaurant_id, produced_at DESC NULLS LAST);
CREATE INDEX idx_semi_finished_acts_semi ON semi_finished_acts (semi_finished_id) WHERE semi_finished_id IS NOT NULL;
CREATE INDEX idx_semi_finished_acts_produced_by ON semi_finished_acts (produced_by) WHERE produced_by IS NOT NULL;

-- ── purchase_orders / purchase_order_items / supplier_payments / debts ────
-- Firebase: restaurants/$restId/purchaseOrders/$pushId (live status:
-- delivered, received), .../poPayments/$pushId, .../debts/$pushId.
CREATE TABLE purchase_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id    text,
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  supplier_id       uuid REFERENCES suppliers(id) ON DELETE SET NULL,
  legacy_supplier_id text,
  po_number         text,
  status            text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','ordered','received','delivered','cancelled','unknown')),
  status_raw        text,
  total_amount      numeric(14,2) NOT NULL DEFAULT 0,
  paid_amount       numeric(14,2) NOT NULL DEFAULT 0,
  ordered_at        timestamptz,
  received_at       timestamptz,
  notes             text,
  extra             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
CREATE INDEX idx_purchase_orders_restaurant_status ON purchase_orders (restaurant_id, status);
CREATE INDEX idx_purchase_orders_supplier ON purchase_orders (supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX idx_purchase_orders_ordered_at ON purchase_orders (restaurant_id, ordered_at DESC NULLS LAST);
CREATE TRIGGER trg_purchase_orders_updated_at BEFORE UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Line items are an embedded array on the RTDB record; normalized here, with
-- name/price snapshotted for the same reason order_items are: a PO is a
-- historical document.
CREATE TABLE purchase_order_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id      text,
  purchase_order_id   uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  restaurant_id       uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  inventory_item_id   uuid REFERENCES inventory_items(id) ON DELETE SET NULL,
  legacy_item_id      text,
  name_snapshot       text NOT NULL,
  qty                 numeric(14,3) NOT NULL CHECK (qty > 0),
  unit                text,
  unit_price_snapshot numeric(14,2) NOT NULL DEFAULT 0 CHECK (unit_price_snapshot >= 0),
  line_total          numeric(14,2) NOT NULL DEFAULT 0,
  UNIQUE (purchase_order_id, legacy_rtdb_id)
);
CREATE INDEX idx_po_items_po ON purchase_order_items (purchase_order_id);
CREATE INDEX idx_po_items_restaurant_id ON purchase_order_items (restaurant_id);
CREATE INDEX idx_po_items_inventory_item ON purchase_order_items (inventory_item_id) WHERE inventory_item_id IS NOT NULL;

CREATE TABLE supplier_payments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id    text,
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  supplier_id       uuid REFERENCES suppliers(id) ON DELETE SET NULL,
  legacy_supplier_id text,
  purchase_order_id uuid REFERENCES purchase_orders(id) ON DELETE SET NULL,
  legacy_po_id      text,
  amount            numeric(14,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  method            text,
  paid_at           timestamptz,
  notes             text,
  extra             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
CREATE INDEX idx_supplier_payments_supplier ON supplier_payments (supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX idx_supplier_payments_po ON supplier_payments (purchase_order_id) WHERE purchase_order_id IS NOT NULL;
CREATE INDEX idx_supplier_payments_restaurant_paid ON supplier_payments (restaurant_id, paid_at DESC NULLS LAST);

-- debts covers both directions (owed to a supplier, owed by a customer), so
-- the counterparty is polymorphic; both possible FKs are nullable and a
-- CHECK keeps exactly one of them meaningful.
CREATE TABLE debts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id    text,
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  counterparty_kind text NOT NULL CHECK (counterparty_kind IN ('supplier','customer','employee','other')),
  supplier_id       uuid REFERENCES suppliers(id) ON DELETE SET NULL,
  customer_id       uuid REFERENCES customers(id) ON DELETE SET NULL,
  employee_id       uuid REFERENCES employees(id) ON DELETE SET NULL,
  counterparty_name text,
  order_id          uuid REFERENCES orders(id) ON DELETE SET NULL,
  legacy_order_id   text,
  amount            numeric(14,2) NOT NULL DEFAULT 0,
  paid_amount       numeric(14,2) NOT NULL DEFAULT 0,
  settled           boolean NOT NULL DEFAULT false,
  due_at            timestamptz,
  settled_at        timestamptz,
  notes             text,
  extra             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_rtdb_id),
  CHECK (
    (counterparty_kind = 'supplier' AND customer_id IS NULL AND employee_id IS NULL) OR
    (counterparty_kind = 'customer' AND supplier_id IS NULL AND employee_id IS NULL) OR
    (counterparty_kind = 'employee' AND supplier_id IS NULL AND customer_id IS NULL) OR
    (counterparty_kind = 'other')
  )
);
CREATE INDEX idx_debts_restaurant_settled ON debts (restaurant_id, settled);
CREATE INDEX idx_debts_supplier ON debts (supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX idx_debts_customer ON debts (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_debts_employee ON debts (employee_id) WHERE employee_id IS NOT NULL;
CREATE INDEX idx_debts_order ON debts (order_id) WHERE order_id IS NOT NULL;
CREATE TRIGGER trg_debts_updated_at BEFORE UPDATE ON debts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── RLS + grants ──────────────────────────────────────────────────────────
SELECT apply_tenant_rls('expenses');
SELECT apply_tenant_rls('cash_counts');
SELECT apply_tenant_rls('finance_entries');
SELECT apply_tenant_rls('payroll_entries');
SELECT apply_tenant_rls('staff_stats');
SELECT apply_tenant_rls('suppliers');
SELECT apply_tenant_rls('inventory_items');
SELECT apply_tenant_rls('stock_movements');
SELECT apply_tenant_rls('daily_usage');
SELECT apply_tenant_rls('recipes');
SELECT apply_tenant_rls('recipe_items');
SELECT apply_tenant_rls('semi_finished');
SELECT apply_tenant_rls('semi_finished_acts');
SELECT apply_tenant_rls('purchase_orders');
SELECT apply_tenant_rls('purchase_order_items');
SELECT apply_tenant_rls('supplier_payments');
SELECT apply_tenant_rls('debts');

COMMIT;
