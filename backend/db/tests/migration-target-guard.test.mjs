import test from "node:test";
import assert from "node:assert/strict";
import {
  assertMigrationTarget,
  assertProductionStaticTarget,
  assertApplyTarget,
  isProductionMigrateTarget,
  sslConfigured,
  productionResumeAllowed,
  PRODUCTION_CONFIRM_PHRASE,
  PRODUCTION_REQUIRED_TAG,
} from "../scripts/lib/migrationTargetGuard.mjs";

const confirmEnv = {
  NESTA_MIGRATE_TARGET: "production",
  NESTA_PRODUCTION_MIGRATE_CONFIRM: PRODUCTION_CONFIRM_PHRASE,
  NESTA_PRODUCTION_MIGRATE_TAG: PRODUCTION_REQUIRED_TAG,
  POSTGRES_SSL: "true",
};

test("dry-run apply still requires loopback nesta_migration_dryrun", () => {
  assert.throws(() => assertMigrationTarget({ host: "db.example.com", database: "nesta_prod", user: "u" }));
  assert.throws(() => assertMigrationTarget({ host: "localhost", database: "postgres", user: "u" }));
  assert.doesNotThrow(() => assertMigrationTarget({ host: "127.0.0.1", database: "nesta_migration_dryrun", user: "u" }));
});

test("production target is not inferred from missing dry-run scope", () => {
  assert.equal(isProductionMigrateTarget({}), false);
  assert.equal(isProductionMigrateTarget({ NESTA_MIGRATE_TARGET: "prod" }), false);
  assert.equal(isProductionMigrateTarget({ NESTA_MIGRATE_TARGET: "1" }), false);
  assert.equal(isProductionMigrateTarget({ NESTA_MIGRATE_TARGET: "production" }), true);
});

test("production static guard refuses loopback, fixture DBs, missing SSL, and weak confirm", () => {
  const masked = { host: "db.example.com", database: "nesta_prod", user: "migrator" };
  assert.throws(() => assertProductionStaticTarget({ host: "localhost", database: "nesta_prod", user: "u" }, confirmEnv));
  assert.throws(() => assertProductionStaticTarget({ host: "127.0.0.1", database: "nesta_prod", user: "u" }, confirmEnv));
  assert.throws(() => assertProductionStaticTarget({ host: "::1", database: "nesta_prod", user: "u" }, confirmEnv));
  assert.throws(() => assertProductionStaticTarget({ ...masked, database: "postgres" }, confirmEnv));
  assert.throws(() => assertProductionStaticTarget({ ...masked, database: "nesta_migration_dryrun" }, confirmEnv));
  assert.throws(() => assertProductionStaticTarget(masked, { ...confirmEnv, POSTGRES_SSL: "false" }));
  assert.throws(() => assertProductionStaticTarget(masked, { ...confirmEnv, NESTA_PRODUCTION_MIGRATE_CONFIRM: "yes" }));
  assert.throws(() => assertProductionStaticTarget(masked, { ...confirmEnv, NESTA_PRODUCTION_MIGRATE_CONFIRM: "true" }));
  assert.throws(() => assertProductionStaticTarget(masked, { ...confirmEnv, NESTA_PRODUCTION_MIGRATE_TAG: "latest" }));
  assert.throws(() => assertProductionStaticTarget(masked, { ...confirmEnv, NESTA_PRODUCTION_MIGRATE_TAG: "nesta-step2c-cutover" }));
  assert.equal(PRODUCTION_REQUIRED_TAG, "nesta-step2-cutover-ready");
  assert.doesNotThrow(() => assertProductionStaticTarget(masked, confirmEnv));
});

test("sslConfigured accepts sslmode=require on the URL", () => {
  assert.equal(sslConfigured({ POSTGRES_URL: "postgres://u@h/db?sslmode=require" }), true);
  assert.equal(sslConfigured({ POSTGRES_URL: "postgres://u@h/db" }), false);
  assert.equal(sslConfigured({ POSTGRES_URL: "postgres://u@altaria.proxy.rlwy.net:1234/railway" }), true);
});

test("assertApplyTarget defaults to dry-run and only production with both phrases", () => {
  assert.equal(assertApplyTarget({ host: "localhost", database: "nesta_migration_dryrun", user: "u" }, {}), "dryrun");
  assert.throws(() => assertApplyTarget(
    { host: "db.example.com", database: "nesta_prod", user: "u" },
    { NESTA_MIGRATE_TARGET: "production" }
  ));
  assert.equal(assertApplyTarget(
    { host: "db.example.com", database: "nesta_prod", user: "u" },
    confirmEnv
  ), "production");
});

test("production resume and migrate-target aliases are not easy bypasses", () => {
  assert.equal(productionResumeAllowed({ NESTA_PRODUCTION_ALLOW_RESUME: "1" }), false);
  assert.equal(productionResumeAllowed({ NESTA_PRODUCTION_ALLOW_RESUME: "true" }), false);
  assert.equal(productionResumeAllowed({ NESTA_PRODUCTION_ALLOW_RESUME: "yes" }), false);
  assert.equal(productionResumeAllowed({ NESTA_PRODUCTION_ALLOW_RESUME: PRODUCTION_REQUIRED_TAG }), true);
  assert.throws(() => assertApplyTarget(
    { host: "db.example.com", database: "nesta_prod", user: "u" },
    { ...confirmEnv, NESTA_MIGRATE_TARGET: "PRODUCTION" }
  ));
});
