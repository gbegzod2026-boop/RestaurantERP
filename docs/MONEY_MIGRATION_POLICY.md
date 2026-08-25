# Money Migration Policy — Firebase → PostgreSQL

Phase 1, requirement #6. Implemented by `toMoney()` in
`backend/db/scripts/lib/normalize.mjs`.

## Target type

All monetary columns are **`numeric(14,2)`**.

`numeric` is exact decimal arithmetic — unlike `float8`, which is what
JavaScript numbers actually are and why `0.1 + 0.2 !== 0.3`. `14,2` allows
values up to **999,999,999,999.99**, comfortably above the largest observed
value (10,000,000 in `expenses.amount`) with room for currency inflation.

Non-monetary quantities are **not** forced into this type:

| Concept | Type | Why |
|---|---|---|
| Money | `numeric(14,2)` | Exact, 2dp |
| Item quantity | `numeric(12,3)` | Weight-based dishes exist (`isWeightBased`) |
| Percentages | `numeric(5,2)` | 0.00–100.00, `CHECK`-constrained |
| Stock levels | `numeric(14,3)` | Measured in kg/gr, sub-unit precision is real |

---

## What the live data actually contains

Firebase stores every amount as a JavaScript `number` (IEEE-754 double).
Before choosing a rounding policy, `firebase-discover-enums.mjs` scanned
**every** money field across **all 46 restaurants** — a complete read, not a
sample. Evidence: `docs/migration-reports/firebase-enums-latest.json`.

| Field | n | Decimal places | Min | Max | Negatives |
|---|---|---|---|---|---|
| `orders.total` | 59 | 0dp:48, **1dp:11** | 0 | 216,165 | 0 |
| `orders.originalTotal` | 59 | 0dp:57, **1dp:2** | 0 | 314,966.5 | 0 |
| `orders.discount` | 59 | 0dp:59 | 0 | 50,745 | 0 |
| `orders.discountAmount` | 11 | 0dp:11 | 0 | 50,745 | 0 |
| `orders.deliveryFee` | 11 | 0dp:11 | 0 | 20,000 | 0 |
| `orders.items.*.price` | 147 | 0dp:147 | 30 | 89,000 | 0 |
| `orders.items.*.qty` | 147 | 0dp:147 | 1 | 5 | 0 |
| `orders.payment.finalTotal` | 26 | 0dp:24, **1dp:2** | 0 | 116,714 | 0 |
| `orders.payment.serviceFeeAmount` | 26 | 0dp:26 | 0 | 15,224 | 0 |
| `menu.price` | 21 | 0dp:21 | 30 | 89,000 | 0 |
| `menu.originalPrice` | 2 | 0dp:2 | 55,000 | 100,000 | 0 |
| `menu.foodCost` | 11 | 0dp:11 | 0 | 41,000 | 0 |
| `customers.totalSpent` | 7 | 0dp:6, **1dp:1** | 0 | 1,364,581.5 | 0 |
| `expenses.amount` | 20 | 0dp:20 | 0 | 10,000,000 | 0 |
| `inventory.stock` / `ingredients.stock` | 13 | 0dp:11, 1dp:2 | 0 | 300 | 0 |
| `inventory.price` / `ingredients.price` | 10 | 0dp:10 | 4 | 200,000 | 0 |

### The three findings that decide the policy

1. **Maximum observed precision is one decimal place.** Not a single money
   value anywhere in the database exceeds 2dp.
2. **No negative values exist** in any money field.
3. **No exponential-notation or non-finite values** were found; the scan
   reported **0 anomalies**.

**Therefore `numeric(14,2)` is provably lossless for the current dataset.**
No production value will be rounded by this migration. The rounding rules
below are a contract for future data, not a description of loss happening
today.

> Scope note: this covers the money fields listed above, which are the ones
> the orders/menu/inventory/expenses domains actually read. Money fields in
> collections not yet scanned (payroll, purchase orders, debts) are covered
> when their wave is implemented, using the same script.

---

## Rounding policy

Applied by `toMoney(value, ctx)`:

1. **`null` / `undefined` / `""`** → `NULL` (or the column default). *Absent
   is not zero* — inventing a `0` would violate rule #20.
2. **Numeric string** (`"1500"`, `"1500.50"`) → parsed, then treated as a
   number. Comma decimal separators (`"1500,50"`) are **rejected**, not
   guessed, because `"1,500"` is genuinely ambiguous.
3. **Non-finite** (`NaN`, `Infinity`) → **reject and report**. Never coerced
   to `0`.
4. **≤ 2 decimal places** → passed through exactly. This is every value in
   the database today.
5. **> 2 decimal places** → rounded **half-up** (`ROUND_HALF_UP`), and a
   `money_precision_loss` entry is written to the report with the Firebase
   path, original value, rounded value, and the delta. Half-up is the
   conventional financial rounding and matches what the JS UI already
   displays via `toFixed(2)`.
6. **Negative** → migrated as-is (the type permits it) but reported as
   `money_negative`, because no legitimate negative exists in the current
   data and a new one signals either a refund flow or a bug.
7. **Exceeds `numeric(14,2)` range** → **reject and report**. Never silently
   truncated.

Rounding is done in **integer cents** (`Math.round(v * 100) / 100`) rather
than `toFixed`, avoiding a second float round-trip through string formatting.

### Rejected records are never dropped

A rejection means the record is **not written and is reported** with path,
legacy id, reason and severity — the `data_loss_risk` channel described in
`docs/FIREBASE_SQL_MIGRATION.md`. It never means the row vanishes quietly.

---

## Reconciliation

The verify pass re-reads Firebase and compares against PostgreSQL:

- `SUM(orders.total)` per restaurant vs. the Firebase sum, to the cent.
- `SUM(order_items.line_total)` per order vs. its Firebase items.
- `SUM(payments.amount)` per restaurant vs. Firebase.
- Row counts for every money-bearing table.

Any difference beyond **0.00** is a failure. Because no rounding occurs on
the current dataset, the expected difference is exactly zero — a tolerance
would only hide a real bug.

## Currency

Amounts are **UZS (Uzbek so'm)**. No currency column exists yet because the
platform is single-currency today and inventing one would be speculative.
UZS is conventionally quoted without minor units, which is consistent with
the observed data being overwhelmingly whole numbers. Should multi-currency
arrive, the correct change is a `currency` column plus a
`numeric(14,2)`-preserving backfill, not a change to this type.
