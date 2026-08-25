-- 0012_employee_credentials_actor_rls.down.sql
-- Restores the exact pre-0012 credential mutation policies. DELETE returns
-- to RLS default-deny and its 0012-only table privilege is revoked.
BEGIN;

DROP POLICY IF EXISTS employee_credentials_insert ON employee_credentials;
DROP POLICY IF EXISTS employee_credentials_update ON employee_credentials;
DROP POLICY IF EXISTS employee_credentials_delete ON employee_credentials;

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

REVOKE DELETE ON employee_credentials FROM nesta_app;

COMMIT;
