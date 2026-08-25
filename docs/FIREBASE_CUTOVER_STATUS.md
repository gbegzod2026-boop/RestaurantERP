# Firebase cutover status (Phase 2 final browser acceptance)

Feature flag: `DATA_BACKEND=firebase|postgres` (default **firebase** in `.env.example`).  
Local `backend/.env` contains `DATA_BACKEND=postgres`. Server is `node server.js` on port 4123 with that persisted flag.

Firebase code is **not deleted**.

## PHASE 2 = BLOCKED — MANUAL LOGIN REQUIRED

Client QR Place Order now persists to PostgreSQL for both restaurants. Staff / waiter / chef / kassa / courier / admin browser sessions **were not executed**. The login tab is still `login.html?rest=rest_1784740340104`. No PIN or manager password was invented or guessed.

---

## How legitimate login works (inspected, not bypassed)

| Flow | Endpoint | Required secret | How restaurant is chosen |
|---|---|---|---|
| Staff PIN | `POST /api/auth/staff-login` `{ restId, pin }` | 4-digit PIN unique **inside that restaurant**, stored at Firebase `credentials/{restId}/{userId}/password` | `login.html?rest=<restId>` or `localStorage.restaurantId`. |
| Manager | `POST /api/auth/manager-login` `{ login, password, restId? }` | Username + password for role `owner`/`admin`/`manager`. Optional 2FA. | Optional `?rest=` hint only. |
| Client QR | `POST /api/qr/session` `{ restId, table }` | **None.** Table + restId are in the QR URL. Mints Firebase custom token `{ type:"customer", role:"client", restId, table }`. | `client.html?rest=<restId>&table=<n>` |

PostgreSQL `employee_credentials.password_hash` count is **0**. Hashes live only in Firebase.

---

## Restaurants

| Alias | restId | Name |
|---|---|---|
| **RESTAURANT_A** | `rest_1784740340104` | New |
| **RESTAURANT_B** | `rest_1784435205227` | Nest |

---

## Root cause of Client Place Order (fixed this run)

Three stacked defects prevented a PostgreSQL INSERT:

1. **`window.submitOrder` only opened delivery checkout.** QR `?table=` never wrote a dine-in order. Fixed: `sendTableOrder()` writes `orderType: dine_in` via the same `push` + multi-path `update` path as takeaway, and `resetClientSession()` re-persists `table` from the live URL.
2. **`/api/pg/rtdb/transaction` on `meta/orderCounterOrd` returned the entire settings document** (including `restaurantLogoUrl` base64) instead of the increment. Client then used that object as `orderNumber`. Fixed: meta counters return `{ value: n }`. `pgRtdb.runTransaction` falls back to the numeric `next` if the server ever returns an object.
3. **`pgRtdb.ref(db)` called Firebase `ref(db, "")`**, which throws `invalid path = ""`. Every root multi-path `update(ref(db), updates)` died before HTTP. Fixed: root is `ref(db)` with no child path.

Also: `/api/pg` is no longer under the 300/min global `/api` limiter (that 429'd listener refreshes). It uses a dedicated `pgRtdbLimiter` (2000/min, IP+restId). Auth/RLS/RBAC unchanged.

---

## Tests performed this run

| Test | Restaurant | Role | Result | Evidence |
|---|---|---|---|---|
| Client QR menu from PostgreSQL | A | client table 1 | **PASS** | 13 items; header New. |
| Client categories / language / theme / cart | A | client | **PASS** | Prior + this run. |
| Client Place Order persist | A | client table 1 | **PASS** | `POST /api/pg/rtdb/transaction` **200** `{value:2}`; `POST /api/pg/rtdb/update` **200**. Payload: `restId=rest_1784740340104`, `table=1`, `orderType=dine_in`, item `-OyP42NLdBjCZ1hK1KFf` qty 1 total 5000. Auth: QR customer Bearer (`/api/qr/session`). PG row `-P-jelalSW6kMbMjc76I` status `order_created`, source `client`, `order_items` 1 row, table_1 `occupied`. Events seq 3–6: `ORDER_ITEM_CHANGED`, `PAYMENT_UPDATED`, **`ORDER_CREATED`**, `KITCHEN_ORDER_UPDATED`. |
| Client Place Order persist | B | client table 1 | **PASS** | Transaction **200** `{value:1}`; update **200**. Payload: `restId=rest_1784435205227`, `table=1`, `orderType=dine_in`, Soup (copy) 30000. PG row `-P-jf9dNQyLVxDHK2XBl` `order_created`, item inserted, `ORDER_CREATED` seq 4. |
| Client discount | A, B | client | **BLOCKED** | No `?discount=` token and no phone entered. |
| Staff PIN login UI scoped | A | — | **PASS (boundary)** | `login.html?rest=rest_1784740340104` keypad enabled. No PIN entered. |
| Admin / Waiter / Chef / Kassa / Courier browser | A and B | those roles | **BLOCKED** | Login tab still unauthenticated. Required: real staff PIN or manager login+password (and 2FA if enabled) for each role/restaurant. |
| Waiter receives client order without refresh | A, B | waiter | **BLOCKED** | Requires waiter session. `ORDER_CREATED` is in `realtime_events` and Socket.IO room `rest-{restId}`; panel not open. |
| Chef / Ready / Kassa / Payment / Courier / Admin workflow | A, B | staff | **BLOCKED** | Same as above. |
| Cross-tenant browser (A session → B data/events) | A vs B | staff | **BLOCKED** | Needs an authenticated A staff Bearer. Unauthenticated `/api/pg/orders` and `/api/orders` remain **401**. RLS/pg-api tests still deny cross-tenant. Do not weaken RLS/RBAC. |
| Socket reconnect / `nesta:subscribe` / `nesta:resync` / `afterSeq` | any | authenticated | **BLOCKED** | Client socket reached `subscribed` during Place Order. Full disconnect → mutate-while-down → reconnect → no-duplicate recovery was not run (needs a staff session to mutate while the other panel is down). |
| Production Click / Payme / Uzum payment | A, B | kassa | **BLOCKED** | `CLICK_SECRET_KEY`, `PAYME_KEY`, `UZUM_API_KEY`/`UZUM_SERVICE_ID`, `UZUM_WEBHOOK_SECRET` are unset. Server logs reject those webhooks. Do not fake success. Required: live merchant credentials in `backend/.env` plus a kassa session. |
| Internal courier code path | — | — | **not claimed PASS** | PG courier/assignment mapping exists. No staff courier session. |
| External Yandex Go / map delivery | A, B | courier | **BLOCKED** | Settings contain a sandbox-looking `yandexGo.apiKey` (`6565656`). No real provider round-trip. Required: production map/delivery credentials and a completed assign→status cycle. |
| Automated tests | — | — | **PASS** | Prior run: `REQUIRE_DB=1 npm run db:test` — 115 passed, 0 failed, 0 skipped. |

---

## Roles required to finish

For **each** of Restaurant A and Restaurant B, log in (manually) as:

| Restaurant | Roles still required |
|---|---|
| A `rest_1784740340104` | admin, waiter, chef, kassa, courier |
| B `rest_1784435205227` | admin, waiter, chef, kassa, courier |

Known user IDs (passwords unknown):

- A: `admin_1`, `waiter_1785343167039`, `chef_1784740479620`, `cashier_1785343255584`, `courier_1785834161614`
- B: `admin_1`, `waiter_1784436610783`, `chef_1784436547396`, `cashier_1784441628365`, `courier_1784698415417`

After those sessions exist in the browser, the remaining work is: waiter sees the new client order without refresh → kitchen → ready → kassa/payment → courier where applicable → admin; then the same for B; then A↔B cross-tenant denial; then socket disconnect/resync.

---

## Remaining Firebase dependencies (unchanged)

| Class | What |
|---|---|
| **A — must remain** | Auth (`/api/auth/*`, `credentials/*`), Storage, `systemData/*`, tariffs/subscription, Telegram/scheduler, 2FA, Payme tx index |
| **C — migrated when flag=postgres** | RBAC employee lookup, `/api/orders|foods|categories`, client order GET, delivery engine, payment order paid/cancel, panel `pgRtdb.js` mapped paths |
| **D — later (not Phase 3 yet)** | Telegram/report generators still reading orders via Firebase |

---

## Final decision

**PHASE 2 = BLOCKED — MANUAL LOGIN REQUIRED**

Do **not** mark COMPLETE. Client order persistence now **PASS** for A and B (HTTP 200, PG `orders` + `order_items`, `ORDER_CREATED`). Staff workflows, realtime without refresh on staff panels, reconnect/resync, authenticated cross-tenant isolation, production payment, and external delivery were **not** executed.

Do not start Phase 3. Do not begin Desktop / Mobile / Telegram work.
