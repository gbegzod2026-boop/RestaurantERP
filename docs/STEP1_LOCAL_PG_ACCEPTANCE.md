# Step 1 Remediation Round 2 — local PostgreSQL acceptance fixture

This fixture creates two deterministic, disposable tenants only in a
loopback PostgreSQL database. It supports local admin login discovery,
dashboard reads, staff list/create/delete checks, mapped settings/table/menu/
inventory/notification reads and writes, cross-tenant checks, and realtime
resync data.

The fixture script imports no Firebase module and never reads or writes
Firebase Auth or RTDB. Seeding, status checks, cleanup, and the static checks
documented below do **not** create genuine Firebase Auth users or change
genuine users' custom claims.

## Safety contract

`db/scripts/step1-local-acceptance.mjs` exits before connecting unless:

1. `NESTA_LOCAL_ACCEPTANCE=1` is set; and
2. the configured `POSTGRES_URL` hostname or `POSTGRES_HOST` is `localhost`,
   `::1`, or an IPv4 `127.x.x.x` loopback address.

The two reserved tenant IDs are `rest_1999000000001` and
`rest_1999000000002`. Existing rows with either ID but unexpected fixture
identity cause a hard failure. Cleanup deletes only those IDs with the
expected local domains and fixture ownership marker; restaurant cascades
remove all associated fixture rows.

Do not weaken these guards. Do not point the script at a shared, staging, or
production database.

## Setup and seed (PowerShell)

From `backend`:

```powershell
# Use the existing local backend/.env PostgreSQL configuration.
$env:NESTA_LOCAL_ACCEPTANCE = "1"
$env:NESTA_ACCEPTANCE_ADMIN_A_PASSWORD = Read-Host "Disposable Tenant A admin password"
$env:NESTA_ACCEPTANCE_ADMIN_B_PASSWORD = Read-Host "Disposable Tenant B admin password"
$env:NESTA_ACCEPTANCE_STAFF_A_PIN = Read-Host "Disposable Tenant A four-digit staff PIN"
$env:NESTA_ACCEPTANCE_STAFF_B_PIN = Read-Host "Disposable Tenant B four-digit waiter PIN"
$env:NESTA_ACCEPTANCE_CHEF_A_PIN = Read-Host "Disposable Tenant A four-digit chef PIN"
$env:NESTA_ACCEPTANCE_CHEF_B_PIN = Read-Host "Disposable Tenant B four-digit chef PIN"
$env:NESTA_ACCEPTANCE_CASHIER_A_PIN = Read-Host "Disposable Tenant A four-digit cashier PIN"
$env:NESTA_ACCEPTANCE_CASHIER_B_PIN = Read-Host "Disposable Tenant B four-digit cashier PIN"

npm run db:migrate:status
npm run db:migrate:up
npm run db:acceptance:step1:seed
npm run db:acceptance:step1:status
```

Admin passwords must be at least 12 characters; staff PINs must be exactly
four digits. Values are bcrypt-hashed before storage and are never printed.
Use disposable values that are not used by any real account.

The seed is idempotent. It upserts only its fixed records and refreshes their
credential hashes. It intentionally does not delete ad-hoc staff created
during a browser test; the explicit cleanup command removes the whole
disposable tenant and all cascading rows.

Start the backend with its existing `DATA_BACKEND=postgres` configuration:

```powershell
npm start
```

Confirm `http://127.0.0.1:4000/api/pg/meta` reports PostgreSQL configured and
reachable, `dataBackend` equal to `postgres`, and at least the two fixture
restaurants. Do not proceed if the backend reports Firebase as the data
backend.

## Manual browser acceptance

This section is a runbook, not completed evidence.

Important: the existing `/api/auth/manager-login` route calls
`mintSessionToken`, which can create a Firebase Auth UID and persist custom
claims when Firebase Admin is configured. Therefore the PostgreSQL fixture
alone does not authorize a genuine browser login run against the configured
Firebase project. Obtain explicit approval for that external Auth mutation,
or first provide an approved isolated Auth test environment. Merely running
the seed/cleanup commands does not perform that mutation.

After that prerequisite is explicitly satisfied:

1. Open a private browser window and DevTools (Console and Network).
2. Browse to `http://127.0.0.1:4000/login.html`.
3. Select manager login. Enter `step1_admin_a` and the current value of
   `NESTA_ACCEPTANCE_ADMIN_A_PASSWORD`.
4. Verify redirect to
   `admin.html?rest=rest_1999000000001#dashboard`, with no failed mapped PG
   requests and no CSP violations in Console.
5. Verify the dashboard renders fixture-backed settings and data. In Network,
   verify mapped application requests use `/api/pg/rtdb/*`; no application
   data request should fall back to Firebase RTDB.
6. Open the staff/users section. Confirm Admin, Waiter, Cashier, and Blocked
   fixture rows are listed with the expected active/RBAC states.
7. Create one disposable waiter with a unique login and PIN. Confirm it
   appears without a reload, then delete that waiter and confirm it disappears
   without a reload.
8. In a second private browser profile, repeat manager login with
   `step1_admin_b` and `NESTA_ACCEPTANCE_ADMIN_B_PASSWORD`. Confirm it resolves
   only to `rest_1999000000002` and cannot display Tenant A staff/data.
9. With both tenant tabs open, perform one mapped write (for example a staff
   create/delete or table status change). Confirm only the correct tenant tab
   receives the realtime change. Reconnect that tab and confirm resync occurs
   after `nesta:subscribed`, with no duplicate event.
10. Save screenshots plus sanitized Console/Network evidence. Do not capture
    passwords, PINs, tokens, cookies, authorization headers, or connection
    strings.

Because these browser steps have not been executed as part of fixture
implementation, browser behavior, two-tab Socket.IO behavior, and browser CSP
remain **NOT VERIFIED**.

## Cleanup

Stop browser testing, then from `backend`:

```powershell
$env:NESTA_LOCAL_ACCEPTANCE = "1"
npm run db:acceptance:step1:cleanup
npm run db:acceptance:step1:status
```

Both IDs must report `ABSENT`. Clear the four disposable secret environment
variables from the current PowerShell process:

```powershell
Remove-Item Env:NESTA_ACCEPTANCE_ADMIN_A_PASSWORD -ErrorAction SilentlyContinue
Remove-Item Env:NESTA_ACCEPTANCE_ADMIN_B_PASSWORD -ErrorAction SilentlyContinue
Remove-Item Env:NESTA_ACCEPTANCE_STAFF_A_PIN -ErrorAction SilentlyContinue
Remove-Item Env:NESTA_ACCEPTANCE_STAFF_B_PIN -ErrorAction SilentlyContinue
Remove-Item Env:NESTA_LOCAL_ACCEPTANCE -ErrorAction SilentlyContinue
```

Cleanup is idempotent and is safe to rerun. It does not remove or alter any
Firebase Auth identity or claim that a separately approved browser login may
have created; external Auth cleanup requires a separate explicit approval and
is outside this PostgreSQL-only fixture.
