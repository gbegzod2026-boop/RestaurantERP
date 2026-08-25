# NESTA Production Status

Status: **P0 code remediation implemented; infrastructure acceptance blocked — not deploy-ready**

## Confirmed risks

- PostgreSQL is configured but unreachable; no local PostgreSQL runtime is installed or listening.
- Historical tokens may contain legacy `isSuperAdmin=true`; patched tenant authorization ignores it and rejects mismatches unconditionally.
- Firebase RTDB canonical-authority rules are patched locally but intentionally undeployed.

## Current controls

- Production deployment, data migration, rules deployment, session revocation, and live credential changes are prohibited without user approval.
- Canonical platform authorization and generic PostgreSQL error semantics are implemented with focused regressions passing.
- Local PostgreSQL restoration is blocked pending identification/provisioning of the intended database server.

## Release gate

All rows in `ACCEPTANCE_MATRIX.md` must have non-skipped PASS evidence and Git must contain no secrets.
