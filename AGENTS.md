# NESTA Agent Contract

- Treat restaurant administration and platform administration as separate authority domains.
- A token containing `restId` or `restaurantId` is tenant-scoped and can never cross tenants.
- Platform authority requires the server-owned `platformSuperAdmin=true` claim or an explicit `PLATFORM_SUPERADMIN_UIDS` bootstrap allowlist.
- Never infer platform authority from missing tenant scope, email, role, or legacy `isSuperAdmin`.
- Use the shared canonical platform-superadmin verifier; do not duplicate middleware.
- Tenant PostgreSQL/RTDB routes always use tenant context. Never honor request-controlled platform escalation.
- Preserve PostgreSQL RLS and never fall back to Firebase when `DATA_BACKEND=postgres`.
- HTTP semantics: credentials 401; permission/tenant mismatch 403; input 400; missing resource 404; transient PostgreSQL failure 503 `PG_UNAVAILABLE`; unexpected failure generic 500.
- Never return raw database errors or secrets.
- Never stage, print, or expose `.env`, service-account files, tokens, passwords, cookies, keys, credential/migration backup JSON, sensitive logs, or `node_modules`.
- Preserve user work and backup files. Do not deploy rules, migrate production data, revoke live sessions, or alter live credentials without explicit user approval.
- Record sanitized evidence and ownership in the root coordination documents.
- RLS acceptance requires `REQUIRE_DB=1`; skips are not passes.
