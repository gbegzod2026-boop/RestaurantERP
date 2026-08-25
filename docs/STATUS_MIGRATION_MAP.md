# Status Migration Map — Firebase RTDB → PostgreSQL

Phase 1, requirement #9. **Authoritative mapping** used by
`backend/db/scripts/lib/normalize.mjs`. If a value arrives that is not in
these tables, the migration **reports it and skips the record** — it is never
coerced into a neighbouring status.

## How this was produced

Not from documentation. `backend/db/scripts/firebase-discover-enums.mjs`
performed a **complete** read (not a sample) of every targeted collection in
all **46** restaurants and counted every distinct value. Raw evidence:
`docs/migration-reports/firebase-enums-latest.json`.

Counts below are live production occurrences at the time of the scan.

---

## 1. The core problem: orders carry four competing status fields

A single order record stores its state in up to five places at once:

| Field | Distinct values | Nature |
|---|---|---|
| `status` | 6 | **Mixed** machine keys *and* Uzbek display text |
| `statusKey` | 5 | Machine keys (most consistent) |
| `statusV2` | 3 | Newer machine keys, present on only 52 of 59 orders |
| `statusLabel` | 7 | Localized display text (Uzbek + Russian) |
| `statusV2Label` | 1 | Localized display text |

Plus `statusHistory`, whose child keys include three states
(`payment`, `picked_up`, `preparing`) that appear in **no** status field.

### Resolution precedence

The canonical `orders.status` is resolved in this order, first non-empty wins:

```
statusV2  →  statusKey  →  status  →  'unknown'
```

`statusV2` ranks highest because it is the app's own explicit versioning of
the field. `status` ranks lowest because it is the only one polluted with
display text. **All four raw values are retained** in
`orders.status_raw`, `status_key_raw`, `status_v2_raw`, `status_label_raw`,
so normalization destroys nothing.

---

## 2. Canonical order status set

```
order_created · confirmed · cooking · ready · picked_up
served · payment_requested · paid · completed · cancelled · unknown
```

This is the union of all values found across all four fields **and** all
`statusHistory` child keys. It is enforced by a `CHECK` constraint on
`orders.status`.

> Waves 0–1 deliberately left `status` unconstrained, reasoning that a `CHECK`
> might reject unknown legacy values. That was correct when the value set was
> unknown. It no longer applies: the set below is exhaustive over live data,
> and anything outside it is reported rather than written.

### Mapping table — `orders`

| Firebase value | Source field(s) | Count | → PostgreSQL | Note |
|---|---|---|---|---|
| `order_created` | status, statusKey, statusV2 | 14 / 14 / 12 | `order_created` | |
| `cooking` | statusKey | 3 | `cooking` | |
| `tayyorlanmoqda` | status | 3 | `cooking` | Uzbek "being prepared" |
| `preparing` | statusHistory key | — | `cooking` | Only in history tree |
| `ready` | status, statusKey | 1 / 1 | `ready` | |
| `picked_up` | statusHistory key | — | `picked_up` | Only in history tree |
| `served` | status, statusKey, statusV2 | 6 / 6 / 5 | `served` | |
| `payment` | statusHistory key | — | `payment_requested` | Only in history tree |
| `to'landi` | status | 34 | `completed` | **See decision below** |
| `completed` | status, statusKey, statusV2 | 1 / 35 / 35 | `completed` | |

#### Decision: `to'landi` → `completed`, not `paid`

`to'landi` is Uzbek for *"paid"*, so `paid` looks like the obvious target.
It is the wrong one. On all 34 records carrying `status: "to'landi"`, the
same order's `statusKey` and `statusV2` both read `completed`. Since
`statusV2` wins the precedence rule, those orders resolve to `completed`
regardless — mapping `to'landi` to `paid` would create a contradiction that
could only surface on the handful of records missing `statusV2`.

Payment state is **not** lost by this: it lives in `payments.paid` /
`payments.paid_at` and in `orders.payment_status`, which are populated from
the `payment` object independently of the status field.

`paid` remains in the canonical set because the status-history tree and the
UI both use it, and Phase 2 will write it directly.

### Not mapped — display-text fields

`statusLabel` and `statusV2Label` are **presentation strings**, not states:
`Yakunlandi`(34), `Buyurtma yaratildi`(14), `Xizmat qilindi`(5),
`Tasdiqlandi (Oshpazda)`(3), `To'langan`(1), `Mijozga berildi`(1),
`Повар готовит`(1, Russian).

They are copied verbatim into `orders.status_label_raw` and **never** parsed
into a status. Deriving state from a localized string is exactly how the
current dual-language mess arose; Phase 2 should render labels from the
canonical status via i18n instead.

---

## 3. Order item status

Canonical: `pending · cooking · ready · delivered · served · cancelled · unknown`

| Firebase value | Field | Count | → PostgreSQL |
|---|---|---|---|
| `pending` | items.*.status | 138 | `pending` |
| `delivered` | items.*.status | 6 | `delivered` |
| `ready` | items.*.status | 3 | `ready` |
| `prepared` | items.*.kitchenStatus | 8 | *(kept raw in `kitchen_status`)* |
| `pending` | items.*.kitchenStatus | 1 | *(kept raw in `kitchen_status`)* |

`kitchenStatus` is a **second, independent** axis (is the kitchen done?)
rather than a variant of item status, so it is preserved as its own column
instead of being merged.

---

## 4. Payment method

Canonical: `cash · card · payme · click · uzum · transfer · mixed · pending · unknown`

| Firebase value | Field | Count | → PostgreSQL | Note |
|---|---|---|---|---|
| `Naqd` | payment.method | 29 | `cash` | Uzbek "cash" |
| `cash` | payment.method | 13 | `cash` | |
| `Payme` | payment.method | 4 | `payme` | Case-normalized |
| `Click` | payment.method | 1 | `click` | Case-normalized |
| `cash` | paymentMethod | 4 | `cash` | |
| `pending` | paymentMethod | 37 | `pending` | **Not a method** — see below |
| `cash_on_delivery` | deliveryPaymentMethod | 12 | `cash` | Delivery flag kept separately |

The original string is always preserved in `payments.method_raw`.

#### `paymentMethod: "pending"` is a status in a method field

The top-level `paymentMethod` field holds `pending` on 37 of 59 orders —
that is payment *state*, not a payment *instrument*. It maps to
`orders.payment_status = 'pending'` and **not** to `payments.method`.
`payment.method` (the nested one) is the real instrument field.

---

## 5. Table status

Canonical: `free · occupied · cleaning · reserved · unknown`

| Firebase value | Count | → PostgreSQL | Note |
|---|---|---|---|
| `free` | 21 | `free` | |
| `cleaning` | 6 | `cleaning` | |
| `occupied` | 5 | `occupied` | |
| `eating` | 2 | `occupied` | Same physical state |
| `busy` | 1 | `occupied` | Same physical state |

Three spellings (`occupied` / `eating` / `busy`) describe one state. There is
also a **separate boolean `busy` field** that can disagree with `status`;
where they conflict, `status` wins and the conflict is reported.

> Wave 1 already created `tables.status` as unconstrained free text. This
> migration does **not** retroactively add a `CHECK` there — that would be
> unrelated refactoring (Phase 1 rule #18). Normalization is applied by the
> migration script on write.

---

## 6. Other enums

### `users.role` — contains real corruption

| Value | Count | → PostgreSQL | Note |
|---|---|---|---|
| `admin` | 43 | `admin` | |
| `finance` | 8 | `finance` | |
| `cashier` | 8 | `cashier` | |
| `chef` | 6 | `chef` | |
| `waiter` | 6 | `waiter` | |
| `courier` | 3 | `courier` | |
| `inventory_manager` | 3 | `inventory_manager` | |
| `hr` | 3 | `hr` | |
| `crm` | 1 | `crm` | |
| `""` (empty) | 3 | **SKIPPED — reported** | Cannot be inferred (rule #20) |
| `-OyrlzxVx-_w5fMcKKy9` | 1 | **SKIPPED — reported** | A `customRoleId` written into `role` |

The last two rows are **data-integrity findings, not mapping problems**.
Wave 1's apply script already skips empty roles rather than guessing; the
push-id value is a bug in the app that wrote a custom-role reference into the
role column, and it is reported for manual review.

### Other collections

| Collection.field | Values (count) | → PostgreSQL |
|---|---|---|
| `orders.orderType` | `delivery`(11), `dine_in`(3) | same |
| `reservations.status` | `no_show`(2), `pending`(2), `completed`(1), `seated`(1) | same |
| `courierAssignments.status` | `assigned`(1) | same |
| `courierAssignments.subStage` | `heading_to_restaurant`(1) | kept as `sub_stage` |
| `couriers.status` | `online`(3), `offline`(2) | same |
| `orderChangeRequests.requestType` | `cancel_item`(3), `replace_item`(1) | same |
| `orderChangeRequests.status` | `approved`(4) | same |
| `purchaseOrders.status` | `delivered`(2), `received`(1) | same |
| `suppliers.status` | `paused`(1), `active`(1) | same |
| `tables.tableType` | `oddiy`(29), `vip`(2), `terrasa`(2), `kabina`(1) | same (Uzbek, unchanged) |
| `inventory.unit` / `ingredients.unit` | `kg`, `gr`, `dona` | same (Uzbek `dona` = "piece") |
| `info.status` | `active`(44) | same |
| `subscription.plan` | `PRO`(44) | lower-cased `pro` |

`pending` and `rejected` for `orderChangeRequests.status` have no live
example but are reachable via the guarded `runTransaction` in
`shared.js`, so both are permitted by the `CHECK`.

---

## 7. Unknown-value handling

For any enum-constrained field:

1. Look up the exact string.
2. Look up its trimmed, lower-cased form.
3. If still unmatched → **do not write**. Emit a
   `data_loss_risk` record with Firebase path, `legacy_rtdb_id`, field name,
   the offending value, and severity, then skip the record.

Unknown values are never silently mapped to `unknown`. The `unknown` member
of each canonical set exists only for values the map **explicitly** sends
there (currently none), so a real gap can never hide behind it.
