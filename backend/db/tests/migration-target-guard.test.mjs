import test from "node:test";
import assert from "node:assert/strict";
import {
  CUTOVER_CANDIDATE_TAG,
  HISTORICAL_FROZEN_TAG,
  STEP2C_TAG,
} from "../scripts/lib/deployFreeze.mjs";
import {
  assertMigrationTarget,
  assertProductionStaticTarget,
  assertApplyTarget,
  isProductionMigrateTarget,
  sslConfigured,
  productionResumeAllowed,
  enforceConnectedApplyTarget,
  PRODUCTION_CONFIRM_PHRASE,
  PRODUCTION_REQUIRED_TAG,
  REQUIRED_SCHEMA_VERSION,
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
  assert.throws(() => assertProductionStaticTarget(masked, { ...confirmEnv, NESTA_PRODUCTION_MIGRATE_TAG: HISTORICAL_FROZEN_TAG }));
  assert.throws(() => assertProductionStaticTarget(masked, { ...confirmEnv, NESTA_PRODUCTION_MIGRATE_TAG: STEP2C_TAG }));
  assert.equal(PRODUCTION_REQUIRED_TAG, CUTOVER_CANDIDATE_TAG);
  assert.equal(PRODUCTION_REQUIRED_TAG, "nesta-step2d5-reviewed-cutover");
  assert.notEqual(PRODUCTION_REQUIRED_TAG, HISTORICAL_FROZEN_TAG);
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
  assert.equal(productionResumeAllowed({ NESTA_PRODUCTION_ALLOW_RESUME: HISTORICAL_FROZEN_TAG }), false);
  assert.equal(productionResumeAllowed({ NESTA_PRODUCTION_ALLOW_RESUME: STEP2C_TAG }), false);
  assert.throws(() => assertApplyTarget(
    { host: "db.example.com", database: "nesta_prod", user: "u" },
    { ...confirmEnv, NESTA_MIGRATE_TARGET: "PRODUCTION" }
  ));
});

test("NESTA_PRODUCTION_ALLOW_RESUME does not authorize a populated production target", async () => {
  const client = {
    async query(sql, params) {
      const s = String(sql);
      if (s.includes("set_config")) return { rows: [] };
      if (s.includes("schema_migrations")) return { rows: [{ version: REQUIRED_SCHEMA_VERSION }] };
      if (s.includes("pg_class")) {
        const names = params?.[0] || ["restaurants", "employees", "orders", "order_items", "payments", "custom_roles"];
        return { rows: names.map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true })) };
      }
      if (s.includes("rest_1999")) return { rows: [{ n: 0 }] };
      return { rows: [{ n: 1 }] };
    },
  };
  await assert.rejects(
    () => enforceConnectedApplyTarget(
      client,
      { host: "switchback.proxy.rlwy.net", database: "railway", user: "migrator" },
      { ...confirmEnv, NESTA_PRODUCTION_ALLOW_RESUME: PRODUCTION_REQUIRED_TAG },
      { writesCommitted: true, resume: true },
    ),
    /WAVE1_COMPLETE attempt provenance/,
  );
});
