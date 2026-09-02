-- 0018_production_migration_attempts.down.sql
BEGIN;
DROP TRIGGER IF EXISTS production_migration_attempts_protect_terminal ON production_migration_attempts;
DROP FUNCTION IF EXISTS production_migration_attempts_protect_terminal();
DROP TABLE IF EXISTS production_migration_attempts;
COMMIT;
