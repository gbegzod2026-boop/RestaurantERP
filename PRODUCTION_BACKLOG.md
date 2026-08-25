# NESTA Production Backlog

## P0 — active

- [ ] Canonical platform-superadmin verifier using `platformSuperAdmin=true` and/or `PLATFORM_SUPERADMIN_UIDS`.
- [ ] Replace every duplicated/unsafe platform middleware with the canonical verifier.
- [ ] Make scoped-token tenant mismatch an unconditional 403, including legacy `isSuperAdmin=true` tokens.
- [ ] Remove `?platform=1` escalation and keep tenant RTDB routes in tenant context.
- [ ] Return generic 503 `PG_UNAVAILABLE` for transient PostgreSQL failures; do not leak database messages.
- [ ] Update RTDB rules to require canonical platform authority; review only, no deployment.
- [ ] Add regression tests for authentication, cross-tenant denial, platform authorization, and database error semantics.
- [ ] Restore/prove local PostgreSQL with sanitized `SELECT 1` and `/api/pg/meta` evidence (Cursor track).

## Acceptance — pending

- [ ] Run RLS suites with `REQUIRE_DB=1`; skipped tests do not count.
- [ ] Real-browser pgRtdb GET/SET/UPDATE acceptance.
- [ ] Confirm no secrets are tracked or staged.
