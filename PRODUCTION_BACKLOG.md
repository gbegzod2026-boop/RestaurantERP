# NESTA Production Backlog

## P0 — active

- [ ] Canonical platform-superadmin verifier using `platformSuperAdmin=true` and/or `PLATFORM_SUPERADMIN_UIDS`.
- [ ] Replace every duplicated/unsafe platform middleware with the canonical verifier.
- [ ] Make scoped-token tenant mismatch an unconditional 403, including legacy `isSuperAdmin=true` tokens.
- [ ] Remove `?platform=1` escalation and keep tenant RTDB routes in tenant context.
- [ ] Return generic 503 `PG_UNAVAILABLE` for transient PostgreSQL failures; do not leak database messages.
- [ ] Update RTDB rules to require canonical platform authority; review only, no deployment.
- [ ] Add regression tests for authentication, cross-tenant denial, platform authorization, and database error semantics.
- [x] Restore/prove local PostgreSQL with sanitized `SELECT 1` and `/api/pg/meta` evidence (Cursor track).

## Acceptance — pending

- [x] Run RLS suites with `REQUIRE_DB=1`; skipped tests do not count.
- [x] Live `/api/pg/rtdb/*` auth matrix against :4000 using disposable PG fixtures (own allow, foreign 403, waiter `role_denied`, composite uid canonicalization, RLS A-vs-B).
- [x] Codex P0/P1 remediations: postgres fail-closed, read RBAC, strict restId, subscribe-before-resync, denial/authority caches, transaction error propagation; `REQUIRE_DB=1` 190/190; live probe 0 failures (REAL VERIFIED).
- [ ] Real-browser admin login → dashboard → staff create (blocked: `restaurantCount=0`, no Playwright in this environment).
- [ ] Two-browser Socket.IO subscribe-ack → resync after reconnect.
- [ ] Enforced browser CSP evidence.
- [x] Confirm no secrets are tracked or staged.
