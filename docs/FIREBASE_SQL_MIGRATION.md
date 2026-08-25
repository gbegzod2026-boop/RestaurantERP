# Firebase → PostgreSQL Migration Guide

Operational documentation for the Phase 1 migration system.

**Phase 1 builds the PostgreSQL data layer and the migration tooling.
Firebase remains the live application database.** Nothing in this phase
changes what the running application reads or writes.

**Phase 1 status: PRODUCTION-READY** for the migration infrastructure
(schema, RLS, apply, idempotency, reconciliation). It is **not** an
application cutover. Do not switch the running app to PostgreSQL until
the later API + realtime phase.

Verified on 2026-08-23 against a real local PostgreSQL 16.15 server
(`localhost:5432`, database `postgres`). Evidence files:

- `docs/migration-reports/catalog-verification.json`
- `docs/migration-reports/apply-2026-08-23T15-31-57-730Z.json` (first apply)
- `docs/migration-reports/apply-2026-08-23T15-45-53-065Z.json` (second apply)
- `docs/migration-reports/fk-explain-verification.json`

---

## Verification matrix

| Criterion | Status | Evidence |
|---|---|---|
| PostgreSQL reachable | PASS | `SELECT version()` → PostgreSQL 16.15, database `postgres`, user `postgres` @ `localhost:5432` |
| Migrations executed 0001–0010 | PASS | `schema_migrations` contains 0001…0010; `npm run db:migrate:up` applied each file with no SQL error |
| 77 expected application tables exist | PASS | `pg_class` counts **78** public tables = 77 from SQL + `schema_migrations` |
| Constraints exist | PASS | 150 UNIQUE/PK, 60 CHECK, 150 FK (`pg_constraint`) |
| Indexes exist | PASS | **314** indexes in `pg_index` (public) |
| RLS enabled | PASS | 73 tables `relrowsecurity = true` |
| FORCE ROW LEVEL SECURITY | PASS | 73 tables `relforcerowsecurity = true`; none enabled-but-unforced |
| RLS policies exist | PASS | **290** rows in `pg_policies` |
| Tenant isolation (A cannot SELECT/UPDATE/DELETE B) | PASS | `npm run db:test:rls`: Wave 0 13/13, Wave 1 8/8, Wave 2 21/21 |
| Platform/privileged access | PASS | empty `app.current_restaurant_id` sees both restaurants; `nesta_login_reader` can read `password_hash`, `nesta_app` cannot |
| Cross-tenant order_item FK | PASS | composite FK `(order_id, restaurant_id) → orders(id, restaurant_id)` returns SQLSTATE `23503` |
| Firebase dry-run against live PG | PASS | `npm run db:migrate:firebase:dry-run`; upserts inside a rolled-back transaction |
| `--apply` executed | PASS | first apply: **1604 inserted, 0 updated**; Firebase untouched |
| Idempotent second `--apply` | PASS | second apply: **0 inserted, 1604 updated**; row counts unchanged; no duplicates |
| `firebase_vs_postgres` reconciliation | PASS | every migrated entity `diff = 0` (postgres rows = migrated). 3 `audit_log` rows malformed (missing `createdAt`). 2 restaurants skipped (Wave 1 malformed, no `info.domain`/`name`) |
| FK integrity (no unexpected orphans) | PASS | live LEFT JOIN counts all 0 for orders/items/payments/customers/employees/tables/recipes/inventory/reservations/chats. Unresolved staff/menu FKs are NULL by policy, not orphans |
| EXPLAIN ANALYZE | PASS | 10 representative queries executed. Seq scans appear because the live set is tiny (59 orders); required indexes exist in the catalog. No extra indexes added |
| Schema tests | PASS | `db/tests/schema.test.mjs` |
| Normalization tests | PASS | `db/tests/normalize.test.mjs` |
| Migration transform tests | PASS | `db/tests/migration.test.mjs` |
| RLS tests | PASS | all three RLS files, `REQUIRE_DB=1`, **0 skipped** |
| Full `npm run db:test` | PASS | **114 passed, 0 failed, 0 skipped** |
| Existing `node server.js` still boots | PASS | listened on the configured port; Firebase RTDB still the live store; no cutover |
| Waves 3–5 transforms | PASS | implemented for live multi-tenant trees (finance, inventory, kitchen, comms/audit). Stale root trees not migrated |
| Stale root `promocodes` (68,751) | NOT APPLICABLE | inventoried; no defensible `restaurant_id`; left in Firebase, not deleted |
| Application cutover to PostgreSQL | NOT APPLICABLE | Phase 2 |

---

## Snapshot (the 16 required facts)

1. **PostgreSQL version:** PostgreSQL 16.15 (Visual C++ build 1944, 64-bit)
2. **Database name:** `postgres` on `localhost:5432`
3. **Migration version:** `0010_order_number_not_unique` (0001–0010 applied)
4. **Number of tables:** 78 public (`77` from migrations + `schema_migrations`)
5. **Number of indexes:** 314
6. **Number of RLS policies:** 290 (73 tables RLS enabled **and** FORCEd)
7. **Migrated records by entity** (second apply, `firebase_vs_postgres`):

| Entity | Firebase | PostgreSQL | Diff |
|---|---:|---:|---:|
| restaurants (Wave 1) | 46 | 44 | 2 skipped (malformed `info`) |
| employees | — | 82 | Wave 1 |
| tables | — | 35 | Wave 1 |
| menu_categories | — | 335 | Wave 1 (6 real + 329 static seeds) |
| kitchen_stations | — | 319 | Wave 1 |
| menu_items | — | 21 | Wave 1 |
| combo_items | — | 3 | Wave 1 |
| customers | 8 | 8 | 0 |
| couriers | 4 | 4 | 0 |
| orders | 59 | 59 | 0 |
| order_items | 147 | 147 | 0 |
| order_status_history | 138 | 138 | 0 |
| order_timeline | 15 | 15 | 0 |
| payments | 54 | 54 | 0 |
| order_change_requests | 4 | 4 | 0 |
| courier_assignments | 1 | 1 | 0 |
| reservations | 6 | 6 | 0 |
| expenses | 20 | 20 | 0 |
| suppliers | 2 | 2 | 0 |
| inventory_items | 13 | 13 | 0 |
| purchase_orders | 3 | 3 | 0 |
| purchase_order_items | 3 | 3 | 0 |
| supplier_payments | 1 | 1 | 0 |
| recipes | 9 | 9 | 0 |
| recipe_items | 11 | 11 | 0 |
| semi_finished | 6 | 6 | 0 |
| semi_finished_acts | 6 | 6 | 0 |
| payroll_entries | 12 | 12 | 0 |
| staff_stats | 12 | 12 | 0 |
| attendance | 43 | 43 | 0 |
| shifts | 2 | 2 | 0 |
| chef_tasks | 145 | 145 | 0 |
| waste_log / kitchen_announcements / production_plans | 0 / 15 / 11 | same | 0 |
| modifiers / extras / discounts / waiter_calls | 1 / 1 / 1 / 2 | same | 0 |
| activity_logs | 658 | 658 | 0 |
| audit_log | 34 | 31 | 3 malformed (no `createdAt`) |
| notifications_log | 96 | 96 | 0 |
| chats / chat_messages | 45 / 5 | 45 / 5 | 0 |
| system_alerts / import_history / print_settings / terminal_settings | 9 / 1 / 2 / 2 | same | 0 |

Wave 2–5 first apply: **1604 inserted / 0 updated**. Second apply: **0 inserted / 1604 updated**.

8. **Reconciliation result:** PASS (`firebase_vs_postgres`, every migrated entity `diff = 0`)
9. **RLS result:** PASS (42 checks across three suites; FORCE RLS takes effect — table owner still isolated under `SET ROLE nesta_app`)
10. **FK integrity result:** PASS (0 unexpected orphans)
11. **Idempotency result:** PASS (second apply created no new rows)
12. **Test result:** 114 passed, 0 failed, 0 skipped (`REQUIRE_DB=1`)
13. **EXPLAIN ANALYZE findings:** all 10 probes finished in **< 1 ms**. The planner chose sequential scans on `orders` / `order_items` / `payments` because those tables hold tens of rows, not thousands. Catalog indexes for `(restaurant_id, created_at)`, `(restaurant_id, status)`, `order_id`, `customer_id`, `table_id`, `waiter_id`, `menu_items(restaurant_id)` exist. No additional indexes were added — they would not change these plans at current cardinality.
14. **Remaining manual review items:** see §10
15. **Known data-quality issues:** see §10
16. **Phase 1 PRODUCTION-READY?** **YES** for migration infrastructure. **NO** application cutover. Firebase is still the source of truth for the running app.

---

## 1. Safety guarantees

| Guarantee | How it is enforced |
|---|---|
| **Firebase is never written to** | All Firebase access goes through `db/scripts/lib/fbRead.mjs`. Only HTTP `GET`. No `set`/`update`/`push`/`remove`/`transaction` export. |
| **Dry-run persists nothing** | With PostgreSQL, `--dry-run` runs the real `ON CONFLICT` upserts inside a transaction that is always `ROLLBACK`'d. Without PostgreSQL it is transform-only. |
| **Re-runs converge** | `ON CONFLICT … DO UPDATE` on each table's real UNIQUE key. Second apply: 0 inserts, same counts. |
| **Nothing is lost silently** | Every record ends in exactly one of six outcomes; anything not `migrated` gets a Firebase path, legacy id, reason and severity. |
| **Unknown values are never coerced** | `mapEnum()` fails an unmapped value. CHECK-constrained statuses that the live data does not match become `unknown` **and** keep `status_raw`. |
| **Absent timestamps are not stored as NULL** | `created_at` / `updated_at` are omitted from the INSERT when Firebase has no value, so `DEFAULT now()` fills them (Wave 1's "generated, not legacy" rule). They are never invented in the transform itself. |

```powershell
Select-String -Path backend\db\scripts\lib\fbRead.mjs -Pattern '^export'
```

---

## 2. Commands

```bash
# Schema
npm run db:migrate:status
npm run db:migrate:up

# Wave 1 master data (restaurants / employees / tables / menu)
node db/scripts/migrate-wave1-apply.mjs --dry-run --fresh
node db/scripts/migrate-wave1-apply.mjs --apply --fresh

# Waves 2–5
npm run db:migrate:firebase:dry-run
npm run db:migrate:firebase            # --apply
npm run db:migrate:firebase:verify

# Tests (REQUIRE_DB=1 so a missing database cannot skip)
set REQUIRE_DB=1
npm run db:test
npm run db:test:rls
```

Engine flags: `--restaurant <id>`, `--limit <n>`, `--resume`,
`--reset-checkpoint`. Apply ignores a leftover dry-run checkpoint unless
`--resume` is passed.

---

## 3. The required order

```
1. npm run db:migrate:up
2. node db/scripts/migrate-wave1-apply.mjs --apply
3. npm run db:migrate:firebase:dry-run
4. Read the report. Every entity BALANCED; data-loss entries accepted.
5. npm run db:migrate:firebase
6. npm run db:migrate:firebase          # second time — must insert 0
7. REQUIRE_DB=1 npm run db:test
```

Wave 1 must exist in PostgreSQL before Wave 2 `--apply`: orders FK
`restaurant_id` to `restaurants(id)`.

---

## 4. Transform-only vs live-write dry-run

If PostgreSQL is unreachable the engine still performs a complete
transform-only dry run. It detects this with `SELECT 1`, not by checking
whether `POSTGRES_*` variables exist.

`--apply` refuses to run without a verified connection.

Live `--apply` / `--verify` reconciliation basis is **`firebase_vs_postgres`**
(actual `count(*)` per table). Transform-only and rolled-back dry-runs
report `firebase_vs_transform_pipeline`.

---

## 5. Reading the report

Every record lands in exactly one bucket:

| Outcome | Meaning |
|---|---|
| `migrated` | Transformed successfully (and written, in `--apply`) |
| `skipped` | Valid record the rules decline to migrate; reason recorded |
| `failed` | Transform or insert error |
| `duplicate` | Conflicting legacy id or normalized phone; **never merged** |
| `malformed` | Missing required field or wrong shape |

A run is only balanced when
`firebaseRecords == migrated + skipped + failed + duplicate + malformed`
for every entity, and (on apply/verify) `postgresRows == migrated`.

### Warnings vs. data loss (live apply)

| Code | Count | Meaning |
|---|---|---|
| `line_total_computed_from_price_x_qty` | 147 | No order item stores a total; computed from price × qty |
| `order_type_inferred_dine_in_from_table_present` | 44 | `orderType` absent; inferred from a `table` field |
| `employee_reference_unresolved` | 29 | waiter/chef no longer exists; FK NULL, labels kept |
| `menu_item_reference_unresolved` | 10 | deleted dish; **snapshot preserves name/price** |
| `order_type_inferred_delivery_from_record_evidence` | 1 | inferred from `isDelivery` / `deliveryAddress` |
| `createdAt_missing` | 3 | `audit_log` rows with no timestamp — not inserted (`created_at` is NOT NULL without DEFAULT; inventing `now()` would be silent history) |
| `restaurant_not_in_postgres` | 2 | Wave 1 skipped these restaurants (`info` has no domain/name) |

---

## 6. Idempotency

Verified by running `--apply` twice against the same Firebase snapshot:

| | Inserted | Updated | PostgreSQL orders |
|---|---:|---:|---:|
| First apply | 1604 | 0 | 59 |
| Second apply | 0 | 1604 | 59 |

`legacy_rtdb_id` mappings are stable. `ON CONFLICT` targets include
`(restaurant_id, legacy_rtdb_id)` for most tables, plus table-specific
keys (`order_items (order_id, legacy_rtdb_id)`, `payments (restaurant_id,
legacy_order_id, legacy_rtdb_id)`, `discounts (restaurant_id, code)`,
singleton `print_settings (restaurant_id)`, etc.).

---

## 7. Tests

| File | Needs a DB? | Proves |
|---|---|---|
| `schema.test.mjs` | no | UUID PKs, `legacy_rtdb_id`, `numeric(14,2)`, `timestamptz`, RLS wired, 53 mandated entities |
| `normalize.test.mjs` | no | Money, timestamps, phones, date keys, every live status |
| `migration.test.mjs` | no | Transforms: determinism, snapshots, malformed handling, report accounting |
| `rls.test.mjs` | yes | Wave 0 isolation + role escalation + credential grants |
| `rls-wave1.test.mjs` | yes | Wave 1, including subquery RLS on `combo_items` |
| `rls-wave2.test.mjs` | yes | Waves 2–5 catalog-driven RLS + FORCE + FK indexes + the four denials |

Defects found **during this verification** and fixed (not weakened):

1. `--apply` previously transformed without INSERTing. Write path is now real upserts.
2. Five FKs had no **leading** index (`courier_assignments.order_id`, `employees.custom_role_id`, `menu_items.kitchen_station_id`, `menu_items.subcategory_id`, `order_change_requests.order_item_id`). **0009** adds them.
3. RLS does not apply to FK lookups. A tenant could stamp its own `restaurant_id` and point `order_id` at another restaurant's order. **0009** replaces those FKs with `(order_id, restaurant_id) → orders(id, restaurant_id)`.
4. Live data has two dine-in orders sharing an `order_number`. **0010** drops that UNIQUE index (lookup index remains). Identity is still `(restaurant_id, legacy_rtdb_id)`.
5. `created_at`/`updated_at` NULL from Firebase violated `NOT NULL DEFAULT now()`. Upsert now omits those columns so the default applies.
6. A string `deliveryAddress` was parsed into a JS string and sent to `jsonb` as raw text. Primitives now keep the encoded JSON text.

---

## 8. Schema follow-ups applied on the live server

| Version | Why |
|---|---|
| 0008 | `custom_roles.legacy_rtdb_id` (already present) |
| 0009 | leading FK indexes + tenant-aligned composite FKs to `orders` |
| 0010 | `order_number` uniqueness relaxed to match live duplicates |

---

## 9. Waves 3–5

Transforms now cover live multi-tenant trees:

- Wave 3 — expenses, suppliers, `inventory` ∪ `ingredients`, purchase orders + line items, PO payments, recipes from `menu/$id/recipe`, daily usage, semi-finished + acts, payroll / adjustments / staff_stats / courier_stats
- Wave 4 — attendance, shifts, chef tasks, waste, kitchen announcements, production plans, modifiers, extras, discounts, stop list, print/terminal settings
- Wave 5 — activity logs, `auditLog` + `audit_log` (distinguished by `source_tree`), notifications, kitchen notifications, system alerts, import history, order timeline, chats + messages, superadmin_chat

Not migrated (no valid restaurant ownership — documented, not deleted):

- Root `promocodes` (**68,751**, last written 2026-03-03)
- Other pre-multi-tenant roots (`orders`, `menu`, `customers`, … at the Firebase root)
- `restaurants_meta`, counters, empty `discountClaims`

---

## 10. Data-integrity findings for manual review

These are live Firebase facts, **not** migration bugs.

1. **Two restaurants have no `info.domain` / `info.name`** — `rest_1782463735809`, `rest_1783835628681`. Wave 1 skipped them; Wave 2–5 therefore cannot attach rows. Still present in Firebase.
2. **Three `audit_log` entries have no `createdAt`** under `rest_1784740340104`. Refused rather than stamped with `now()`.
3. **29 unresolved employee references** on orders — staff deleted; FK NULL; labels kept.
4. **10 unresolved menu-item references** — snapshots keep the sold name/price.
5. **`users.role` corruption** — empty role strings; one custom-role push id in `role` (0008 exists to resolve it).
6. **`restaurants_meta` future timestamp** (2027-08-10) and 47 mirror records vs 46 restaurants.
7. **`discountClaims` has rules and code but no data.**
8. **68,751 stale root `promocodes`.** Inventoried. Not assigned a restaurant. Not deleted.

---

## 11. What Phase 2 must do first

Not part of this phase:

1. Read `meta/orderCounterOrd` / `orderCounterDvr` before issuing new order numbers from PostgreSQL.
2. Decide cutover: dual-write, or read-from-Postgres / write-to-both.
3. Replace RTDB listeners with a Postgres-backed realtime channel.
4. Implement the `stock_movements` ledger at the point of stock change.
5. Optionally run `node db/set-app-role-password.js` so `nesta_app` can log in with its own password. RLS was verified via `SET ROLE nesta_app` under `GRANT nesta_app TO CURRENT_USER`, which does not require that password.

The running application still uses Firebase. That is intentional.
