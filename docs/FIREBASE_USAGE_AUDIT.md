# Firebase usage audit (Phase 2, Step 1)

Inventory of every Firebase initialization and Realtime Database access in this repository. **No application code was deleted.** This document is the Phase 2 starting map.

Scan date: 2026-08-23. Firebase project still in use: `restoran-30d51` (client SDK + Admin SDK). Live RTDB data remains the production source until `DATA_BACKEND=postgres` is proven.

## How Firebase is initialized

| Location | SDK | Role |
|---|---|---|
| `admin-frontend/public/js/firebase.js` | Client `firebase-app` + `firebase-database` | Shared `app` / `db` export; `forceWebSockets()` |
| `admin-frontend/public/js/admin.js` | Client app + database + auth + storage | Admin panel own `initializeApp` / `getDatabase` |
| `admin-frontend/public/js/waiter.js` | Client app + database + auth | Waiter panel |
| `admin-frontend/public/js/kassa.js` | Client app + database + auth | Cashier panel |
| `admin-frontend/public/js/chef.js` | Client app + database + auth | Chef / KDS panel |
| `admin-frontend/public/js/courier.js` | Client app + database + auth | Courier panel |
| `admin-frontend/public/js/client.js` | Client app + database + auth (phone + custom token) | QR / customer panel |
| `admin-frontend/public/js/superadmin.js` | Client app + database + auth | Superadmin panel |
| `admin-frontend/public/js/login.js` | Client app + database + auth | Login (staff PIN/password now hits `/api/auth`; still signs in with Firebase custom token) |
| `backend/firebaseAdmin.js` | Firebase Admin SDK | Custom tokens, `verifyIdToken`, Admin RTDB |
| `backend/systemDb.js` | Admin RTDB (fallback: client SDK) | All Express Firebase reads/writes |
| `backend/db.js` | Client SDK | Backend Firebase connection used by older helpers |
| `backend/db/scripts/lib/fbRead.mjs` | Admin SDK (REST, not full-tree `once`) | Phase 1 migration reader — **must stay read-only** |

Phase 2 cutover: mapped restaurant trees go through `admin-frontend/public/js/pgRtdb.js` → `/api/pg/rtdb/*` when `DATA_BACKEND=postgres`. Unmapped paths still call the real Firebase SDK.

## Operation counts (client `onValue` / init only)

| File | `onValue` / init / transaction sites (approx.) |
|---|---|
| `admin.js` | 85 |
| `client.js` | 31 |
| `chef.js` | 29 |
| `superadmin.js` | 19 |
| `waiter.js` | 16 |
| `kassa.js` | 12 |
| `courier.js` | 12 |
| `plan_features.js` | 5 |
| `shared.js` | 4 |
| `firebase.js` | 4 |
| `login.js` | 3 |
| `paymentEngine.js` | 3 (receives `ref`/`update` from caller) |
| `chat-system.js` | 3 |
| others | 1 each (`staffFooter`, `recipepatch`, `deliveryClient`) |

`onChildAdded` is used in `client.js`. `runTransaction` is used for order counters (`meta/orderCounterOrd`, `meta/orderCounterDvr`) and guarded payment / change-request status writes.

Typical client operations: `onValue`, `get`, `set`, `update` (including root multi-path updates), `push`, `remove`, `query` + `orderByChild` + `limitToLast` + `equalTo`, `runTransaction`.

---

## Frontend (shared)

| File | Paths / operations | Notes |
|---|---|---|
| `firebase.js` | `initializeApp`, `getDatabase`, `forceWebSockets` | Config only |
| `shared.js` | `restaurants/$restId/activityLogs` (`push`); `orderChangeRequests` (`get`/`update`); `settings` (`get`); unscoped legacy `menu` / `orders` (`onValue`/`set`/`update`/`remove`) | Shared helpers used by every panel |
| `plan_features.js` | `restaurants/$restId/subscription/features`, `systemData/settings/tariffs` | **Not mapped** — stays Firebase |
| `paymentEngine.js` | `orders/$id/payment` via caller-supplied `update` | Goes through pgRtdb when caller is migrated |
| `notificationsClient.js` | Auth only (`getAuth`) | HTTP API already |
| `deliveryClient.js` | Auth + `/api/delivery` | HTTP API already |
| `discountClaimsClient.js` | Auth + `/api` | HTTP API already |
| `aiImportClient.js` | Auth + `/api` | HTTP API already |
| `staffFooter.js` | commented `settings` listener | — |

---

## Admin

`admin.js` is the largest Firebase surface. Listeners and writes include:

- `restaurants/$restId/orders` (+ items, status, payment, statusHistory)
- `menu`, `categories`, `tables`, `users`, `customers`, `reservations`
- `inventory`, `ingredients`, `recipes` (on menu items)
- `settings`, `modules`, `customRoles`, `roleOverrides`
- `notifications`, `activityLogs`, `auditLog`, `feedback`
- `orderChangeRequests`, `orderTimeline`, `orderChats`
- `printSettings`, `terminalSettings`, `stopList`, `discounts`
- Storage: menu images (`firebase-storage`) — **not Phase 2 data**

Realtime: dozens of `onValue` subscriptions; some `query(orderByChild, limitToLast)`.

---

## Waiter

`waiter.js`:

- Read: `tables`, `orders`, `menu`, `categories`, `settings`, `users/$waiterId`
- Write: `push(orders)`, multi-path `update` (order + table occupancy), `orderChangeRequests`, `tables/$key` status
- Transaction: `meta/orderCounterOrd`

---

## Cashier (kassa)

`kassa.js`:

- Read: `orders`, `tables`, `settings`, `users`
- Write: payment object (`runTransaction` / `update`), order status close/paid, discounts
- Uses `paymentEngine.writeUnifiedPayment`

---

## Chef

`chef.js`:

- Read: `orders` (query/limit), `menu`, `stopList`, `kitchenStations`, `settings`, `orderTimeline`
- Write: order/item kitchen status (`cooking`, `ready`), chef assignment, kitchen announcements

---

## Courier

`courier.js`:

- Read: `orders`, `courierAssignments`, `couriers/$id`, `users/$id`
- Write: assignment status, courier battery/status
- Also `/api/delivery/*` (already backend)

---

## Client

`client.js`:

- Read: `menu`, `categories`, `settings`, single order, `tables`
- Write: `push(orders)`, `meta/orderCounterDvr` or takeaway counter, customer profile
- Auth: phone OTP + QR custom token (`/api` qr routes)
- `onChildAdded` for live order/chat-ish updates

---

## Superadmin

`superadmin.js` + `superadmin_features.js`:

- Platform tree: `restaurants` (list/create/update/delete), `restaurants_meta`, `systemData/*` (loginHistory, promoCodes, tariffs, organizations, twoFactor)
- Per-restaurant: `subscription`, `info`, `modules`, `bonus`, `notifications`, `superadmin_chat`, `apiKeys`, `users/admin_1`
- **Most of this stays on Firebase in Phase 2** (platform / billing / tariffs were not the order-lifecycle cutover)

---

## Backend

| File | Usage |
|---|---|
| `server.js` | `/api/orders`, `/api/foods`, `/api/categories`, `/api/staff` via `systemGet`/`systemPush`/`systemUpdate` (Firebase). Socket.IO rooms `rest-$id` already exist |
| `rbac.js` | `systemGet(restaurants/$restId/users/$userId)` for permission resolution |
| `routes/auth.js` | Admin Auth `createCustomToken` with claims `{ restId, role, rtdbUserId, isSuperAdmin }`; credential verify may still read Firebase hashes |
| `routes/clientOrders.js` | Firebase order read (QR customer, one order) |
| `routes/delivery.js` | Firebase courier/order |
| `routes/notifications.js` | Firebase notifications |
| `routes/superadmin*.js` | Admin RTDB `systemData/*`, restaurants |
| `notifications/dbMonitor.js` | Client SDK `onValue(.info/connected)` |
| `notifications/TelegramBotService.js` | Firebase restaurants/settings — **Telegram phase, out of scope** |
| `notifications/SuperAdminBotService.js` | Heavy Admin RTDB — **out of scope** |
| `notifications/scheduler.js` | Firebase restaurant list |
| `payments/*.js` | Order payment fields in Firebase |
| `systemDb.js` | Admin `ref().get/set/update/push/remove/transaction/query` |

---

## Telegram

`backend/notifications/TelegramBotService.js`, `SuperAdminBotService.js`, `scheduler.js` — Firebase only. **Do not migrate in Phase 2.**

---

## Shared utilities (backend)

`systemDb.js`, `firebaseAdmin.js`, `db.js`, `db/scripts/lib/fbRead.mjs` (migration, read-only).

---

## Auth-dependent access

`database.rules.json` requires `auth != null` and `auth.token.restId == $restId` on `restaurants/$restId`. Every panel now calls `getAuth()` + `signInWithCustomToken` after `/api/auth/*`. Phase 2 API uses the same Bearer ID token. `x-user-id` is **not** trusted on `/api/pg/*`.

---

## Firebase-specific transformations the API must preserve

- Order identity is the RTDB push id (`legacy_rtdb_id`), not the UUID
- Items keyed `{menuId}__{timestamp}`
- Status is four overlapping fields (`status` / `statusKey` / `statusV2` / `statusLabel`) plus `statusHistory`
- `createdAt` is epoch milliseconds
- Menu `name` is `{uz,ru,en}` jsonb
- Customers keyed by phone
- Tables keyed `table_{N}`
- Multi-path `update(ref(db), { "restaurants/a/...": ..., "restaurants/a/tables/...": ... })` must be atomic
- `runTransaction` on `meta/orderCounterOrd` / `orderCounterDvr`

---

## Phase 2 mapped vs leftover

**Mapped through PostgreSQL API** (when `DATA_BACKEND=postgres`):  
`orders`, `menu`, `categories`, `tables`, `users`, `customers`, `reservations`, `inventory`, `ingredients`, `notifications`, `settings`, `orderChangeRequests`, `courierAssignments`, `couriers`, `orderTimeline`, `meta`, `kitchenStations`, `waiterCalls`, `orderChats`.

**Remain on Firebase (intentional):**  
`subscription`, `info`, `modules`, `customRoles`, `roleOverrides`, `systemData/*`, `credentials/*`, `promocodes` root, Storage, Telegram trees, superadmin billing/bonus/apiKeys, print/terminal settings (partially in PG but UI still Firebase).
