-- 0006_wave4_kitchen_operations.up.sql
-- Wave 4 — kitchen and floor operations plus the per-restaurant config trees:
-- attendance, shifts, chef_tasks, prep_schedule, waste_log, equipment_status,
-- kitchen_inventory, kitchen_announcements, modifiers, extras, stop_list,
-- discounts, promotions, print_settings, terminal_settings, production_plans.
--
-- Depends on 0004 (apply_tenant_rls) and 0005 (inventory_items).
--
-- This wave is where Phase 1 requirement #8 does most of its work. Five of
-- these RTDB trees are keyed by a DATE or a date+owner pair:
--     attendance/$dateKey/$userId
--     chefTasks/$chefId/$dateKey/$taskId
--     prepSchedule/$chefId/$dateKey/$itemId
--     wasteLog/$dateKey/$entryId
--     kitchenAnnouncements/$dateKey/$annId
--     productionPlans/$dateKey/items/$menuId
-- In every case the date segment becomes a real `date` column and the owner
-- segment becomes a foreign key, with the original key strings retained in
-- legacy_* columns so any row can still be traced back to its RTDB path.
-- None of these date strings survives as an identifier.
BEGIN;

-- ── attendance ────────────────────────────────────────────────────────────
-- Firebase: restaurants/$restId/attendance/$dateKey/$userId
-- (date, employee) is the natural key the RTDB path shape was already
-- enforcing, so it becomes a real unique constraint.
CREATE TABLE attendance (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  employee_id         uuid REFERENCES employees(id) ON DELETE SET NULL,
  legacy_employee_id  text NOT NULL,
  work_date           date NOT NULL,
  legacy_date_key     text NOT NULL,
  status              text,
  checked_in_at       timestamptz,
  checked_out_at      timestamptz,
  worked_minutes      integer CHECK (worked_minutes IS NULL OR worked_minutes >= 0),
  notes               text,
  extra               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, work_date, legacy_employee_id)
);
CREATE INDEX idx_attendance_restaurant_date ON attendance (restaurant_id, work_date DESC);
CREATE INDEX idx_attendance_employee ON attendance (employee_id) WHERE employee_id IS NOT NULL;
CREATE TRIGGER trg_attendance_updated_at BEFORE UPDATE ON attendance FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── shifts ────────────────────────────────────────────────────────────────
-- Firebase: restaurants/$restId/shifts/$pushId
CREATE TABLE shifts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id      text,
  restaurant_id       uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  employee_id         uuid REFERENCES employees(id) ON DELETE SET NULL,
  legacy_employee_id  text,
  shift_date          date,
  starts_at           timestamptz,
  ends_at             timestamptz,
  role_label          text,
  status              text,
  extra               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
CREATE INDEX idx_shifts_restaurant_date ON shifts (restaurant_id, shift_date DESC NULLS LAST);
CREATE INDEX idx_shifts_employee ON shifts (employee_id) WHERE employee_id IS NOT NULL;

-- ── chef_tasks ────────────────────────────────────────────────────────────
-- Firebase: restaurants/$restId/chefTasks/$chefId/$dateKey/$taskId — a
-- three-level tree flattened into one row carrying both the owner FK and the
-- typed date.
CREATE TABLE chef_tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id    text,
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  chef_id           uuid REFERENCES employees(id) ON DELETE SET NULL,
  legacy_chef_id    text NOT NULL,
  task_date         date NOT NULL,
  legacy_date_key   text NOT NULL,
  title             text,
  description       text,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','in_progress','done','cancelled','unknown')),
  status_raw        text,
  priority          text,
  due_at            timestamptz,
  completed_at      timestamptz,
  extra             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_chef_id, task_date, legacy_rtdb_id)
);
CREATE INDEX idx_chef_tasks_restaurant_date ON chef_tasks (restaurant_id, task_date DESC);
CREATE INDEX idx_chef_tasks_chef ON chef_tasks (chef_id) WHERE chef_id IS NOT NULL;
CREATE INDEX idx_chef_tasks_status ON chef_tasks (restaurant_id, status);
CREATE TRIGGER trg_chef_tasks_updated_at BEFORE UPDATE ON chef_tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── prep_schedule ─────────────────────────────────────────────────────────
-- Firebase: restaurants/$restId/prepSchedule/$chefId/$dateKey/$itemId
CREATE TABLE prep_schedule (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id    text,
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  chef_id           uuid REFERENCES employees(id) ON DELETE SET NULL,
  legacy_chef_id    text NOT NULL,
  prep_date         date NOT NULL,
  legacy_date_key   text NOT NULL,
  menu_item_id      uuid REFERENCES menu_items(id) ON DELETE SET NULL,
  legacy_menu_id    text,
  item_label        text,
  qty_planned       numeric(14,3),
  qty_done          numeric(14,3),
  status            text,
  extra             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_chef_id, prep_date, legacy_rtdb_id)
);
CREATE INDEX idx_prep_schedule_restaurant_date ON prep_schedule (restaurant_id, prep_date DESC);
CREATE INDEX idx_prep_schedule_chef ON prep_schedule (chef_id) WHERE chef_id IS NOT NULL;
CREATE INDEX idx_prep_schedule_menu_item ON prep_schedule (menu_item_id) WHERE menu_item_id IS NOT NULL;

-- ── waste_log ─────────────────────────────────────────────────────────────
-- Firebase: restaurants/$restId/wasteLog/$dateKey/$entryId
CREATE TABLE waste_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id    text,
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  waste_date        date NOT NULL,
  legacy_date_key   text NOT NULL,
  inventory_item_id uuid REFERENCES inventory_items(id) ON DELETE SET NULL,
  legacy_item_id    text,
  item_label        text,
  qty               numeric(14,3),
  unit              text,
  estimated_cost    numeric(14,2),
  reason            text,
  reported_by       uuid REFERENCES employees(id) ON DELETE SET NULL,
  legacy_reported_by text,
  extra             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, waste_date, legacy_rtdb_id)
);
CREATE INDEX idx_waste_log_restaurant_date ON waste_log (restaurant_id, waste_date DESC);
CREATE INDEX idx_waste_log_item ON waste_log (inventory_item_id) WHERE inventory_item_id IS NOT NULL;
CREATE INDEX idx_waste_log_reported_by ON waste_log (reported_by) WHERE reported_by IS NOT NULL;

-- ── equipment_status / kitchen_inventory / kitchen_announcements ──────────
CREATE TABLE equipment_status (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id    text,
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name              text NOT NULL,
  equipment_type    text,
  status            text,
  last_checked_at   timestamptz,
  next_service_at   timestamptz,
  notes             text,
  extra             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
CREATE INDEX idx_equipment_status_restaurant_id ON equipment_status (restaurant_id);
CREATE TRIGGER trg_equipment_status_updated_at BEFORE UPDATE ON equipment_status FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Firebase: restaurants/$restId/kitchenInventory/$itemId — the kitchen's own
-- working stock, tracked separately from the warehouse inventory by the app.
-- Kept as its own table rather than folded into inventory_items because the
-- two are genuinely different counts of different things.
CREATE TABLE kitchen_inventory (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id    text,
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  inventory_item_id uuid REFERENCES inventory_items(id) ON DELETE SET NULL,
  legacy_item_id    text,
  name              text NOT NULL,
  qty               numeric(14,3) NOT NULL DEFAULT 0,
  unit              text,
  min_qty           numeric(14,3),
  updated_by        uuid REFERENCES employees(id) ON DELETE SET NULL,
  extra             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
CREATE INDEX idx_kitchen_inventory_restaurant_id ON kitchen_inventory (restaurant_id);
CREATE INDEX idx_kitchen_inventory_item ON kitchen_inventory (inventory_item_id) WHERE inventory_item_id IS NOT NULL;
CREATE INDEX idx_kitchen_inventory_updated_by ON kitchen_inventory (updated_by) WHERE updated_by IS NOT NULL;
CREATE TRIGGER trg_kitchen_inventory_updated_at BEFORE UPDATE ON kitchen_inventory FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Firebase: restaurants/$restId/kitchenAnnouncements/$dateKey/$annId, with
-- .../readBy/$userId written individually. readBy is a small unbounded set of
-- ids with no attributes of its own, so it stays jsonb rather than earning a
-- join table.
CREATE TABLE kitchen_announcements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id    text,
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  announced_date    date NOT NULL,
  legacy_date_key   text NOT NULL,
  body              text,
  author_id         uuid REFERENCES employees(id) ON DELETE SET NULL,
  legacy_author_id  text,
  read_by           jsonb NOT NULL DEFAULT '{}'::jsonb,
  posted_at         timestamptz,
  extra             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, announced_date, legacy_rtdb_id)
);
CREATE INDEX idx_kitchen_announcements_restaurant_date ON kitchen_announcements (restaurant_id, announced_date DESC);
CREATE INDEX idx_kitchen_announcements_author ON kitchen_announcements (author_id) WHERE author_id IS NOT NULL;

-- ── production_plans ──────────────────────────────────────────────────────
-- Firebase: restaurants/$restId/productionPlans/$dateKey/items/$menuId
CREATE TABLE production_plans (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  plan_date         date NOT NULL,
  legacy_date_key   text NOT NULL,
  menu_item_id      uuid REFERENCES menu_items(id) ON DELETE SET NULL,
  legacy_menu_id    text NOT NULL,
  qty_planned       numeric(14,3),
  qty_produced      numeric(14,3),
  extra             jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, plan_date, legacy_menu_id)
);
CREATE INDEX idx_production_plans_restaurant_date ON production_plans (restaurant_id, plan_date DESC);
CREATE INDEX idx_production_plans_menu_item ON production_plans (menu_item_id) WHERE menu_item_id IS NOT NULL;
CREATE TRIGGER trg_production_plans_updated_at BEFORE UPDATE ON production_plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── modifiers / extras ────────────────────────────────────────────────────
-- Firebase: restaurants/$restId/modifiers/$id and .../extras/$id.
-- Separate tables, not one "options" table with a type column: they are used
-- at different points in the ordering flow (a modifier changes a dish, an
-- extra is an add-on with its own price) and forcing them together would be
-- exactly the "generic table to reduce table count" the brief rules out.
CREATE TABLE modifiers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id  text,
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            jsonb NOT NULL,
  price_delta     numeric(14,2) NOT NULL DEFAULT 0,
  group_label     text,
  sort_order      integer NOT NULL DEFAULT 0,
  active          boolean NOT NULL DEFAULT true,
  extra           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
CREATE INDEX idx_modifiers_restaurant_id ON modifiers (restaurant_id);

CREATE TABLE extras (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id  text,
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            jsonb NOT NULL,
  price           numeric(14,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  sort_order      integer NOT NULL DEFAULT 0,
  active          boolean NOT NULL DEFAULT true,
  extra           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
CREATE INDEX idx_extras_restaurant_id ON extras (restaurant_id);

-- ── stop_list ─────────────────────────────────────────────────────────────
-- Firebase: restaurants/$restId/stopList/$productId — dishes currently
-- unavailable. The RTDB key IS the menu item id, so uniqueness is per item.
CREATE TABLE stop_list (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  menu_item_id    uuid REFERENCES menu_items(id) ON DELETE CASCADE,
  legacy_menu_id  text NOT NULL,
  reason          text,
  stopped_at      timestamptz,
  stopped_by      uuid REFERENCES employees(id) ON DELETE SET NULL,
  extra           jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (restaurant_id, legacy_menu_id)
);
CREATE INDEX idx_stop_list_menu_item ON stop_list (menu_item_id) WHERE menu_item_id IS NOT NULL;
CREATE INDEX idx_stop_list_restaurant_id ON stop_list (restaurant_id);
CREATE INDEX idx_stop_list_stopped_by ON stop_list (stopped_by) WHERE stopped_by IS NOT NULL;

-- ── discounts / promotions ────────────────────────────────────────────────
-- Firebase: restaurants/$restId/discounts/$code (key IS the code) and
-- .../promotions/$id.
CREATE TABLE discounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id  text,
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  code            text NOT NULL,
  discount_type   text NOT NULL DEFAULT 'percent' CHECK (discount_type IN ('percent','fixed','unknown')),
  value           numeric(14,2) NOT NULL DEFAULT 0,
  active          boolean NOT NULL DEFAULT true,
  usage_limit     integer,
  used_count      integer NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  valid_from      timestamptz,
  valid_until     timestamptz,
  extra           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, code)
);
CREATE INDEX idx_discounts_restaurant_active ON discounts (restaurant_id, active);

CREATE TABLE promotions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id  text,
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  title           jsonb,
  description     jsonb,
  promo_type      text,
  value           numeric(14,2),
  active          boolean NOT NULL DEFAULT true,
  starts_at       timestamptz,
  ends_at         timestamptz,
  extra           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
CREATE INDEX idx_promotions_restaurant_active ON promotions (restaurant_id, active);

-- ── print_settings / terminal_settings ────────────────────────────────────
-- Firebase: restaurants/$restId/printSettings and .../terminalSettings — both
-- are single per-restaurant config objects, so restaurant_id is the PK
-- (same shape as Wave 1's restaurant_settings).
CREATE TABLE print_settings (
  restaurant_id   uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  settings        jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_print_settings_updated_at BEFORE UPDATE ON print_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE terminal_settings (
  restaurant_id   uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  settings        jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_terminal_settings_updated_at BEFORE UPDATE ON terminal_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Firebase: restaurants/$restId/equipmentPrinters/$id — a real list, unlike
-- the two singleton config objects above.
CREATE TABLE equipment_printers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id  text,
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            text,
  printer_type    text,
  connection      text,
  kitchen_station_id uuid REFERENCES kitchen_stations(id) ON DELETE SET NULL,
  active          boolean NOT NULL DEFAULT true,
  extra           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
CREATE INDEX idx_equipment_printers_restaurant_id ON equipment_printers (restaurant_id);
CREATE INDEX idx_equipment_printers_station ON equipment_printers (kitchen_station_id) WHERE kitchen_station_id IS NOT NULL;

-- ── RLS + grants ──────────────────────────────────────────────────────────
SELECT apply_tenant_rls('attendance');
SELECT apply_tenant_rls('shifts');
SELECT apply_tenant_rls('chef_tasks');
SELECT apply_tenant_rls('prep_schedule');
SELECT apply_tenant_rls('waste_log');
SELECT apply_tenant_rls('equipment_status');
SELECT apply_tenant_rls('kitchen_inventory');
SELECT apply_tenant_rls('kitchen_announcements');
SELECT apply_tenant_rls('production_plans');
SELECT apply_tenant_rls('modifiers');
SELECT apply_tenant_rls('extras');
SELECT apply_tenant_rls('stop_list');
SELECT apply_tenant_rls('discounts');
SELECT apply_tenant_rls('promotions');
SELECT apply_tenant_rls('print_settings');
SELECT apply_tenant_rls('terminal_settings');
SELECT apply_tenant_rls('equipment_printers');

COMMIT;
