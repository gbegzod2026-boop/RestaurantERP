BEGIN;

DROP POLICY IF EXISTS modifiers_customer_no_ins ON modifiers;
DROP POLICY IF EXISTS modifiers_customer_no_upd ON modifiers;
DROP POLICY IF EXISTS modifiers_customer_no_del ON modifiers;
DROP POLICY IF EXISTS extras_customer_no_ins ON extras;
DROP POLICY IF EXISTS extras_customer_no_upd ON extras;
DROP POLICY IF EXISTS extras_customer_no_del ON extras;
DROP POLICY IF EXISTS stop_list_customer_no_ins ON stop_list;
DROP POLICY IF EXISTS stop_list_customer_no_upd ON stop_list;
DROP POLICY IF EXISTS stop_list_customer_no_del ON stop_list;

CREATE POLICY modifiers_customer_deny ON modifiers
  AS RESTRICTIVE FOR ALL TO nesta_app USING (NOT app_is_customer()) WITH CHECK (NOT app_is_customer());
CREATE POLICY extras_customer_deny ON extras
  AS RESTRICTIVE FOR ALL TO nesta_app USING (NOT app_is_customer()) WITH CHECK (NOT app_is_customer());
CREATE POLICY stop_list_customer_deny ON stop_list
  AS RESTRICTIVE FOR ALL TO nesta_app USING (NOT app_is_customer()) WITH CHECK (NOT app_is_customer());

COMMIT;
