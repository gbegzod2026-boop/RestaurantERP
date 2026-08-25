-- 0002_wave1_master_data.up.sql
-- Wave 1 — master data: restaurant_settings, tables, menu_categories
-- (+ subcategories), kitchen_stations, menu_items, combo_items. Plus two
-- ALTER TABLE columns on Wave 0's restaurants (business_type, info) that
-- were deliberately deferred out of Wave 0's minimal identity scope.
--
-- A NEW migration, not an edit to 0001 — Wave 0 is accepted and live-relied
-- upon; per the task instruction it stays untouched.
--
-- Every table here traces to a real, freshly-confirmed RTDB write site in
-- admin-frontend/public/js/admin.js (not the Phase 1 doc's earlier guesses
-- alone) — see each table's comment for the exact call site. Two explicit
-- scope decisions, not guesses:
--   1. menu_categories has NO row for the frontend's hardcoded "static"
--      category set (getAllCategories()'s staticCats — presentation-layer
--      defaults, never written to RTDB at all). Only restaurant-created
--      ("custom", RTDB-backed) categories get rows here. menu_items.
--      category_id/subcategory_id are therefore nullable, and a menu item
--      referencing a static category id will show that FK as NULL after
--      migration — this is expected, not data loss, and the dry-run script
--      reports every such reference explicitly rather than silently
--      dropping it.
--   2. Recipes/ingredients (menu.$id.recipe[]) are NOT included — they
--      depend on the `ingredients` master table, which is Wave 4's scope
--      per the task's own wave breakdown. Deferred, not guessed.
BEGIN;

-- ── restaurants: master-data columns deferred from Wave 0 ─────────────
-- Firebase source: restaurants/$restId/info (jsonb catch-all) and the
-- business_type field used for Marketing broadcast segmentation
-- (superadmin.js's getBroadcastByBusinessTypeRestaurants).
ALTER TABLE restaurants ADD COLUMN business_type text;
ALTER TABLE restaurants ADD COLUMN info jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ── restaurant_settings ────────────────────────────────────────────────
-- Firebase source: restaurants/$restId/settings — a genuinely
-- heterogeneous per-restaurant catch-all (kassa/receipt config, discount
-- rules, delivery settings, etc.), kept as jsonb per the architecture
-- doc's own "not worth normalizing" call rather than guessed apart.
CREATE TABLE restaurant_settings (
  restaurant_id  uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  settings       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_restaurant_settings_updated_at BEFORE UPDATE ON restaurant_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── tables ────────────────────────────────────────────────────────────
-- Firebase source: restaurants/$restId/tables/table_{N} — confirmed shape
-- (admin.js saveNewTable/markTableFree): { number, tableType, capacity,
-- active, status, createdAt }. status is left as free text, not a guessed
-- CHECK enum — confirmed real values include at least "free"/"cleaning";
-- the full value set (waiter.css also references busy/preparing/ready/
-- paid/reserved/closed) wasn't exhaustively re-confirmed against live data,
-- so constraining it risks rejecting a genuinely valid legacy value during
-- the real migration.
CREATE TABLE tables (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id    text,
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  number            integer NOT NULL,
  table_type        text NOT NULL DEFAULT 'oddiy',
  capacity          integer CHECK (capacity IS NULL OR capacity > 0),
  active            boolean NOT NULL DEFAULT true,
  status            text NOT NULL DEFAULT 'free',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_rtdb_id),
  UNIQUE (restaurant_id, number)
);
CREATE INDEX idx_tables_restaurant_id ON tables (restaurant_id);
CREATE TRIGGER trg_tables_updated_at BEFORE UPDATE ON tables FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── menu_categories (self-referencing — top-level AND subcategories) ──
-- Firebase source: restaurants/$restId/categories/$catId (+ /sub/$subId).
-- Confirmed shape: { id, name: {uz,ru,en}, sub: {...}, createdAt } — name
-- is a multi-language object, kept as jsonb rather than flattened into
-- three columns (matches how every other i18n-object field in this app is
-- shaped, not a shortcut).
CREATE TABLE menu_categories (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id    text,
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  parent_id         uuid REFERENCES menu_categories(id) ON DELETE CASCADE,
  name              jsonb NOT NULL,
  sort_order        integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_rtdb_id),
  -- A subcategory's parent must belong to the same restaurant — enforced
  -- structurally is not possible with a plain CHECK (no subqueries), left
  -- as an application-layer invariant the migration script itself
  -- maintains (it only ever sets parent_id to a category it just inserted
  -- for the same restaurant_id).
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX idx_menu_categories_restaurant_id ON menu_categories (restaurant_id);
CREATE INDEX idx_menu_categories_parent_id ON menu_categories (parent_id) WHERE parent_id IS NOT NULL;

-- ── kitchen_stations ──────────────────────────────────────────────────
-- Firebase source: restaurants/$restId/kitchenStations/$stationId.
-- Confirmed shape: { id, name: {uz,ru,en}, createdAt }.
CREATE TABLE kitchen_stations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id    text,
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name              jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
CREATE INDEX idx_kitchen_stations_restaurant_id ON kitchen_stations (restaurant_id);

-- ── menu_items ────────────────────────────────────────────────────────
-- Firebase source: restaurants/$restId/menu/$id. Confirmed shape (admin.js
-- ~line 3021): { name:{uz,ru,en}, price, category, subcategory, prepTime,
-- kitchenStation, imgUrl, imgPath, isWeightBased, isFeatured, isNew,
-- portionSize, variants:{...}, active, createdAt }. `variants` (an
-- optional, small, bounded size/price-option object) is kept as jsonb —
-- genuinely variable-shape, not a shortcut around a real relational need.
-- recipe[] is intentionally NOT included here — see file header.
CREATE TABLE menu_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id      text,
  restaurant_id       uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category_id         uuid REFERENCES menu_categories(id) ON DELETE SET NULL,
  subcategory_id      uuid REFERENCES menu_categories(id) ON DELETE SET NULL,
  kitchen_station_id  uuid REFERENCES kitchen_stations(id) ON DELETE SET NULL,
  name                jsonb NOT NULL,
  price               numeric(14,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  prep_time           text,
  img_url             text,
  is_weight_based     boolean NOT NULL DEFAULT false,
  is_featured         boolean NOT NULL DEFAULT false,
  is_new              boolean NOT NULL DEFAULT false,
  portion_size        text,
  variants            jsonb,
  is_combo            boolean NOT NULL DEFAULT false,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, legacy_rtdb_id)
);
CREATE INDEX idx_menu_items_restaurant_id ON menu_items (restaurant_id);
CREATE INDEX idx_menu_items_category_id ON menu_items (category_id) WHERE category_id IS NOT NULL;
CREATE TRIGGER trg_menu_items_updated_at BEFORE UPDATE ON menu_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── combo_items ───────────────────────────────────────────────────────
-- Firebase source: a combo is a menu_items row with isCombo=true; its
-- component breakdown is derived client-side (_expandRecipeForMenuId) at
-- render time rather than stored as its own RTDB list in every case
-- observed — this table is the normalized target for that relationship
-- going forward, not a 1:1 mirror of an existing RTDB array. Flagged for
-- the dry-run script to report actual combo composition data found (or
-- not found) rather than assumed.
-- component_menu_item_id is ON DELETE CASCADE, not RESTRICT — found live
-- during Wave 1 verification: RESTRICT here fights the restaurants→
-- menu_items CASCADE the moment a whole restaurant (or any menu item that
-- happens to be a combo component) is deleted, since Postgres evaluates
-- the RESTRICT check as part of the same cascading delete and there is no
-- guaranteed ordering that deletes the combo_items row first. CASCADE is
-- also the more correct real-world behavior anyway: discontinuing a dish
-- should drop it from any combo it was part of, not block the deletion
-- outright (unlike order_items→menu_items, which stays RESTRICT — an
-- order's historical record must never silently lose a line item).
CREATE TABLE combo_items (
  combo_menu_item_id       uuid NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  component_menu_item_id   uuid NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  qty                      integer NOT NULL DEFAULT 1 CHECK (qty > 0),
  PRIMARY KEY (combo_menu_item_id, component_menu_item_id),
  CHECK (combo_menu_item_id <> component_menu_item_id)
);
CREATE INDEX idx_combo_items_component ON combo_items (component_menu_item_id);

-- ── Row-Level Security ────────────────────────────────────────────────
-- Same session contract as Wave 0 (app.current_restaurant_id) and the same
-- NULLIF-guarded cast Wave 0's live verification found necessary.
ALTER TABLE restaurant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurant_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY restaurant_settings_select ON restaurant_settings FOR SELECT USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);
CREATE POLICY restaurant_settings_insert ON restaurant_settings FOR INSERT WITH CHECK (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);
CREATE POLICY restaurant_settings_update ON restaurant_settings FOR UPDATE USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
) WITH CHECK (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);
CREATE POLICY restaurant_settings_delete ON restaurant_settings FOR DELETE USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);

ALTER TABLE tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE tables FORCE ROW LEVEL SECURITY;
CREATE POLICY tables_select ON tables FOR SELECT USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);
CREATE POLICY tables_insert ON tables FOR INSERT WITH CHECK (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);
CREATE POLICY tables_update ON tables FOR UPDATE USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
) WITH CHECK (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);
CREATE POLICY tables_delete ON tables FOR DELETE USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);

ALTER TABLE menu_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_categories_select ON menu_categories FOR SELECT USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);
CREATE POLICY menu_categories_insert ON menu_categories FOR INSERT WITH CHECK (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);
CREATE POLICY menu_categories_update ON menu_categories FOR UPDATE USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
) WITH CHECK (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);
CREATE POLICY menu_categories_delete ON menu_categories FOR DELETE USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);

ALTER TABLE kitchen_stations ENABLE ROW LEVEL SECURITY;
ALTER TABLE kitchen_stations FORCE ROW LEVEL SECURITY;
CREATE POLICY kitchen_stations_select ON kitchen_stations FOR SELECT USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);
CREATE POLICY kitchen_stations_insert ON kitchen_stations FOR INSERT WITH CHECK (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);
CREATE POLICY kitchen_stations_update ON kitchen_stations FOR UPDATE USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
) WITH CHECK (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);
CREATE POLICY kitchen_stations_delete ON kitchen_stations FOR DELETE USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);

ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_items_select ON menu_items FOR SELECT USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);
CREATE POLICY menu_items_insert ON menu_items FOR INSERT WITH CHECK (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);
CREATE POLICY menu_items_update ON menu_items FOR UPDATE USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
) WITH CHECK (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);
CREATE POLICY menu_items_delete ON menu_items FOR DELETE USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);

-- combo_items has no restaurant_id column of its own (by design, matching
-- employee_credentials' pattern from Wave 0) — row visibility follows the
-- combo's own menu_items row via subquery.
ALTER TABLE combo_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE combo_items FORCE ROW LEVEL SECURITY;
CREATE POLICY combo_items_select ON combo_items FOR SELECT USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR combo_menu_item_id IN (SELECT id FROM menu_items WHERE restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid)
);
CREATE POLICY combo_items_insert ON combo_items FOR INSERT WITH CHECK (
  current_setting('app.current_restaurant_id', true) = ''
  OR combo_menu_item_id IN (SELECT id FROM menu_items WHERE restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid)
);
CREATE POLICY combo_items_update ON combo_items FOR UPDATE USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR combo_menu_item_id IN (SELECT id FROM menu_items WHERE restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid)
) WITH CHECK (
  current_setting('app.current_restaurant_id', true) = ''
  OR combo_menu_item_id IN (SELECT id FROM menu_items WHERE restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid)
);
CREATE POLICY combo_items_delete ON combo_items FOR DELETE USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR combo_menu_item_id IN (SELECT id FROM menu_items WHERE restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid)
);

-- ── Grants ────────────────────────────────────────────────────────────
-- All Wave 1 tables are ordinary master data (no credential-style
-- column-level split needed) — nesta_app gets standard table-level grants,
-- RLS governs rows as above.
GRANT SELECT, INSERT, UPDATE, DELETE ON restaurant_settings TO nesta_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tables TO nesta_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON menu_categories TO nesta_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON kitchen_stations TO nesta_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON menu_items TO nesta_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON combo_items TO nesta_app;

COMMIT;
