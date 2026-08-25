# PostgreSQL Index Strategy

Phase 1, requirement #11. Every index below traces to a **real query in the
codebase** or to a constraint the data requires. The brief's instruction "do
not blindly index every column" is taken literally: columns are indexed only
where a query, a foreign key join, or a uniqueness rule justifies it.

---

## 1. Where the query patterns came from

An exhaustive search of `backend/**` and `admin-frontend/public/js/**` for
`orderByChild`, `equalTo`, `limitToLast`, `limitToFirst`, `startAt` and
`endAt`. These are the only server-side-filtered reads the application
performs; everything else fetches a subtree and filters in JavaScript.

| RTDB query | File | → PostgreSQL index |
|---|---|---|
| `orders` `.orderByChild('createdAt').limitToLast(300)` | `admin.js`, `server.js` | `idx_orders_restaurant_created` |
| `orders` `.orderByChild('createdAt').limitToLast(500)` | `chef.js` | same |
| `courierAssignments` `.orderByChild('orderId').equalTo(id)` | `admin.js` | `idx_courier_assignments_order` |
| `activityLogs` `.orderByChild('createdAt').limitToLast(150)` | `admin.js` | `idx_activity_logs_restaurant_created` |
| `auditLog` `.orderByChild('createdAt').limitToLast(n)` | `auditLog.js` | `idx_audit_log_restaurant_created` |

The JavaScript-side filtering is just as important: `admin.js` repeatedly
loads a whole collection and filters by status, date range, table, employee
or customer. Those become real indexed predicates in Phase 2, which is why
the status and FK indexes below exist even though today's RTDB code cannot
express them.

---

## 2. Principles

1. **Tenant column first.** Almost every query is scoped to one restaurant,
   so composite indexes lead with `restaurant_id`. A standalone
   `restaurant_id` index is redundant when a composite already leads with it,
   but is kept where the table has no other common predicate.
2. **Descending time.** Every listing is "most recent first", so time columns
   are indexed `DESC`, with `NULLS LAST` where the column is nullable.
3. **Partial indexes for sparse FKs.** Optional foreign keys
   (`customer_id`, `table_id`, `courier_id`, …) are indexed
   `WHERE col IS NOT NULL`. On this dataset most are null, so the partial
   index is a fraction of the size and equally useful.
4. **Index every foreign key.** PostgreSQL does **not** create these
   automatically, and an unindexed FK makes every parent `DELETE` a sequential
   scan of the child table. This closes the "missing FK indexes" gap named in
   the earlier audit.
5. **Uniqueness is a constraint, not an index.** Where RTDB used a composite
   key or a `runTransaction` to prevent duplicates, that becomes a real
   `UNIQUE`.

---

## 3. Uniqueness constraints that replace RTDB behaviour

These are the most valuable objects in the schema — each one moves a
correctness guarantee from hand-written application code into the database.

| Constraint | Replaces |
|---|---|
| `UNIQUE (restaurant_id, legacy_rtdb_id)` on ~35 tables | RTDB key uniqueness; makes migration **idempotent** |
| `uq_orders_restaurant_type_number (restaurant_id, order_type, order_number)` | Two separate counters (`orderCounterOrd` / `orderCounterDvr`). Scoped by type because the same number legitimately repeats across types |
| `uq_customers_restaurant_phone (restaurant_id, normalized_phone) WHERE NOT NULL` | Phone-as-key, without making phone the PK |
| `reservation_slots (restaurant_id, slot_date, slot_time, table_number)` | `runTransaction` on `reservationSlots/{date}_{time}_{table}` |
| `daily_usage (restaurant_id, usage_date, legacy_item_id)` | `runTransaction` increment on `dailyUsage/$dateKey/$ingId` |
| `discount_claims (restaurant_id, token)` | `runTransaction` on `discountClaims/$restId/$token` |
| `attendance (restaurant_id, work_date, legacy_employee_id)` | Path shape `attendance/$dateKey/$userId` |
| `staff_stats (restaurant_id, legacy_employee_id, stat_scope, period_month)` | `runTransaction` merge on `staff_stats/$staffId/$monthKey` |
| `payroll_entries (restaurant_id, legacy_employee_id, period_month, entry_kind)` | Path shape `payroll/$monthKey/$staffId` |
| `stop_list (restaurant_id, legacy_menu_id)` | Path shape `stopList/$productId` |
| `discounts (restaurant_id, code)` | Path shape `discounts/$code` |
| `system_alerts (restaurant_id, alert_type)` | Path shape `systemAlerts/$type` |
| `order_status_history (order_id, status_raw, changed_at)` | Status-keyed history object |

---

## 4. Index inventory by table

### Orders domain (0004) — the hot path

| Index | Columns | Serves |
|---|---|---|
| `idx_orders_restaurant_created` | `(restaurant_id, created_at DESC)` | **The single most important index.** Every panel's order list |
| `idx_orders_restaurant_status` | `(restaurant_id, status)` | Kitchen/waiter boards filtered by state |
| `idx_orders_payment_status` | `(restaurant_id, payment_status)` | Cashier's unpaid list |
| `idx_orders_customer_id` | `(customer_id)` partial | Customer order history |
| `idx_orders_table_id` | `(table_id)` partial | Table's current order |
| `idx_orders_waiter_id` / `_chef_id` / `_courier_id` / `_created_by_employee_id` | partial | Per-staff reporting; FK delete performance |
| `idx_order_items_order_id` | `(order_id)` | Loading an order's lines |
| `idx_order_items_menu_item_id` | partial | "Which orders contained this dish" |
| `idx_order_status_history_order_id` | `(order_id)` | Order detail timeline |
| `idx_order_status_history_changed_at` | `(restaurant_id, changed_at DESC)` | Cross-order status reporting |
| `idx_order_timeline_restaurant_occurred` | `(restaurant_id, occurred_at DESC)` | Activity feed |
| `idx_payments_restaurant_paid_at` | `(restaurant_id, paid_at DESC NULLS LAST)` | Daily revenue |
| `idx_courier_assignments_order` | `(restaurant_id, order_id)` | **Direct replacement** for `orderByChild('orderId').equalTo()` |
| `idx_reservations_restaurant_date` | `(restaurant_id, reserved_date)` | Reservation calendar |
| `idx_customers_last_visit` | `(restaurant_id, last_visit DESC NULLS LAST)` | CRM "recent customers" |

### Finance and inventory (0005)

| Index | Serves |
|---|---|
| `idx_expenses_restaurant_spent (restaurant_id, spent_at DESC)` | Expense report by period |
| `idx_expenses_category (restaurant_id, category)` | Category breakdown |
| `idx_finance_entries_restaurant_occurred` | Ledger by period |
| `idx_payroll_entries_restaurant_period (restaurant_id, period_month DESC)` | Monthly payroll |
| `idx_staff_stats_restaurant_period` | Monthly KPI |
| `idx_inventory_items_low_stock (restaurant_id, stock) WHERE min_stock IS NOT NULL` | **Partial** — low-stock alerts only scan items that track a minimum |
| `idx_stock_movements_item (inventory_item_id, occurred_at DESC)` | Per-item stock ledger |
| `idx_daily_usage_restaurant_date` | Usage reporting |
| `idx_purchase_orders_restaurant_status` | Open PO list |

### Operations (0006)

| Index | Serves |
|---|---|
| `idx_attendance_restaurant_date (restaurant_id, work_date DESC)` | Attendance sheet |
| `idx_chef_tasks_restaurant_date`, `idx_chef_tasks_status` | Chef task board |
| `idx_prep_schedule_restaurant_date` | Prep list |
| `idx_waste_log_restaurant_date` | Waste report |
| `idx_production_plans_restaurant_date` | Production planner |

### Logs (0007) — highest row growth

| Index | Serves |
|---|---|
| `idx_activity_logs_restaurant_created (restaurant_id, created_at DESC)` | Replaces `orderByChild('createdAt').limitToLast(150)` |
| `idx_audit_log_restaurant_created` | Replaces `auditLog.js`'s query |
| `idx_audit_log_entity (restaurant_id, entity_type, entity_id)` | "History of this record" |
| `idx_chat_messages_chat_sent (chat_id, sent_at DESC)` | Message pagination |

---

## 5. Deliberately NOT indexed

| Column class | Why |
|---|---|
| `extra`, `payload`, `detail`, `meta` (jsonb) | Not queried today. A GIN index costs write throughput on every insert. Add one when a real query needs it. |
| `name`, `notes`, `description` | Free-text search is not implemented. Would need `pg_trgm` or full-text, not a b-tree. |
| Boolean flags (`active`, `paid`, `settled`) alone | Too low-cardinality to help on their own. Useful only inside a composite, which is how `idx_debts_restaurant_settled` uses `settled`. |
| `updated_at` | Nothing sorts by it; `created_at` covers the listings. |
| `legacy_rtdb_id` standalone | Already the second column of a `UNIQUE (restaurant_id, legacy_rtdb_id)`, which serves lookups within a tenant. A standalone index would only help a cross-tenant lookup nothing performs. |
| `status_raw`, `method_raw` and other `*_raw` columns | Diagnostic only; queries use the canonical column. |

---

## 6. Costs and future work

**Write cost.** `orders` carries 10 indexes. At current volume (59 orders)
that is irrelevant; at 10k orders/day it is worth re-checking whether the
per-staff partial indexes earn their keep.

**Not yet needed, deliberately:**

- **Partitioning.** `activity_logs` and `audit_log` grow without bound and
  are the natural candidates for monthly range partitioning. At 658 rows it
  would be premature.
- **Covering indexes** (`INCLUDE`). Worth considering for the order-list
  query once real query plans exist.
- **GIN on `extra`.** Only if Phase 2 queries unmapped fields — which would
  itself be a signal that a field deserves promoting to a real column.

**Validation status.** These indexes are **designed but not measured**: no
PostgreSQL instance was available in this environment, so no `EXPLAIN
ANALYZE` was run. The design follows from actual query shapes, but the plans
should be verified against a populated database before Phase 2 relies on
them.
