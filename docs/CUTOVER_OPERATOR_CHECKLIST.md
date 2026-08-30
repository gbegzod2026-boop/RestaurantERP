# NESTA Step 2D — production cutover operator checklist

Step 2C migration artifact (historical evidence only — do not `git reset --hard` to this):

- tag `nesta-step2c-cutover`
- commit `38f5a80681ebd431c9952e83e043ceb23fed6454`

Current production cutover candidate:

- tag `nesta-step2-cutover-ready`
- exact commit = `git rev-parse nesta-step2-cutover-ready` (recorded by `step2d5-deploy-freeze.mjs`)

Deploy freeze requires: working tree clean, HEAD equals the current candidate tag, no local modifications. Production release is expected to use this artifact. The clean-tree invariant is not optional.

This checklist does **not** authorize production `--apply`. Do not switch `DATA_BACKEND`. Do not start Step 3. Check a box only after you have evidence. Steps 8–18 must not be executed in Step 2D.4.

## Exact operator order

1. [ ] Freeze deploys (no new production backend/frontend releases).
2. [ ] Verify backups (Firebase RTDB export, Railway PG dump, app/config copies).
3. [ ] Activate maintenance mode (`NESTA_MAINTENANCE_MODE=1`) on every production instance; restart.
4. [ ] Pause Click / Payme / Uzum in provider cabinets (or a real durable queue — **not implemented**). Then set `NESTA_PAYMENT_CUTOVER_MODE=OPERATOR_PAUSED` and `NESTA_PAYMENT_PAUSE_CONFIRM=CLICK_PAYME_UZUM_PAUSED_IN_PROVIDER_CABINET`. Do not set the confirm phrase unless the cabinets are actually paused.
5. [ ] Verify writes stopped (tenant POST 503 `MAINTENANCE`; login/health up; webhooks never HTTP 200).
6. [ ] Final Firebase source snapshot/count (read-only).
7. [ ] Verify Railway PG preflight **GO** (`node db/scripts/step2d2-prod-pg-preflight.mjs`).
8. [ ] Explicit human approval (named approver + timestamp). **Do not perform in Step 2D.4.**
9. [ ] Production migration (`NESTA_MIGRATE_TARGET=production` + exact confirm phrases). **Do not perform in Step 2D.4.**
10. [ ] Reconciliation vs freeze snapshot. **Do not perform in Step 2D.4.**
11. [ ] Switch `DATA_BACKEND=postgres`. **Do not perform in Step 2D.4.**
12. [ ] Backend smoke. **Do not perform in Step 2D.4.**
13. [ ] Browser smoke. **Do not perform in Step 2D.4.**
14. [ ] Realtime smoke. **Do not perform in Step 2D.4.**
15. [ ] Payment/webhook resume (unpause cabinets; clear confirm vars). **Do not perform in Step 2D.4.**
16. [ ] Maintenance off. **Do not perform in Step 2D.4.**
17. [ ] Observation window. **Do not perform in Step 2D.4.**
18. [ ] Rollback trigger criteria armed (below). **Do not perform in Step 2D.4.**

## PRE-CUTOVER evidence

- [x] Production PostgreSQL schema 0001–0017 on Railway (operator Step 2D.3): PUBLIC MANAGED, TLS on, restaurants 0, preflight GO.
- [ ] Firebase export exists (timestamped, gitignored). `node db/scripts/step2d4-firebase-backup.mjs`
- [ ] Production PostgreSQL dump + local disposable restore drill. `node db/scripts/step2d4-pg-backup-restore.mjs` (dump source = `DATABASE_PUBLIC_URL` / Railway `railway`; restore = loopback `nesta_step2d4_restore` only. Optional `STEP2D4_RESTORE_DATABASE_URL` must be loopback. Do not overlay `DATABASE_PUBLIC_URL` onto `POSTGRES_URL`.)
- [ ] Application/config backup. `node db/scripts/step2d4-app-config-backup.mjs`
- [ ] Payment pause **confirmed in cabinets** (Click/Payme/Uzum remain **BLOCKED** until then). HTTP 503 is not a provider retry contract.
- [x] Maintenance mode tested locally (`step2b-run.mjs rehearsal`).
- [x] Source counts recorded (Step 2C / 2D snapshot): 46 restaurants, 85 users, 59 orders, 147 items, 54 payments.
- [ ] Working tree / tag freeze re-verified at cutover time.

`POSTGRES_POOL_MAX=10` (code default). Do not raise to theoretical max_connections math.

## Webhook matrix (unchanged policy)

| Provider | Pause method | Retry evidence | Cutover |
|---|---|---|---|
| Click | A. my.click.uz service/merchant pause (operator) | HTTP 503 + Click `error: -7` is **not** a documented guaranteed retry | **BLOCKED** until cabinet pause + confirm phrase |
| Payme | A. Payme merchant cabinet disable/pause (operator) | JSON-RPC `-32400` on HTTP 503 is **not** a documented guaranteed retry | **BLOCKED** |
| Uzum | A. Uzum merchant cabinet disable/pause (operator) | HTTP 503 is **not** a documented guaranteed retry | **BLOCKED** |

B. Merchant disable = same as A (cabinet).  
C. Durable local queue = **not implemented**.  
D. No other safe mechanism in this repo.

`NESTA_PAYMENT_PAUSE_CONFIRM` must equal `CLICK_PAYME_UZUM_PAUSED_IN_PROVIDER_CABINET` exactly. `yes` / `true` / `1` are refused.

## Rollback trigger (step 18 — arm, do not execute)

Trigger if: GATE counts fail, smoke fail, data mismatch, payment loss risk, RLS/cross-tenant failure.

**Before `DATA_BACKEND=postgres`:** keep Firebase; maintenance off after unpause; do not drop Railway load.

**After switch:** `DATA_BACKEND=firebase` + restart; keep maintenance on until divergence is understood; restore PG dump only if the loaded DB must be discarded.

## Commands (no secrets)

```
node db/scripts/step2d4-firebase-backup.mjs
# Dump source = DATABASE_PUBLIC_URL (Railway). Restore = local nesta_step2d4_restore only.
# Optional: STEP2D4_RESTORE_DATABASE_URL=postgres://USER@127.0.0.1:5432/postgres
# Required for Railway 18: PG_DUMP_BIN / PG_RESTORE_BIN pointing at PostgreSQL 18 clients.
node db/scripts/step2d4-pg-backup-restore.mjs
node db/scripts/step2d4-app-config-backup.mjs
node db/scripts/step2d2-prod-pg-preflight.mjs
node db/scripts/step2d2-backup-verify.mjs
node db/scripts/step2d5-deploy-freeze.mjs
# After production maintenance is ON (do not enable from this agent):
# $env:NESTA_CUTOVER_PROBE_BASE_URL = "https://<prod-host>"
# node db/scripts/step2d5-write-stop-probe.mjs
# node db/scripts/step2d5-freeze-snapshot.mjs --freeze-window
# node db/scripts/step2d2-prod-pg-preflight.mjs
node db/scripts/step2d5-cutover-window.mjs
```
