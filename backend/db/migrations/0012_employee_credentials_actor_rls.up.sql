-- 0012_employee_credentials_actor_rls.up.sql
-- Credential mutation authority belongs to the verified tenant actor, not
-- to the role of the employee whose credential is being managed.
BEGIN;

DROP POLICY IF EXISTS employee_credentials_insert ON employee_credentials;
DROP POLICY IF EXISTS employee_credentials_update ON employee_credentials;
DROP POLICY IF EXISTS employee_credentials_delete ON employee_credentials;

CREATE POLICY employee_credentials_insert ON employee_credentials FOR INSERT WITH CHECK (
  current_setting('app.current_employee_role', true) IN ('owner', 'admin')
  AND employee_id IN (
    SELECT id FROM employees
     WHERE restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
  )
);

CREATE POLICY employee_credentials_update ON employee_credentials FOR UPDATE USING (
  current_setting('app.current_employee_role', true) IN ('owner', 'admin')
  AND employee_id IN (
    SELECT id FROM employees
     WHERE restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
  )
) WITH CHECK (
  current_setting('app.current_employee_role', true) IN ('owner', 'admin')
  AND employee_id IN (
    SELECT id FROM employees
     WHERE restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
  )
);

CREATE POLICY employee_credentials_delete ON employee_credentials FOR DELETE USING (
  current_setting('app.current_employee_role', true) IN ('owner', 'admin')
  AND employee_id IN (
    SELECT id FROM employees
     WHERE restaurant_id = NULLIF(current_setting('app.current_restaurant_id', true), '')::uuid
  )
);

GRANT DELETE ON employee_credentials TO nesta_app;
ALTER TABLE employee_credentials FORCE ROW LEVEL SECURITY;

COMMIT;
