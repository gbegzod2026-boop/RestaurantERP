import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  isReadOnlyAction,
  isSchemaApplyAction,
  READ_ONLY_BEGIN_SQL,
  READ_ONLY_LOCAL_SQL,
  APPLY_WRITABLE_SQL,
  assertSchemaApplyInvariants,
  SCHEMA_APPLY_REQUIRED_DB,
  schemaOnlyAppPasswordReport,
  SCHEMA_ONLY_NO_CREDENTIAL_ROTATION,
} from "../scripts/lib/schemaApplySession.mjs";
import { assertApplyTarget, assertMigrationTarget } from "../scripts/lib/migrationTargetGuard.mjs";

test("tls-probe and identify are read-only actions; apply is not", () => {
  assert.equal(isReadOnlyAction("tls-probe"), true);
  assert.equal(isReadOnlyAction("identify"), true);
  assert.equal(isReadOnlyAction("apply"), false);
  assert.equal(isSchemaApplyAction("apply"), true);
  assert.equal(isSchemaApplyAction("identify"), false);
  assert.equal(READ_ONLY_BEGIN_SQL, "BEGIN READ ONLY");
  assert.match(READ_ONLY_LOCAL_SQL, /SET LOCAL default_transaction_read_only = on/);
  assert.ok(APPLY_WRITABLE_SQL.includes("SET default_transaction_read_only = off"));
  assert.equal(APPLY_WRITABLE_SQL.some((s) => /READ WRITE/.test(s)), true);
});

test("apply remains schema-only: invariants refuse tenant rows and fixture DBs", () => {
  const okSnap = { loopback: false, providerClass: "PUBLIC MANAGED", database: "railway" };
  const okLive = {
    currentDatabase: "railway",
    sslLive: "on",
    publicTables: [],
    restaurantsTableExists: false,
    restaurants: null,
    fixtureLike: 0,
    serverAddrClass: "*.*.*.*",
  };
  assert.equal(SCHEMA_APPLY_REQUIRED_DB, "railway");
  assert.doesNotThrow(() => assertSchemaApplyInvariants({ snap: okSnap, live: okLive }));
  assert.doesNotThrow(() => assertSchemaApplyInvariants({
    snap: okSnap,
    live: { ...okLive, publicTables: ["schema_migrations"] },
  }));
  assert.throws(() => assertSchemaApplyInvariants({
    snap: { ...okSnap, loopback: true, providerClass: "LOOPBACK" },
    live: okLive,
  }));
  assert.throws(() => assertSchemaApplyInvariants({
    snap: okSnap,
    live: { ...okLive, currentDatabase: "postgres" },
  }));
  assert.throws(() => assertSchemaApplyInvariants({
    snap: okSnap,
    live: { ...okLive, currentDatabase: "nesta_migration_dryrun" },
  }));
  assert.throws(() => assertSchemaApplyInvariants({
    snap: okSnap,
    live: { ...okLive, restaurantsTableExists: true, restaurants: 2 },
  }));
  assert.throws(() => assertSchemaApplyInvariants({
    snap: okSnap,
    live: { ...okLive, publicTables: ["restaurants"] },
  }));
  assert.throws(() => assertSchemaApplyInvariants({
    snap: { ...okSnap, providerClass: "OTHER" },
    live: okLive,
  }));
});

test("production target guard is still enforced (no easy bypass)", () => {
  assert.throws(() => assertMigrationTarget({ host: "altaria.proxy.rlwy.net", database: "railway", user: "u" }));
  assert.throws(() => assertApplyTarget(
    { host: "altaria.proxy.rlwy.net", database: "railway", user: "u" },
    {}
  ));
  assert.throws(() => assertApplyTarget(
    { host: "localhost", database: "nesta_migration_dryrun", user: "u" },
    { NESTA_MIGRATE_TARGET: "production", NESTA_PRODUCTION_MIGRATE_CONFIRM: "yes" }
  ));
});

test("schema-only apply never rotates nesta_app even when POSTGRES_APP_PASSWORD is set", () => {
  const report = schemaOnlyAppPasswordReport({ POSTGRES_APP_PASSWORD: "would-have-rotated" });
  assert.equal(report.attempted, false);
  assert.equal(report.rotated, false);
  assert.equal(report.credentialMutations, 0);
  assert.equal(report.reason, SCHEMA_ONLY_NO_CREDENTIAL_ROTATION);

  const step2d3 = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../scripts/step2d3-railway-schema.mjs"),
    "utf8",
  );
  assert.doesNotMatch(step2d3, /ALTER\s+ROLE/i);
  assert.doesNotMatch(step2d3, /maybeSetAppPassword/);
  assert.match(step2d3, /schemaOnlyAppPasswordReport/);

  const sql0018 = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../migrations/0018_production_migration_attempts.up.sql"),
    "utf8",
  );
  assert.doesNotMatch(sql0018, /ALTER\s+ROLE/i);
});

