-- 0001_wave0_core.up.sql
-- Wave 0 — core identity: organizations, restaurants, employees,
-- employee_credentials, custom_roles, role_overrides, restaurant_modules,
-- platform_users, two_factor_credentials, backup_codes.
--
-- Source: PostgreSQL Target Architecture doc §3 (Platform & Identity
-- domain) and the Firebase Exit Map. Every table below traces to a real
-- RTDB path family from that audit — see the Wave 0 report for the exact
-- mapping. CODE VERIFIED, not LIVE VERIFIED — no PostgreSQL instance was
-- available in this environment to actually run this file; run
-- `node db/migrate.js up` against a real instance before trusting it.
--
-- Applied inside one transaction by db/migrate.js. The explicit BEGIN/COMMIT
-- here is redundant under that runner but keeps this file self-consistent
-- if it's ever run directly via `psql -f`.
BEGIN;

-- ── Extensions ────────────────────────────────────────────────────────
-- gen_random_uuid() — available natively from PostgreSQL 13 onward, but
-- enabling pgcrypto explicitly avoids depending on exactly which version
-- this runs against.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Roles ─────────────────────────────────────────────────────────────
-- nesta_app: the role the Express backend connects as at runtime once a
-- later wave wires it in. Nothing in the running app uses this yet — see
-- the Wave 0 report. No password is set here; run
-- `node db/set-app-role-password.js` separately with POSTGRES_APP_PASSWORD
-- in the environment. Credentials never appear in migration SQL.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nesta_app') THEN
    CREATE ROLE nesta_app LOGIN;
  END IF;
END $$;

-- nesta_login_reader / nesta_credential_revealer: narrow, password-less
-- roles nesta_app is a MEMBER of but does not run as by default — a future
-- wave's login-verification / superadmin-reveal code paths SET ROLE into
-- one of these for exactly the one statement that needs it, then reset.
-- Membership alone grants nothing until that SET ROLE happens (see the
-- column-level GRANTs below, issued to these roles specifically, not to
-- nesta_app). This is the direct relational descendant of the RTDB P0-2
-- fix's "credentials live on a structurally separate path only two code
-- paths ever touch" design — same principle, enforced by the database
-- itself instead of by rule-path topology.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nesta_login_reader') THEN
    CREATE ROLE nesta_login_reader NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nesta_credential_revealer') THEN
    CREATE ROLE nesta_credential_revealer NOLOGIN;
  END IF;
END $$;

-- WITH INHERIT FALSE (PostgreSQL 16+) is load-bearing, not decoration:
-- without it, PostgreSQL's DEFAULT membership behavior means nesta_app
-- would automatically carry nesta_login_reader/nesta_credential_revealer's
-- privileges at ALL times just by being a member — SET ROLE would then be
-- pure documentation, not an actual privilege boundary. Found live during
-- Wave 0 verification: nesta_app could SELECT password_hash directly, with
-- no SET ROLE at all, before this was added. WITH INHERIT FALSE keeps the
-- membership (so SET ROLE is still permitted) while requiring that
-- explicit SET ROLE before any of that role's extra privileges apply.
GRANT nesta_login_reader TO nesta_app WITH INHERIT FALSE;
GRANT nesta_credential_revealer TO nesta_app WITH INHERIT FALSE;

-- Lets whichever role runs this migration impersonate nesta_app via
-- `SET ROLE nesta_app` (needed for db/tests/rls.test.mjs to exercise RLS
-- as the actual app role would see it, without requiring nesta_app's
-- login password to be set first — SET ROLE only needs membership, not a
-- password). Harmless in production: SET ROLE still requires the caller to
-- already be authenticated as this membership-holding role in the first
-- place.
GRANT nesta_app TO CURRENT_USER;

-- ── organizations ─────────────────────────────────────────────────────
-- Not tenant-scoped — spans multiple restaurants. Minimal shape for Wave 0;
-- organization_restaurants / franchises are deferred to the Wave 5
-- superadmin pass per the architecture doc.
CREATE TABLE organizations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  status       text NOT NULL DEFAULT 'active',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ── restaurants ───────────────────────────────────────────────────────
-- Firebase source: restaurants/$restId/info + subscription (partial —
-- subscription/tariff/franchise columns are added by later waves; Wave 0
-- only needs enough for identity + tenant-boundary + RLS proof).
CREATE TABLE restaurants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id    text UNIQUE,   -- the old "rest_1782..." string; dual-write join key, dropped post-retirement
  domain            text NOT NULL UNIQUE,
  name              text NOT NULL,
  status            text NOT NULL DEFAULT 'active',
  organization_id   uuid REFERENCES organizations(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurants_legacy_rtdb_id ON restaurants (legacy_rtdb_id) WHERE legacy_rtdb_id IS NOT NULL;
CREATE INDEX idx_restaurants_organization_id ON restaurants (organization_id) WHERE organization_id IS NOT NULL;

-- ── platform_users ────────────────────────────────────────────────────
-- Firebase source: systemData/platformUsers. firebase_uid is a nullable
-- MAPPING column only — id (a native Postgres uuid) is the real identity,
-- per task points 7/8 ("never mix Firebase Auth UID with the RTDB/SQL
-- user id", "never the primary key").
CREATE TABLE platform_users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid   text UNIQUE,
  email          text NOT NULL,
  display_name   text,
  role           text NOT NULL DEFAULT 'support',
  permissions    jsonb NOT NULL DEFAULT '{}'::jsonb,
  status         text NOT NULL DEFAULT 'active',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
-- Case-insensitive uniqueness without requiring the citext extension.
CREATE UNIQUE INDEX idx_platform_users_email_lower ON platform_users (lower(email));

-- ── custom_roles ──────────────────────────────────────────────────────
-- Firebase source: restaurants/$restId/customRoles
CREATE TABLE custom_roles (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name           text NOT NULL,
  modules        jsonb NOT NULL DEFAULT '[]'::jsonb,
  actions        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, name)
);
CREATE INDEX idx_custom_roles_restaurant_id ON custom_roles (restaurant_id);

-- ── role_overrides ────────────────────────────────────────────────────
-- Firebase source: restaurants/$restId/roleOverrides — keyed by base role
-- name directly, matching the RTDB shape (no synthetic id needed).
CREATE TABLE role_overrides (
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  base_role      text NOT NULL,
  modules        jsonb,
  actions        jsonb,
  PRIMARY KEY (restaurant_id, base_role)
);

-- ── restaurant_modules ────────────────────────────────────────────────
-- Firebase source: restaurants/$restId/modules
CREATE TABLE restaurant_modules (
  restaurant_id     uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  enabled_modules   text[] NOT NULL DEFAULT '{}'
);

-- ── employees ─────────────────────────────────────────────────────────
-- Firebase source: restaurants/$restId/users
CREATE TABLE employees (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_rtdb_id    text,
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name              text NOT NULL,
  login             text NOT NULL,
  role              text NOT NULL,
  custom_role_id    uuid REFERENCES custom_roles(id) ON DELETE SET NULL,
  modules           jsonb,
  actions           jsonb,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- Composite uniqueness ONLY (task point 6/"IMPORTANT"): an RTDB key like
  -- "admin_1" was never globally unique across restaurants — a bare UNIQUE
  -- on legacy_rtdb_id alone would reject the second restaurant's own
  -- "admin_1" at import time.
  UNIQUE (restaurant_id, legacy_rtdb_id),
  UNIQUE (restaurant_id, login)
);
CREATE INDEX idx_employees_restaurant_id ON employees (restaurant_id);

-- ── employee_credentials ──────────────────────────────────────────────
-- Firebase source: credentials/$restId/$userId (the P0-2 residual-gap fix's
-- structurally-separate path). Separate table, not columns on employees —
-- see the column-level GRANTs at the bottom of this file for why.
CREATE TABLE employee_credentials (
  employee_id    uuid PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  password_hash  text,
  password_enc   text,
  rotated_at     timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ── two_factor_credentials ────────────────────────────────────────────
-- Firebase source: systemData/twoFactorSuperAdmin, systemData/platformUsers/
-- */twoFactor, restaurants/*/users/*/twoFactor — unified into one
-- polymorphic table (owner_type + owner_id), per the architecture doc.
CREATE TABLE two_factor_credentials (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type            text NOT NULL CHECK (owner_type IN ('superadmin', 'platform_user', 'employee')),
  owner_id              uuid NOT NULL, -- polymorphic: platform_users.id or employees.id — enforced below by trigger, not a plain FK
  secret_enc            text,
  pending_secret_enc    text,
  enabled               boolean NOT NULL DEFAULT false,
  enabled_at            timestamptz,
  UNIQUE (owner_type, owner_id)
);

-- A plain FK can't reference "one of two tables depending on a column
-- value" — this trigger enforces the same referential integrity a real FK
-- would for the two owner_types that have a backing table. 'superadmin' has
-- none (the raw superadmin account isn't a platform_users row), so it's
-- exempted.
CREATE OR REPLACE FUNCTION check_two_factor_owner() RETURNS trigger AS $$
BEGIN
  IF NEW.owner_type = 'platform_user' THEN
    IF NOT EXISTS (SELECT 1 FROM platform_users WHERE id = NEW.owner_id) THEN
      RAISE EXCEPTION 'two_factor_credentials.owner_id % does not exist in platform_users', NEW.owner_id;
    END IF;
  ELSIF NEW.owner_type = 'employee' THEN
    IF NOT EXISTS (SELECT 1 FROM employees WHERE id = NEW.owner_id) THEN
      RAISE EXCEPTION 'two_factor_credentials.owner_id % does not exist in employees', NEW.owner_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_two_factor_owner_check
  BEFORE INSERT OR UPDATE ON two_factor_credentials
  FOR EACH ROW EXECUTE FUNCTION check_two_factor_owner();

-- ── backup_codes ──────────────────────────────────────────────────────
-- Firebase source: */twoFactor/backupCodeHashes (was an array; one row per
-- code here, per the architecture doc's "a used code deserves its own
-- timestamp, not just removal" reasoning).
CREATE TABLE backup_codes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  two_factor_id    uuid NOT NULL REFERENCES two_factor_credentials(id) ON DELETE CASCADE,
  code_hash        text NOT NULL,
  used_at          timestamptz
);
CREATE INDEX idx_backup_codes_two_factor_id ON backup_codes (two_factor_id);

-- ── updated_at maintenance (shared trigger function) ─────────────────
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_organizations_updated_at BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_restaurants_updated_at BEFORE UPDATE ON restaurants FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_platform_users_updated_at BEFORE UPDATE ON platform_users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_employees_updated_at BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_employee_credentials_updated_at BEFORE UPDATE ON employee_credentials FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Role-escalation-prevention trigger ────────────────────────────────
-- Closes the exact gap PRODUCTION-AUDIT.md's P0-2 finding documented as
-- unfixable in RTDB: "a deeper .write rule can never revoke a shallower
-- ancestor's grant — a chef session successfully wrote its own role to
-- owner despite role's own .write rule, and this was left uncorrected
-- because RTDB has no structural fix for it." Postgres has no such
-- limitation — this trigger runs on every UPDATE that changes
-- employees.role and rejects it unless the acting session is
-- platform-level or is itself an owner/admin for this same restaurant.
-- Requires the caller to have used withTenantContext(restaurantId, fn,
-- {actingRole}) — see db/postgres.js.
CREATE OR REPLACE FUNCTION prevent_role_escalation() RETURNS trigger AS $$
DECLARE
  ctx_restaurant text := current_setting('app.current_restaurant_id', true);
  ctx_role text := current_setting('app.current_employee_role', true);
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    IF ctx_restaurant IS NULL OR ctx_restaurant = '' THEN
      RETURN NEW; -- platform-level session
    END IF;
    IF ctx_role IN ('owner', 'admin') THEN
      RETURN NEW; -- same-restaurant owner/admin
    END IF;
    RAISE EXCEPTION 'role change denied: session role "%" for restaurant % may not change employees.role', ctx_role, ctx_restaurant;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_employees_prevent_role_escalation
  BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION prevent_role_escalation();

-- ── Row-Level Security ────────────────────────────────────────────────
-- Session contract, set by db/postgres.js's withTenantContext/
-- withPlatformContext: app.current_restaurant_id is either a real
-- restaurants.id (tenant session) or '' (platform session — the direct
-- equivalent of database.rules.json's "auth.token.restId == null means
-- platform-level" convention).
--
-- FORCE ROW LEVEL SECURITY on every table below — without it, the table
-- OWNER (nesta_migrator, whatever role ran this migration) bypasses RLS
-- entirely by default, which would silently defeat every policy the moment
-- the app connects using that same role by mistake.
--
-- NULLIF(..., '')::uuid, not a bare ::uuid — found live during Wave 0
-- verification: a plain `current_setting(...) = '' OR restaurant_id =
-- current_setting(...)::uuid` crashed platform-context queries outright
-- (casting '' to uuid throws) even though the OR's left side was already
-- true, because the planner can evaluate/plan the right-hand cast (e.g. to
-- build an index scan bound on the restaurant_id index) independently of
-- the boolean short-circuit a procedural reader would expect. NULLIF turns
-- the empty-string platform-context case into NULL before the cast, and
-- NULL::uuid is always a safe NULL, never an error — a genuinely malformed
-- non-empty context (a forged garbage restaurant_id) still fails the cast
-- and is correctly denied, that behavior is unchanged.

ALTER TABLE restaurants ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurants FORCE ROW LEVEL SECURITY;
CREATE POLICY restaurants_select ON restaurants FOR SELECT USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);
-- A restaurant's own identity row is platform-managed only — a tenant
-- session may read it but never create/alter/delete it (matches
-- superadmin.js, not admin.js, owning this data today).
CREATE POLICY restaurants_insert ON restaurants FOR INSERT WITH CHECK (
  current_setting('app.current_restaurant_id', true) = ''
);
CREATE POLICY restaurants_update ON restaurants FOR UPDATE USING (
  current_setting('app.current_restaurant_id', true) = ''
) WITH CHECK (
  current_setting('app.current_restaurant_id', true) = ''
);
CREATE POLICY restaurants_delete ON restaurants FOR DELETE USING (
  current_setting('app.current_restaurant_id', true) = ''
);

ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees FORCE ROW LEVEL SECURITY;
CREATE POLICY employees_select ON employees FOR SELECT USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);
CREATE POLICY employees_insert ON employees FOR INSERT WITH CHECK (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);
CREATE POLICY employees_update ON employees FOR UPDATE USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
) WITH CHECK (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);
CREATE POLICY employees_delete ON employees FOR DELETE USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);

ALTER TABLE custom_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY custom_roles_select ON custom_roles FOR SELECT USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);
CREATE POLICY custom_roles_insert ON custom_roles FOR INSERT WITH CHECK (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);
CREATE POLICY custom_roles_update ON custom_roles FOR UPDATE USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
) WITH CHECK (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);
CREATE POLICY custom_roles_delete ON custom_roles FOR DELETE USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);

ALTER TABLE role_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY role_overrides_select ON role_overrides FOR SELECT USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);
CREATE POLICY role_overrides_insert ON role_overrides FOR INSERT WITH CHECK (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);
CREATE POLICY role_overrides_update ON role_overrides FOR UPDATE USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
) WITH CHECK (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);
CREATE POLICY role_overrides_delete ON role_overrides FOR DELETE USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);

ALTER TABLE restaurant_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurant_modules FORCE ROW LEVEL SECURITY;
CREATE POLICY restaurant_modules_select ON restaurant_modules FOR SELECT USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);
CREATE POLICY restaurant_modules_insert ON restaurant_modules FOR INSERT WITH CHECK (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);
CREATE POLICY restaurant_modules_update ON restaurant_modules FOR UPDATE USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
) WITH CHECK (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);
CREATE POLICY restaurant_modules_delete ON restaurant_modules FOR DELETE USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
);

-- employee_credentials: row visibility follows the OWNING employee's
-- restaurant (subquery — this table has no restaurant_id column of its own
-- by design, see the architecture doc §7). Row-level ALLOW here is
-- necessary but NOT sufficient to read a secret — the column-level GRANTs
-- below are the actual reveal gate. INSERT/UPDATE additionally require the
-- acting employee to be owner/admin (or platform), mirroring the RTDB
-- ".validate" condition this replaces. No DELETE policy is defined, so
-- DELETE is denied for every role by RLS's default-deny — credentials are
-- rotated (UPDATE), never hard-deleted, while the owning employee exists
-- (deleting the employee CASCADEs this row instead).
ALTER TABLE employee_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_credentials_select ON employee_credentials FOR SELECT USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR employee_id IN (SELECT id FROM employees WHERE restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid)
);
CREATE POLICY employee_credentials_insert ON employee_credentials FOR INSERT WITH CHECK (
  current_setting('app.current_restaurant_id', true) = ''
  OR employee_id IN (SELECT id FROM employees WHERE restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid AND role IN ('owner', 'admin'))
);
CREATE POLICY employee_credentials_update ON employee_credentials FOR UPDATE USING (
  current_setting('app.current_restaurant_id', true) = ''
  OR employee_id IN (SELECT id FROM employees WHERE restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid AND role IN ('owner', 'admin'))
) WITH CHECK (
  current_setting('app.current_restaurant_id', true) = ''
  OR employee_id IN (SELECT id FROM employees WHERE restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid AND role IN ('owner', 'admin'))
);

-- platform_users / two_factor_credentials / backup_codes / organizations
-- are platform-level tables (not restaurant-tenant-scoped) — access control
-- for these stays at the application layer (requireSuperAdmin, same as
-- every superadmin* router today), matching the architecture doc §6's
-- explicit list of cross-tenant tables. No RLS policy is defined for them
-- in Wave 0; this is a deliberate scope decision, not an oversight.

-- ── Column-level privilege boundary (the real secret-reveal gate) ─────
REVOKE ALL ON employee_credentials FROM PUBLIC;
GRANT SELECT (employee_id, rotated_at, updated_at) ON employee_credentials TO nesta_app;
GRANT INSERT ON employee_credentials TO nesta_app;
GRANT UPDATE (password_hash, password_enc, rotated_at, updated_at) ON employee_credentials TO nesta_app;
-- employee_id is included too — it's not just SELECT-list columns that
-- need a grant, any column referenced anywhere in the query (a WHERE
-- filter on employee_id, in the realistic "look up this one employee's
-- credential" query shape) needs one as well. Found live during Wave 0
-- verification: password_hash/password_enc alone denied the exact lookup
-- query these roles exist to run.
GRANT SELECT (employee_id, password_hash) ON employee_credentials TO nesta_login_reader;
GRANT SELECT (employee_id, password_enc) ON employee_credentials TO nesta_credential_revealer;

-- employee_credentials' own RLS policies (above) reference employees via a
-- subquery (`employee_id IN (SELECT id FROM employees WHERE
-- restaurant_id = ...)`) — that subquery runs AS the querying role, so
-- nesta_login_reader/nesta_credential_revealer need enough access to
-- employees to satisfy it too, even though neither role has any business
-- reading employee data otherwise. Found live during Wave 0 verification:
-- without this, the credential query failed with "permission denied for
-- table employees", not employee_credentials — the RLS policy itself
-- couldn't evaluate. Scoped to exactly the two columns that subquery uses.
GRANT SELECT (id, restaurant_id) ON employees TO nesta_login_reader;
GRANT SELECT (id, restaurant_id) ON employees TO nesta_credential_revealer;

-- Every other Wave 0 table: ordinary table-level grants — RLS still governs
-- which ROWS are visible regardless of how broad the table-level grant is.
GRANT SELECT, INSERT, UPDATE, DELETE ON organizations TO nesta_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON restaurants TO nesta_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_users TO nesta_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON custom_roles TO nesta_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON role_overrides TO nesta_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON restaurant_modules TO nesta_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON employees TO nesta_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON two_factor_credentials TO nesta_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON backup_codes TO nesta_app;

COMMIT;
