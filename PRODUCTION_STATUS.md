# NESTA Production Status

Status: **Step 2D.5A cutover-artifact freeze in progress — production data migration NOT authorized**

## Current controls

- Production Firebase→PostgreSQL data `--apply` is prohibited without explicit human approval after a GO operator preflight.
- `DATA_BACKEND` must remain unswitched in this step.
- Platform vs tenant authority unchanged. RLS/FORCE RLS required on tenant tables.
- `POSTGRES_POOL_MAX` production recommendation remains **10**.

## Step 2D.3 Railway PostgreSQL (operator-verified)

- PUBLIC MANAGED, PostgreSQL 18.6, TLS on
- migrations 0001–0017, latest **0017**
- pgcrypto, required roles, tenant catalog RLS/FORCE RLS 74/74
- restaurants 0, fixture rows 0
- production PG preflight **GO**
- production Firebase data migrated **NO**

## Step 2D.4 remaining gates

- Firebase RTDB backup: see `cutover-backups/` (gitignored) and Step 2D.4 report
- Click / Payme / Uzum: **BLOCKED**. `NESTA_PAYMENT_PAUSE_CONFIRM` unset. HTTP 503 is not a guaranteed retry; durable queue is not implemented.
- App/config rollback copies: gitignored `cutover-backups/app-config-*`
- Railway PG dump restore drill: disposable **local** database only; never overwrite `railway`

## Cutover artifacts

- Step 2C historical: tag `nesta-step2c-cutover` / `38f5a80681ebd431c9952e83e043ceb23fed6454` (do not reset to this).
- Current production cutover candidate: tag `nesta-step2-cutover-ready`. Deploy freeze requires a clean tree and HEAD equal to that tag.

## Release gate

Do not migrate production data. Do not enable maintenance from an agent. Do not start Step 3. All `ACCEPTANCE_MATRIX.md` rows and secret hygiene still apply.
