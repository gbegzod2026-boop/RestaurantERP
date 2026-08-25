# Firebase → PostgreSQL Mapping

Phase 1, requirement #3. Every RTDB entity, its PostgreSQL target, how the
legacy identity is preserved, and the normalization rules applied.

Companion documents: `FIREBASE_RTDB_INVENTORY.md` (what exists),
`STATUS_MIGRATION_MAP.md` (enum values), `MONEY_MIGRATION_POLICY.md`
(numeric rules), `POSTGRES_INDEX_STRATEGY.md` (indexes).

---

## 1. Universal rules

Applied to every table without exception.

| Rule | Implementation |
|---|---|
| **Surrogate keys** | `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`. No Firebase key is ever a PostgreSQL primary key. |
| **Legacy identity** | `legacy_rtdb_id text` holds the RTDB key **exactly as-is**, including percent-encoding. `UNIQUE (restaurant_id, legacy_rtdb_id)` makes re-runs idempotent. |
| **Tenancy** | Every restaurant-owned table has `restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE`, with RLS `ENABLE` + `FORCE`. |
| **Money** | `numeric(14,2)`. Never `float`. |
| **Time** | `timestamptz`. RTDB epoch-ms numbers converted; out-of-range values rejected and reported. |
| **Date keys** | Become real `date` columns; the original string is kept in `legacy_*_key`. |
| **Enums** | `CHECK`-constrained against the exhaustive live value set; the untouched original is kept in a `*_raw` column. |
| **Unmapped fields** | Land in an `extra jsonb` column. This is the mechanical guarantee of "no silent data loss". |
| **JSONB** | Only for genuinely variable shapes: i18n name objects, polymorphic addresses, unbounded id sets, and `extra`. |

### The `*_raw` / `extra` pattern

Normalization must never be destructive. Two mechanisms guarantee it:

```
Firebase order record
   ├─ status: "to'landi"     ──►  orders.status      = 'completed'   (canonical)
   │                              orders.status_raw  = "to'landi"    (verbatim)
   ├─ statusKey: "completed" ──►  orders.status_key_raw
   ├─ statusV2: "completed"  ──►  orders.status_v2_raw
   ├─ statusLabel: "Yakunlandi" ► orders.status_label_raw
   └─ someFieldNobodyMapped  ──►  orders.extra->>'someFieldNobodyMapped'
```

Any migrated row can be reconstructed back to what RTDB actually held.

---

## 2. Identity and master data (Waves 0–1, already applied)

| Firebase path | PostgreSQL table | legacy_rtdb_id | Notes |
|---|---|---|---|
| `restaurants/$restId` | `restaurants` | `$restId` | `info` and `subscription` folded into columns + `info` jsonb |
| `restaurants/$restId/info` | `restaurants` columns | — | |
| `restaurants/$restId/settings` | `restaurant_settings` | — | PK is `restaurant_id`; heterogeneous → jsonb |
| `restaurants/$restId/modules` | `restaurant_modules` | module name | |
| `restaurants/$restId/users/$userId` | `employees` | `$userId` | Empty/corrupt roles skipped + reported |
| `credentials/$restId/$userId` | `employee_credentials` | `$userId` | Never sampled or logged |
| `restaurants/$restId/users/$id/twoFactor` | `two_factor_credentials`, `backup_codes` | | |
| `restaurants/$restId/customRoles/$id` | `custom_roles` | `$id` | |
| `restaurants/$restId/roleOverrides`, `disabledRoles` | `role_overrides` | role name | Two trees, one table |
| `systemData/platformUsers/$uid` | `platform_users` | `$uid` | Platform-level, no `restaurant_id` |
| `restaurants/$restId/tables/table_N` | `tables` | `table_N` | `number` parsed from key when absent |
| `restaurants/$restId/categories/$catId` | `menu_categories` | `$catId` | Self-referencing `parent_id` for `sub/$subId` |
| `restaurants/$restId/kitchenStations/$id` | `kitchen_stations` | `$id` | |
| `restaurants/$restId/menu/$menuId` | `menu_items` | `$menuId` | `name` `{uz,ru,en}` → jsonb |

---

## 3. Orders domain (Wave 2 — migration 0004)

### 3.1 `orders/$orderId` → `orders`

| Firebase | PostgreSQL | Rule |
|---|---|---|
| *(key)* | `legacy_rtdb_id` | verbatim push id |
| `orderNumber` | `order_number` | unique per `(restaurant, order_type, number)` |
| `orderType` / `isDelivery` / `deliveryType` | `order_type` | inferred from positive evidence only; `unknown` otherwise |
| `table` (string) | `table_id` FK + `table_label` | label kept when FK unresolvable |
| `waiterId`, `chefId`, `createdByWaiterId` | `waiter_id`, `chef_id`, `created_by_employee_id` | FK to `employees`, nullable |
| `customerId`/`customerPhone` | `customer_id` FK | matched on `normalized_phone` |
| `customerName`, `customerPhone` | `customer_name_snapshot`, `customer_phone_snapshot` | **denormalized on purpose** — see §3.6 |
| `statusV2`/`statusKey`/`status` | `status` + 4 `*_raw` columns | precedence rule |
| `total`, `originalTotal`, `discount`, `deliveryFee`, … | `numeric(14,2)` columns | |
| `payment.*` | `payments` table | own entity — see §3.5 |
| `paymentMethod: "pending"` | `payment_status` | **status, not method** |
| `deliveryAddress` | `delivery_address jsonb` | polymorphic object\|string |
| `createdAt`, `updatedAt`, `paidAt`, `readyAt`, … | `timestamptz` columns | |
| `inventoryDeducted`, `chefScoreAwarded` | boolean columns | were `runTransaction` flags |
| *(anything else)* | `extra jsonb` | |

### 3.2 `orders/$id/items/$compositeKey` → `order_items`

The example from the brief, as actually implemented:

```
Firebase                                   PostgreSQL
─────────────────────────────────────────  ─────────────────────────────────
items["-OyOw…__1785423216420"]             order_items
  .id       "-OyOw…"          ─────────►     legacy_menu_id  (raw)
                              ─────────►     menu_item_id    (resolved FK, nullable)
  (key)     "-OyOw…__1785…"   ─────────►     legacy_rtdb_id
  .name     {uz,ru,en} | str  ─────────►     name_snapshot   jsonb   IMMUTABLE
  .price    35000             ─────────►     price_snapshot  num(14,2) IMMUTABLE
  .qty      2                 ─────────►     qty             num(12,3)
  (absent)                    ─────────►     line_total = price × qty  (computed, reported)
  .modifiers                  ─────────►     modifiers       jsonb   IMMUTABLE
  .extras                     ─────────►     extras          jsonb   IMMUTABLE
  .status   "pending"         ─────────►     status + status_raw
  .kitchenStatus "prepared"   ─────────►     kitchen_status  (separate axis)
```

**Snapshot immutability.** `name_snapshot`, `price_snapshot`, `modifiers` and
`extras` record the dish **as sold**. `menu_item_id` is a soft pointer for
reporting only. Nothing in this table is ever recomputed from `menu_items`,
so repricing a dish tomorrow cannot alter last month's receipt.

This is also why `menu_item_id` is `ON DELETE RESTRICT` while
`combo_items.component_menu_item_id` is `ON DELETE CASCADE`: discontinuing a
dish may drop it from a combo, but must never remove a line from a
historical order.

### 3.3 `orders/$id/statusHistory` → `order_status_history`

The tree is keyed **by status name**, value = timestamp:

```
statusHistory: { order_created: 1785…, preparing: 1785…, completed: 1785… }
        ↓  one row per status
order_status_history(order_id, status, status_raw, changed_at, source)
```

`UNIQUE (order_id, status_raw, changed_at)` mirrors the fact that RTDB keys
cannot repeat, and makes re-runs idempotent.

### 3.4 `orderTimeline/$orderId/$pushId` → `order_timeline`

A separate, richer event tree. `legacy_order_id` is `NOT NULL` and `order_id`
is nullable, so timeline events for an order that failed to migrate are still
captured rather than discarded.

### 3.5 `orders/$id/payment` → `payments`

Promoted from an embedded object to its own table because the app already
treats it as independent state (its own guarded `runTransaction`) and
`finalTotal` can differ from `orders.total`.

| Firebase | PostgreSQL |
|---|---|
| `payment.method` `"Naqd"`/`"cash"` | `method` = `cash`, `method_raw` = `"Naqd"` |
| `payment.paid`, `paidAt` | `paid`, `paid_at` |
| `payment.finalTotal` | `amount`, `final_total` |
| `payment.serviceFeeAmount` | `service_fee_amount` |
| `payment.kassir` | `legacy_cashier` (+ `cashier_id` FK when resolvable) |
| `payment.requested`, `approved`, `adminNotified` | booleans |

### 3.6 Deliberate denormalization

Three places keep a copy on purpose. Each is a **historical fact**, not a
cache:

| Column | Why it is not redundant |
|---|---|
| `orders.customer_name_snapshot` / `customer_phone_snapshot` | The customer may rename, change number, or be deleted; the order must still show who it was for. |
| `order_items.name_snapshot` / `price_snapshot` | A receipt is immutable. |
| `purchase_order_items.name_snapshot` / `unit_price_snapshot` | A PO is a historical document. |

`customers.orderIds` is **not** carried over — it is derivable from
`orders.customer_id`, and duplicating it invites divergence.

### 3.7 Customers

```
restaurants/$restId/customers/%2B998902651475
        ↓
customers.id                  = <generated uuid>          (PK — never the phone)
customers.legacy_rtdb_id      = "%2B998902651475"         (exact RTDB key)
customers.original_phone_key  = "+998902651475"           (decoded)
customers.normalized_phone    = "+998902651475"           (E.164, UNIQUE per restaurant)
```

- Percent-encoded keys are decoded safely (a lone `%` does not throw).
- Bare 9-digit Uzbek numbers expand to `+998…` — the **only** inference made,
  applied only to exactly-9-digit input.
- Unparseable keys still migrate with `normalized_phone = NULL` and are
  excluded from the partial unique index.
- **Customers are never merged.** Two rows sharing a normalized phone are
  reported as `duplicate_normalized_phone_in_restaurant` for manual review.
- `savedAddresses/$pushId` → `customer_addresses` (own table, written
  individually by the app).

---

## 4. Finance and inventory (Wave 3 — migration 0005)

| Firebase path | PostgreSQL | Normalization |
|---|---|---|
| `expenses/$id` | `expenses` | |
| `cashCounts/$id` | `cash_counts` | `difference` stored as recorded, not recomputed |
| `finance/payments/$id` | `finance_entries` | signed `direction` |
| `finance/payroll/$monthKey/$staffId` | `payroll_entries` | `$monthKey` → `period_month date` |
| `finance/adjustments/$staffId/$monthKey` | `payroll_entries` (`entry_kind='adjustment'`) | same |
| `finance/staff_stats/$staffId/$monthKey` | `staff_stats` | `$monthKey` → `period_month date` |
| `finance/courier_stats/$courierId/$monthKey` | `staff_stats` (`stat_scope='courier'`) | same |
| `inventory/$id` **and** `ingredients/$id` | `inventory_items` (one table) | `tracked_as` records provenance; disagreements reported |
| `dailyUsage/$dateKey/$ingId` | `daily_usage` | `$dateKey` → `usage_date date`; UNIQUE replaces the transaction |
| `menu/$id/recipe[]` | `recipes` + `recipe_items` | embedded array normalized |
| `semiFinished/$id`, `semiFinishedActs/$id` | `semi_finished`, `semi_finished_acts` | |
| `suppliers/$id` | `suppliers` | |
| `purchaseOrders/$id` | `purchase_orders` + `purchase_order_items` | embedded lines normalized, snapshotted |
| `poPayments/$id` | `supplier_payments` | |
| `debts/$id` | `debts` | polymorphic counterparty + `CHECK` |

*(Stock history has no RTDB source — `inventory/$id/stock` is mutated in
place. `stock_movements` is the forward-looking ledger; it is seeded only
from `dailyUsage`, never fabricated.)*

---

## 5. Kitchen and operations (Wave 4 — migration 0006)

| Firebase path | PostgreSQL | Key normalization |
|---|---|---|
| `attendance/$dateKey/$userId` | `attendance` | `work_date date` + `employee_id`; UNIQUE on both |
| `shifts/$id` | `shifts` | |
| `chefTasks/$chefId/$dateKey/$taskId` | `chef_tasks` | `chef_id` + `task_date date` |
| `prepSchedule/$chefId/$dateKey/$itemId` | `prep_schedule` | `chef_id` + `prep_date date` |
| `wasteLog/$dateKey/$entryId` | `waste_log` | `waste_date date` |
| `equipmentStatus/$id`, `maintenance/$type/$id` | `equipment_status` | |
| `equipmentPrinters/$id` | `equipment_printers` | |
| `kitchenInventory/$id` | `kitchen_inventory` | separate from `inventory_items` — different count |
| `kitchenAnnouncements/$dateKey/$id` | `kitchen_announcements` | `announced_date date`; `readBy` → jsonb |
| `productionPlans/$dateKey/items/$menuId` | `production_plans` | `plan_date date` + `menu_item_id` |
| `modifiers/$id`, `extras/$id` | `modifiers`, `extras` | separate tables, not one generic table |
| `stopList/$productId` | `stop_list` | key **is** the menu id |
| `discounts/$code` | `discounts` | key **is** the code → `UNIQUE (restaurant_id, code)` |
| `promotions/$id` | `promotions` | |
| `printSettings`, `terminalSettings` | `print_settings`, `terminal_settings` | singletons — PK is `restaurant_id` |

---

## 6. Communications and audit (Wave 5 — migration 0007)

| Firebase path | PostgreSQL | Note |
|---|---|---|
| `chats/$chatId/{meta,messages}` | `chats` + `chat_messages` | |
| `superadmin_chat/$id` | `chats` (`chat_kind='superadmin'`) | |
| `orderChats/$orderId/chef/{meta,messages}` | `order_chats` + `order_chat_messages` (0004) | channel is a column |
| `auditLog/$id` | `audit_log` (`source_tree='auditLog'`) | **collision** — see below |
| `audit_log/$id` | `audit_log` (`source_tree='audit_log'`) | **collision** |
| `activityLogs/$id` | `activity_logs` | kept separate on purpose |
| `notifications/$id`, `kitchenNotifications/$id` | `notifications_log` | |
| `systemAlerts/$type` | `system_alerts` | key is the type → UNIQUE |
| `feedback/$id` | `feedback` | |
| `customerNotes/$phoneKey/$id` | `customer_notes` | phone → `customer_id` FK |
| `approvals/$id` | `approvals` | |
| `importHistory/$id` | `import_history` | |
| `discountClaims/$restId/$token` | `discount_claims` | **root-level**; currently empty |

**The audit collision.** `auditLog` (backend) and `audit_log` (frontend) are
the same kind of record written by two code paths, so they share a table with
a `source_tree` discriminator — merging them without it would make the writer
unknowable. `activityLogs` is a user-facing feed, not a security trail, and
stays its own table.

---

## 7. Explicitly NOT migrated

| Source | Reason |
|---|---|
| Root `orders`, `menu`, `customers`, `tables`, `users`, `settings`, `discounts`, `promocodes` (68,751), `clients`, `activityLogs`, `orderTimeline`, `waiterCalls`, `notifications`, `orderChats`, `tableStatus`, `offers`, `meta`, `chefChats`, `auditLogs` | Pre-multi-tenant legacy, stale since Mar–May 2026. No defensible `restaurant_id` — assigning one would invent a tenant relationship (rule #20). Left untouched in Firebase. |
| `restaurants_meta` | Denormalized superadmin mirror of `restaurants`. Migrating it would duplicate the source of truth. Should become a view or query in Phase 2. Also contains a future-dated record (2027-08-10) and one orphan. |
| `meta/orderCounterOrd`, `orderCounterDvr` | Counters, not data. Become sequences in Phase 2. Current values must be read before Phase 2 issues new numbers. |
| `customers/$phone/orderIds` | Derivable from `orders.customer_id`. |
| `.info/connected`, `.info/serverTimeOffset` | Firebase SDK internals. |
| `systemData/**` platform trees | Platform-level, not tenant data. Partially covered by `platform_users` (0001); the rest is out of Phase 1 scope. |

Every one of these is **inventoried** in `FIREBASE_RTDB_INVENTORY.md`. Not
migrating is a documented decision, not an oversight — and reversible, since
the engine can add a wave for any of them.

---

## 8. Dependency-ordered migration graph

FK requirements, which match the brief's recommended phases:

```
organizations
    └── restaurants
          ├── restaurant_settings, restaurant_modules, print_settings, terminal_settings
          ├── employees ──── employee_credentials, two_factor_credentials, backup_codes
          │      └── custom_roles, role_overrides
          ├── menu_categories (self-ref: parent_id)
          ├── kitchen_stations
          │      └── menu_items ──── combo_items, recipes ── recipe_items
          ├── tables
          ├── customers ──── customer_addresses
          ├── couriers
          ├── suppliers ──── purchase_orders ── purchase_order_items
          │                        └── supplier_payments
          ├── inventory_items ──── stock_movements, daily_usage
          │
          └── orders   ◄── requires tables, employees, customers, menu_items
                ├── order_items         (needs menu_items)
                ├── order_status_history
                ├── order_timeline
                ├── order_change_requests (needs order_items)
                ├── order_chats ── order_chat_messages
                ├── payments            (needs employees)
                └── courier_assignments (needs couriers)
```

The engine's `ENTITIES` list follows this order:
**customers → couriers → orders → order_change_requests →
courier_assignments → reservations**, with `order_items`,
`order_status_history` and `payments` fanned out from each order.
