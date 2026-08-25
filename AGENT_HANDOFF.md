# NESTA Agent Handoff

## Codex track

- Owner: security architecture, implementation review, tests, acceptance, safe Git baseline.
- Current: canonical platform authority, unconditional tenant isolation, tenant-context-only bridge, RTDB rule review patch, and generic PostgreSQL error mapping implemented locally.
- Verification: 7 focused security regressions pass; modified JavaScript modules pass `node --check`. Firebase rules were not deployed.
- Production actions: none authorized.

## Cursor track

- Owner: local PostgreSQL/Windows/Docker/listener diagnosis and browser/runtime execution.
- Constraints: no authorization-code changes; never print credentials or connection strings.
- Sanitized configuration evidence (2026-08-25): `DATA_BACKEND=postgres`; PostgreSQL host class is loopback; port is `5432`; database/user/app-password fields are present. Values and connection strings were not printed.
- Windows evidence: no PostgreSQL/pgsql service is registered, no `postgres` process is running, and no listener exists on loopback port `5432`.
- Runtime availability: `psql`, `pg_ctl`, and `postgres` are unavailable on `PATH`; no installation was found in the standard PostgreSQL Program Files locations or PostgreSQL installation registry key. Docker is unavailable and WSL has no distribution installed.
- Connectivity proof: loopback TCP probe to `5432` failed. Consequently, a safe `SELECT 1` cannot be run yet.
- API proof: the already-running local API at port `4000` returned HTTP `200` from `/api/pg/meta` with sanitized metadata `postgresConfigured=true`, `postgresReachable=false`, `dataBackend=postgres`.
- Blocker: restoring connectivity requires provisioning or identifying a PostgreSQL server and its intended data source. Installing/initializing a fresh server could diverge from the expected database and requires user/infrastructure direction; no installation, migration, credential change, or authorization-code change was made.

## Shared protocol

- Re-read this file before editing and merge rather than overwrite another agent's evidence.
- Record commands/results without secrets, raw tokens, private hosts, or passwords.
