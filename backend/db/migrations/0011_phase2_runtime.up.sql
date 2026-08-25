-- 0011_phase2_runtime.up.sql
-- Phase 2 runtime support: occupancy extras on tables/employees, and a
-- durable per-tenant realtime event log for WebSocket missed-event recovery.
-- Applied inside one transaction by db/migrate.js.
BEGIN;

ALTER TABLE tables ADD COLUMN IF NOT EXISTS extra jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS extra jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS extra jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE menu_categories ADD COLUMN IF NOT EXISTS extra jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE realtime_events (
  id              bigserial PRIMARY KEY,
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  seq             bigint NOT NULL,
  event_type      text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, seq)
);
CREATE INDEX idx_realtime_events_restaurant_created
  ON realtime_events (restaurant_id, created_at DESC);

SELECT apply_tenant_rls('realtime_events');
GRANT USAGE, SELECT ON SEQUENCE realtime_events_id_seq TO nesta_app;

COMMIT;
