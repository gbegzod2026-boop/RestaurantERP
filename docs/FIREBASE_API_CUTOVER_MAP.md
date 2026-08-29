# Firebase → API cutover map (Phase 2, Step 2)

Every Firebase operation below is mapped to a replacement. Nothing is replaced blindly: request shape, tenant, role, and realtime needs are explicit.

Tenant rule: **never trust client `restaurant_id`**. The verified ID token `restId` claim is the tenant. Path `restaurants/{restId}/...` must match that claim (superadmin may cross-tenant). PostgreSQL RLS (`app.current_restaurant_id` + `SET LOCAL ROLE nesta_app`) is the final isolation layer.

Feature flag: `DATA_BACKEND=firebase|postgres` (default `firebase`). Frontend `pgRtdb.js` asks `GET /api/pg/meta`.

Auth on every `/api/pg/*` write/read except `/meta` and `/health`: `Authorization: Bearer <Firebase ID token>`.

Realtime: after commit, `recordEvent` + Socket.IO room `rest-{legacyRestId}` only. Events always include `{ type, restId, restaurantId, path, seq, ts, payload }`.

---

## Orders

| CURRENT FIREBASE PATH | OP | USER/ROLE | TENANT | REPLACEMENT API | HTTP | AUTH | BODY | RESPONSE | REALTIME |
|---|---|---|---|---|---|---|---|---|---|
| `restaurants/$r/orders` | onValue / get | admin, waiter, cashier, chef, courier, client | token.restId | `POST /api/pg/rtdb/get` or `GET /api/pg/orders` | POST/GET | Bearer + restId match | `{ path }` | RTDB map keyed by legacy id | ORDER_CREATED / ORDER_UPDATED |
| `restaurants/$r/orders` | push | waiter, client | token | `POST /api/pg/rtdb/push` or `POST /api/pg/orders` | POST | Bearer | order payload | `{ key, order }` | ORDER_CREATED |
| `restaurants/$r/orders/$id` | set / update | waiter, admin, kassa, chef | token | `POST /api/pg/rtdb/set` or `update` | POST | Bearer | full or patch | order object | ORDER_UPDATED |
| `restaurants/$r/orders/$id/items` | set / update / remove | waiter, chef | token | rtdb set/update or `POST /api/pg/orders/:id/add-item` `/update-item` `/remove-item` | POST | Bearer | item snapshot | items map | ORDER_ITEM_CHANGED |
| `restaurants/$r/orders/$id/status*` | update | waiter, chef, kassa, admin | token | `POST /api/pg/orders/:id/{approve,cancel,send-kitchen,cooking,ready,served,completed,close}` or `PUT .../status` | POST/PUT | Bearer | `{ status, chefId }` | order | ORDER_STATUS_CHANGED, KITCHEN_ORDER_UPDATED |
| `restaurants/$r/orders/$id/payment` | update / transaction | kassa, admin, client | token | `POST /api/pg/orders/:id/pay` or rtdb update | POST | Bearer | `{ paid, method, amount }` | payment | PAYMENT_UPDATED |
| `restaurants/$r/meta/orderCounterOrd` | runTransaction | waiter | token | `POST /api/pg/rtdb/transaction` → `incrementCounter` | POST | Bearer | — | next integer | none (counter) |
| `restaurants/$r/meta/orderCounterDvr` | runTransaction | client | token | same | POST | Bearer | — | next integer | none |
| `restaurants/$r/orderTimeline/$id` | push / onValue | chef, admin | token | rtdb get/set → `order_timeline` | POST | Bearer | event | map | ORDER_UPDATED |
| `restaurants/$r/orderChangeRequests` | push / update | waiter, kassa | token | rtdb → `order_change_requests` | POST | Bearer | request | id | ORDER_UPDATED |

Lifecycle preserved in one PostgreSQL transaction: create → add/update/remove item → submit/approve → kitchen → cooking → ready → served → payment → close / cancel. Timeline row + status_history written with the status change. Order number from `MAX(order_number)+1` or settings `meta` counter. Snapshots (`name_snapshot`, `price_snapshot`, customer/table labels) are never recomputed from live menu.

---

## Menu / categories / recipes

| PATH | OP | ROLE | API | REALTIME |
|---|---|---|---|---|
| `restaurants/$r/menu` | onValue/get/set/update/remove | admin, waiter, chef, client | `/api/pg/menu` + rtdb | MENU_UPDATED |
| `restaurants/$r/categories` | same | admin, waiter, client | `/api/pg/categories` + rtdb | MENU_UPDATED |
| `restaurants/$r/kitchenStations` | onValue | chef, admin | rtdb | PATH_CHANGED |

Recipes live in `recipes` / `recipe_items`. Menu item extra jsonb holds leftover recipe arrays until a dedicated recipe write lands. **Not blindly dropped.**

---

## Tables

| PATH | OP | ROLE | API | REALTIME |
|---|---|---|---|---|
| `restaurants/$r/tables` | onValue | waiter, admin, kassa | `GET /api/pg/tables` | TABLE_STATUS_CHANGED |
| `restaurants/$r/tables/$key` | update (status, orderId, busy, occupiedAt, customerPhone) | waiter | rtdb update → `tables.status` + `tables.extra` | TABLE_STATUS_CHANGED |

Occupancy fields that are not columns go into `tables.extra` (migration 0011).

---

## Employees / users

| PATH | OP | ROLE | API | REALTIME |
|---|---|---|---|---|
| `restaurants/$r/users` | onValue | admin | `GET /api/pg/employees` | EMPLOYEE_STATUS_CHANGED |
| `restaurants/$r/users/$id` | get/update | all staff (own row) | rtdb | EMPLOYEE_STATUS_CHANGED |

Credentials stay at Firebase `credentials/$r/$id` (and `employee_credentials` in PG for migration). **Login still uses `/api/auth` + Firebase custom token.** Removal of Firebase Auth is **not** Phase 2.

---

## Customers / reservations

| PATH | OP | ROLE | API | REALTIME |
|---|---|---|---|---|
| `restaurants/$r/customers` | onValue/update | admin, waiter, kassa | `/api/pg/customers` | CUSTOMER_UPDATED |
| `restaurants/$r/reservations` | onValue/update | admin, waiter | `/api/pg/reservations` | RESERVATION_UPDATED |

---

## Inventory / kitchen

| PATH | OP | ROLE | API | REALTIME |
|---|---|---|---|---|
| `restaurants/$r/inventory` | onValue/transaction | admin | `/api/pg/inventory` | INVENTORY_UPDATED |
| `restaurants/$r/ingredients` | onValue/transaction | admin, chef | rtdb (`tracked_as=ingredients`) | INVENTORY_UPDATED |
| `restaurants/$r/attendance/$date/$user` | get/update | current staff; admin by RBAC | rtdb → `attendance` | PATH_CHANGED |
| `restaurants/$r/kitchenAnnouncements` | get/push/update | current staff | rtdb → `kitchen_announcements` | PATH_CHANGED |

---

## Courier

| PATH | OP | ROLE | API | REALTIME |
|---|---|---|---|---|
| `restaurants/$r/couriers/$id` | onValue/update | courier | rtdb / `GET /api/pg/couriers` | COURIER_STATUS_CHANGED |
| `restaurants/$r/courierAssignments` | query equalTo orderId | courier, admin | rtdb | COURIER_STATUS_CHANGED |
| `/api/delivery/*` | already HTTP | courier | unchanged (still Firebase until a later cut) | existing socket events |

---

## Notifications / settings / reports

| PATH | OP | ROLE | API | REALTIME |
|---|---|---|---|---|
| `restaurants/$r/notifications` | onValue/push | all | `/api/pg/notifications` | NOTIFICATION_CREATED |
| `restaurants/$r/settings` | onValue/update | admin | `/api/pg/settings` | PATH_CHANGED |
| `restaurants/$r/info`, `subscription` | get/onValue | current active staff | rtdb → `restaurants.info`; writes only through canonical platform API | PATH_CHANGED |
| `restaurants/$r/chats`, `superadmin_chat` | get/push/update | current active staff / canonical platform superadmin | rtdb → `chats` + `chat_messages`; platform HTTP API | PATH_CHANGED |
| reports (derived) | computed in admin.js from orders | admin | `GET /api/pg/reports/summary` | none |

---

## Socket.IO (existing + new)

| Event | Was | Now |
|---|---|---|
| `nesta:subscribe` | — | Auth token + restId; join `rest-{restId}` only |
| `nesta:event` | — | Canonical envelope for all Phase 2 events |
| `nesta:resync` | — | `{ afterSeq }` → missed `realtime_events` + client also GETs current path |
| `menu-updated` | **`io.emit` global (cross-tenant leak)** | `io.to(rest-{restId})` only |
| `order:created` / `order:updated` | existing, rest-scoped | still emitted for chefs/admins rooms |

Required event names: `ORDER_CREATED`, `ORDER_UPDATED`, `ORDER_STATUS_CHANGED`, `ORDER_ITEM_CHANGED`, `PAYMENT_UPDATED`, `TABLE_STATUS_CHANGED`, `KITCHEN_ORDER_UPDATED`, `EMPLOYEE_STATUS_CHANGED`, `RESERVATION_UPDATED`, `COURIER_STATUS_CHANGED`, `NOTIFICATION_CREATED`.

---

## Connection recovery

1. Socket.IO `reconnection: true` with backoff  
2. `window.__nestaRealtimeState` = idle / connected / disconnected / subscribed  
3. On `connect`: `nesta:subscribe` + `nesta:resync` + **re-GET every active `onValue` path**  
4. Do not treat WebSocket as durable — PostgreSQL is the source of truth  

---

## Not mapped (remain Firebase)

| Path | Why |
|---|---|
| `systemData/*` | Superadmin / platform |
| `credentials/*` | Forbidden tenant RTDB path in postgres mode; `/api/auth` uses `employee_credentials` and Firebase only to mint/verify sessions |
| `restaurants/$r/bonus`, `apiKeys` | Unmapped tenant application data; fail closed in postgres mode |
| `restaurants/$r/modules`, `customRoles`, `roleOverrides` | PostgreSQL-backed RBAC; generic RTDB writes remain intentionally unmapped |
| Root `promocodes` | 68k orphan rows, no tenant |
| Firebase Storage | Images |
| Telegram bot tokens in settings (read by bot poller) | Telegram phase |

---

## Panel migration order (Step 8)

1. Admin — `admin.js` imports `pgRtdb.js`  
2. Waiter — `waiter.js`  
3. Kassa — `kassa.js`  
4. Chef — `chef.js`  
5. Courier — `courier.js`  
6. Client — `client.js`  
7. Superadmin — `superadmin.js` (orders/users/menu when opened; platform trees stay Firebase)

UI, i18n, and dark/light CSS are untouched. Only the database import path changed.
