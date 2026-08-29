-- Customer catalog reads required for server-authoritative order pricing.
-- Restrictive ALL-deny from 0013 blocked modifiers/extras/stop_list SELECT.
BEGIN;

DROP POLICY IF EXISTS modifiers_customer_deny ON modifiers;
DROP POLICY IF EXISTS extras_customer_deny ON extras;
DROP POLICY IF EXISTS stop_list_customer_deny ON stop_list;

CREATE POLICY modifiers_customer_no_ins ON modifiers
  AS RESTRICTIVE FOR INSERT TO nesta_app WITH CHECK (NOT app_is_customer());
CREATE POLICY modifiers_customer_no_upd ON modifiers
  AS RESTRICTIVE FOR UPDATE TO nesta_app USING (NOT app_is_customer()) WITH CHECK (NOT app_is_customer());
CREATE POLICY modifiers_customer_no_del ON modifiers
  AS RESTRICTIVE FOR DELETE TO nesta_app USING (NOT app_is_customer());

CREATE POLICY extras_customer_no_ins ON extras
  AS RESTRICTIVE FOR INSERT TO nesta_app WITH CHECK (NOT app_is_customer());
CREATE POLICY extras_customer_no_upd ON extras
  AS RESTRICTIVE FOR UPDATE TO nesta_app USING (NOT app_is_customer()) WITH CHECK (NOT app_is_customer());
CREATE POLICY extras_customer_no_del ON extras
  AS RESTRICTIVE FOR DELETE TO nesta_app USING (NOT app_is_customer());

CREATE POLICY stop_list_customer_no_ins ON stop_list
  AS RESTRICTIVE FOR INSERT TO nesta_app WITH CHECK (NOT app_is_customer());
CREATE POLICY stop_list_customer_no_upd ON stop_list
  AS RESTRICTIVE FOR UPDATE TO nesta_app USING (NOT app_is_customer()) WITH CHECK (NOT app_is_customer());
CREATE POLICY stop_list_customer_no_del ON stop_list
  AS RESTRICTIVE FOR DELETE TO nesta_app USING (NOT app_is_customer());

COMMIT;
