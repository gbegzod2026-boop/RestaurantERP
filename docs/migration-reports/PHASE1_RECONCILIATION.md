# Phase 1 Reconciliation Report

Generated from `dry-run-latest.json` (2026-08-23). Raw machine-readable
evidence for every number below is in this directory.

**Mode: transform-only.** No PostgreSQL instance was reachable in this
environment, so the pipeline read Firebase, transformed every record,
resolved every foreign key against Firebase-side reference maps, and
accounted for every outcome — but no rows were written. Anything requiring a
live database is marked **NOT VERIFIED** rather than assumed.

---

## 1. Scope discovered

| | Count |
|---|---|
| Restaurants scanned | 46 |
| Restaurants holding any Wave 2 data | **5** |
| Firebase REST reads performed | 461 |
| Firebase writes performed | **0** |

41 of 46 restaurants are empty shells with no orders, customers or
reservations — consistent with the discovery finding that most tenants were
created and never used.

## 2. Records reconciled

| Entity | Firebase | Accounted | Would migrate | Skipped | Failed | Duplicate | Malformed | Balanced |
|---|---|---|---|---|---|---|---|---|
| customers | 8 | 8 | 8 | 0 | 0 | 0 | 0 | yes |
| couriers | 5 | 5 | 5 | 0 | 0 | 0 | 0 | yes |
| orders | 59 | 59 | 59 | 0 | 0 | 0 | 0 | yes |
| order_items | 147 | 147 | 147 | 0 | 0 | 0 | 0 | yes |
| order_status_history | 138 | 138 | 138 | 0 | 0 | 0 | 0 | yes |
| payments | 54 | 54 | 54 | 0 | 0 | 0 | 0 | yes |
| reservations | 6 | 6 | 6 | 0 | 0 | 0 | 0 | yes |
| order_change_requests | 4 | 4 | 4 | 0 | 0 | 0 | 0 | yes |
| courier_assignments | 1 | 1 | 1 | 0 | 0 | 0 | 0 | yes |
| **Total** | **422** | **422** | **422** | **0** | **0** | **0** | **0** | **yes** |

Balanced means `firebaseRecords == migrated + skipped + failed + duplicate +
malformed` for every entity. Any other result exits non-zero.

## 3. Per restaurant

| Restaurant | Records | Breakdown |
|---|---|---|
| `rest_1784740340104` | 376 | 50 orders, 137 items, 120 history, 50 payments, 7 customers, 2 couriers, 5 reservations, 4 change requests, 1 courier assignment |
| `rest_1784435205227` | 39 | 8 orders, 9 items, 15 history, 4 payments, 1 customer, 2 couriers |
| `rest_1784739423806` | 5 | 1 order, 1 item, 3 history |
| `rest_1782463735809` | 1 | 1 courier |
| `rest_1785412219523` | 1 | 1 reservation |

## 4. Data loss

**0 records lost, skipped, failed, duplicated or malformed.**

No customers were merged. Two phone key formats that normalize to the same
E.164 number would be reported as duplicates and left separate; none occurred
in this dataset.

## 5. Warnings — migrated, but worth knowing

234 warnings across 422 records. All are disclosures of a derivation or an
unresolved reference; none indicates a lost record.

| Code | Count | What it means |
|---|---|---|
| `line_total_computed_from_price_x_qty` | 147 | **Every** order item. No item in production stores a total, so the line total is computed. Disclosed rather than presented as source data. |
| `order_type_inferred_dine_in_from_table_present` | 44 | `orderType` absent; the record carries a `table`, so dine-in is inferred from that evidence. |
| `employee_reference_unresolved` | 29 | An order names a `waiterId`/`chefId` that no longer exists. FK is left NULL. |
| `menu_item_reference_unresolved` | 10 | An order item references a deleted dish. `name_snapshot`, `price_snapshot` and `legacy_menu_id` preserve what the order said. |
| `table_reference_unresolved` | 3 | An order names a table that no longer exists. `table_label` preserves it. |
| `order_type_inferred_delivery_from_record_evidence` | 1 | Inferred from `isDelivery`/`deliveryAddress`. |

The 42 unresolved references are the expected consequence of staff, dishes
and tables being deleted while their historical orders remain. They are why
the snapshot columns exist, and they are the reason `menu_item_id` uses
`ON DELETE RESTRICT` rather than `CASCADE`.

## 6. Verification status

| Claim | Status | Evidence |
|---|---|---|
| Firebase not modified | **VERIFIED** | `fbRead.mjs` exports no mutating verb; 461 reads, 0 writes |
| Every record accounted for | **VERIFIED** | all 9 entities balanced |
| Money is lossless | **VERIFIED** | no value exceeds 1dp; `numeric(14,2)` is exact for this dataset |
| Statuses all map | **VERIFIED** | 0 unknown-status skips across 59 orders |
| Resume works | **VERIFIED** | resumed run skipped all 114 restaurant/entity pairs, reprocessed 0 records |
| `--apply` refuses without a database | **VERIFIED** | exits 2 |
| Transform is deterministic | **VERIFIED** | `db/tests/migration.test.mjs` |
| Schema rules hold | **VERIFIED** (statically) | `db/tests/schema.test.mjs`, 20 checks |
| Migration + normalization tests | **VERIFIED** | 111 passing, 0 failing |
| SQL applies to PostgreSQL | **NOT VERIFIED** | no instance available |
| RLS denies cross-tenant access | **NOT VERIFIED** | 3 test files skipped, not run |
| Postgres row counts match Firebase | **NOT VERIFIED** | nothing written |
| Index plans | **NOT VERIFIED** | no `EXPLAIN ANALYZE` possible |

## 7. Data-integrity findings for the product owner

Pre-existing conditions in live data, not migration defects:

1. **3 employees have `role: ""`** and **1 has a custom-role push id in the
   `role` field** (`-OyrlzxVx-_w5fMcKKy9`). Migration 0008 adds
   `custom_roles.legacy_rtdb_id` specifically so that reference is still
   resolvable; the empty roles need a human decision.
2. **A `restaurants_meta` record is dated 2027-08-10** — roughly a year in the
   future. Client clock skew or a wrong-unit write.
3. **47 `restaurants_meta` records against 46 restaurants** — one orphan.
4. **`discountClaims` has security rules and application code but no data.**
   Worth confirming the QR discount feature works at all.
5. **68,751 `promocodes` at the Firebase root, untouched since 2026-03-03.**
   Confirm they are dead before archiving.
6. **41 of 46 restaurants have no operational data.** Likely abandoned
   signups; confirm before migrating them as active tenants.

## 8. Reproduce

```bash
cd backend
npm run db:migrate:firebase:dry-run    # 422 records, all balanced, ~100s
npm run db:migrate:firebase:resume     # 0 reprocessed
npm run db:test                        # 111 pass, 3 skipped (need a database)
```
