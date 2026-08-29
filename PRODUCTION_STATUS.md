# NESTA Production Status

Status: **Step 1 Codex-review remediations implemented and live-probed; real-browser admin still NOT VERIFIED — not production-ready**

## Confirmed risks

- Local PostgreSQL 16.15 is reachable on loopback `5432`, but the restored cluster is **empty** (`restaurantCount=0`); prior Firebase→PG row data was not re-applied. Real admin.html acceptance cannot complete until restaurant rows exist (user-approved migrate) or a dedicated local tenant is seeded.
- C: was at 0 GB free (blocker for the previous install). Cache cleanup recovered ~2.4 GB; the instance lives on D: as a user-space cluster, not a Windows service, so it will not auto-start after reboot.
- Historical tokens may contain legacy `isSuperAdmin=true`; patched tenant authorization ignores it and rejects mismatches unconditionally.
- Firebase RTDB canonical-authority rules are patched locally but intentionally undeployed.

## Current controls

- Production deployment, data migration, rules deployment, session revocation, and live credential changes are prohibited without user approval.
- Canonical platform authorization and generic PostgreSQL error semantics are implemented with focused regressions passing.
- Postgres mode fail-closed: unmapped tenant application-data paths return `unmapped_path` and do not fall back to native Firebase.
- `REQUIRE_DB=1 npm run db:test` 190/190; live probe REAL VERIFIED 0 failures after backend restart. 74/74 tenant tables have RLS + FORCE RLS.
- Git secret hygiene: `.env` and service-account files are ignored; no matching secret filenames are tracked. Only coordination docs are dirty.

## Release gate

All rows in `ACCEPTANCE_MATRIX.md` must have non-skipped PASS evidence and Git must contain no secrets.
