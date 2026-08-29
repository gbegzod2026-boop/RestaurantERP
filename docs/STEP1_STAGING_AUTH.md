# Step 1 isolated Auth environment

Production Firebase project `restoran-30d51` must not receive acceptance Auth mints.

No separate Google Firebase staging project was present in this repository. Local Step 1 acceptance uses:

- Firebase Auth **emulator** with project id `nesta-staging`
- Local loopback PostgreSQL (`DATA_BACKEND=postgres`)
- `NESTA_REQUIRE_ISOLATED_AUTH=1`

The backend refuses to start or mint sessions when that flag is set and `FIREBASE_PROJECT_ID` is `restoran-30d51`.

## Start emulator (repo root)

```powershell
npx --yes firebase-tools emulators:start --only auth --project nesta-staging
```

Do not start the RTDB emulator. Application data stays on PostgreSQL.

## Start backend (backend directory)

Set the isolated overlay **before** `node server.js` so `dotenv` does not replace it:

```powershell
$env:NESTA_REQUIRE_ISOLATED_AUTH = "1"
$env:DATA_BACKEND = "postgres"
$env:FIREBASE_PROJECT_ID = "nesta-staging"
$env:FIREBASE_API_KEY = "nesta-staging-emulator"
$env:FIREBASE_AUTH_DOMAIN = "nesta-staging.firebaseapp.com"
$env:FIREBASE_APP_ID = "1:0:web:nesta-staging"
$env:FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099"
$env:FIREBASE_DATABASE_URL = ""
node server.js
```

Confirm `/api/health` reports `firebaseProjectId=nesta-staging`, `productionFirebase=false`, `authEmulator=true`. If `productionFirebase` is true, stop.

See `backend/env.staging.example` and `docs/STEP1_LOCAL_PG_ACCEPTANCE.md`.
