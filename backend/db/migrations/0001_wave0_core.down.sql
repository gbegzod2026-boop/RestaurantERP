-- 0001_wave0_core.down.sql
-- Full reversal of 0001_wave0_core.up.sql. Drops tables in reverse
-- dependency order (policies/triggers/column-grants are dropped implicitly
-- with their table — no separate DROP POLICY/TRIGGER statements needed).
--
-- Deliberately does NOT drop the pgcrypto extension — see the Wave 0
-- report for why (a shared extension is not safe to assume this migration
-- exclusively owns).
BEGIN;

DROP TABLE IF EXISTS backup_codes;
DROP TABLE IF EXISTS two_factor_credentials;
DROP TABLE IF EXISTS employee_credentials;
DROP TABLE IF EXISTS employees;
DROP TABLE IF EXISTS restaurant_modules;
DROP TABLE IF EXISTS role_overrides;
DROP TABLE IF EXISTS custom_roles;
DROP TABLE IF EXISTS platform_users;
DROP TABLE IF EXISTS restaurants;
DROP TABLE IF EXISTS organizations;

DROP FUNCTION IF EXISTS prevent_role_escalation();
DROP FUNCTION IF EXISTS check_two_factor_owner();
DROP FUNCTION IF EXISTS set_updated_at();

-- Roles last, once nothing references them. Safe even if a password was
-- set separately via db/set-app-role-password.js — DROP ROLE removes that
-- too; re-running `up` + set-app-role-password.js restores both.
DROP ROLE IF EXISTS nesta_credential_revealer;
DROP ROLE IF EXISTS nesta_login_reader;
DROP ROLE IF EXISTS nesta_app;

COMMIT;
