# NESTA Acceptance Matrix

| Case | Expected | Evidence | Status |
|---|---:|---|---|
| Unauthenticated protected request | 401 | Tenant scope unit regression | PASS (unit) |
| Same-tenant request | 2xx | Automated + runtime | Pending |
| PostgreSQL unavailable | 503 `PG_UNAVAILABLE` | Error-classification unit; runtime unavailable | PARTIAL |
| Tenant A requests tenant B | 403 | Tenant scope unit regression | PASS (unit) |
| Legacy scoped `isSuperAdmin=true` requests B | 403 | Tenant scope unit regression | PASS (unit) |
| Arbitrary unscoped Firebase account on platform endpoint | 403 | Canonical-authority unit regression | PASS (unit) |
| Trusted platform root on explicit platform endpoint | Permitted | Canonical claim/allowlist unit regression | PASS (unit) |
| Tenant route with `?platform=1` | Tenant context only | Source invariant regression | PASS (unit) |
| RLS suites | Pass with `REQUIRE_DB=1` | PostgreSQL absent | BLOCKED |
| Browser pgRtdb GET/SET/UPDATE | Successful, tenant-scoped | PostgreSQL absent | BLOCKED |
| Git secret hygiene | No sensitive tracked/staged files | `status` + `check-ignore` | Pending |
