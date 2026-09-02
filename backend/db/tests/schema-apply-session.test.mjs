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
  classifySchemaApplyPath,
  SCHEMA_APPLY_REQUIRED_DB,
  SCHEMA_APPLY_MODE,
  schemaOnlyAppPasswordReport,
  SCHEMA_ONLY_NO_CREDENTIAL_ROTATION,
  PRODUCTION_SCHEMA_PROVISIONING_REQUIREMENTS,
  revalidateThenEnterWritable,
} from "../scripts/lib/schemaApplySession.mjs";
import { assertApplyTarget, assertMigrationTarget, REQUIRED_SCHEMA_VERSION } from "../scripts/lib/migrationTargetGuard.mjs";
import {
  loadRepoMigrations,
  expectedHistoryThrough,
  expectedPublicTablesThrough,
  predecessorVersion,
} from "../scripts/lib/schemaMigrationCatalog.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(here, "../migrations");
const repoMigrations = loadRepoMigrations(MIGRATIONS_DIR);
const predecessor = predecessorVersion(repoMigrations, REQUIRED_SCHEMA_VERSION);
const tables0017 = [...expectedPublicTablesThrough(repoMigrations, predecessor)].sort();
const tables0018 = [...expectedPublicTablesThrough(repoMigrations, REQUIRED_SCHEMA_VERSION)].sort();
const history0017 = expectedHistoryThrough(repoMigrations, predecessor);
const history0018 = expectedHistoryThrough(repoMigrations, REQUIRED_SCHEMA_VERSION);

const okSnap = { loopback: false, providerClass: "PUBLIC MANAGED", database: "railway" };
const baseLive = {
  currentDatabase: "railway",
  sslLive: "on",
  publicTables: [],
  restaurantsTableExists: false,
  restaurants: null,
  fixtureLike: 0,
  serverAddrClass: "*.*.*.*",
  schemaMigrationRows: [],
  latestMigration: null,
};

function liveAtPredecessor(extra = {}) {
  return {
    ...baseLive,
    publicTables: tables0017,
    restaurantsTableExists: true,
    restaurants: 0,
    fixtureLike: 0,
    schemaMigrationRows: history0017,
    latestMigration: { version: predecessor, name: history0017.at(-1).name },
    ...extra,
  };
}

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

test("fresh empty Railway schema is allowed; identity and fixture DBs still STOP", () => {
  assert.equal(SCHEMA_APPLY_REQUIRED_DB, "railway");
  assert.equal(predecessor, "0017");
  assert.equal(REQUIRED_SCHEMA_VERSION, "0018");
  const fresh = assertSchemaApplyInvariants({
    snap: okSnap,
    live: baseLive,
    repoMigrations,
  });
  assert.equal(fresh.mode, SCHEMA_APPLY_MODE.FRESH_PROVISION);
  assert.equal(fresh.allowWritable, true);
  assert.doesNotThrow(() => assertSchemaApplyInvariants({
    snap: okSnap,
    live: { ...baseLive, publicTables: ["schema_migrations"] },
    repoMigrations,
  }));
  assert.throws(() => assertSchemaApplyInvariants({
    snap: { ...okSnap, loopback: true, providerClass: "LOOPBACK" },
    live: baseLive,
    repoMigrations,
  }), /loopback/);
  assert.throws(() => assertSchemaApplyInvariants({
    snap: okSnap,
    live: { ...baseLive, currentDatabase: "postgres" },
    repoMigrations,
  }));
  assert.throws(() => assertSchemaApplyInvariants({
    snap: okSnap,
    live: { ...baseLive, currentDatabase: "nesta_migration_dryrun" },
    repoMigrations,
  }));
  assert.throws(() => assertSchemaApplyInvariants({
    snap: { ...okSnap, providerClass: "OTHER" },
    live: baseLive,
    repoMigrations,
  }));
});

test("canonical schema through 0017 + restaurants=0 allows 0018 upgrade", () => {
  assert.equal(tables0017.includes("restaurants"), true);
  assert.equal(tables0017.includes("production_migration_attempts"), false);
  assert.ok(tables0017.length === 79, `expected 79 0017 tables, got ${tables0017.length}`);
  const decision = assertSchemaApplyInvariants({
    snap: okSnap,
    live: liveAtPredecessor(),
    repoMigrations,
  });
  assert.equal(decision.mode, SCHEMA_APPLY_MODE.UPGRADE_FROM_PREDECESSOR);
  assert.equal(decision.allowWritable, true);
  assert.equal(decision.predecessor, "0017");
});

test("arbitrary existing public table STOPs", () => {
  assert.throws(() => assertSchemaApplyInvariants({
    snap: okSnap,
    live: { ...baseLive, publicTables: ["restaurants"] },
    repoMigrations,
  }), /public tables already present: restaurants/);
  assert.throws(() => assertSchemaApplyInvariants({
    snap: okSnap,
    live: liveAtPredecessor({ publicTables: [...tables0017, "not_a_nesta_table"] }),
    repoMigrations,
  }), /public tables already present: not_a_nesta_table/);
});

test("canonical 0017 but restaurants>0 STOPs", () => {
  assert.throws(() => assertSchemaApplyInvariants({
    snap: okSnap,
    live: liveAtPredecessor({ restaurants: 2 }),
    repoMigrations,
  }), /restaurants=2, required 0/);
});

test("canonical 0017 but fixtureLike>0 STOPs", () => {
  assert.throws(() => assertSchemaApplyInvariants({
    snap: okSnap,
    live: liveAtPredecessor({ fixtureLike: 1 }),
    repoMigrations,
  }), /rest_1999\*/);
});

test("migration history mismatch STOPs", () => {
  const rows = history0017.map((row, i) => (
    i === 0 ? { ...row, checksum: "deadbeef" } : row
  ));
  assert.throws(() => assertSchemaApplyInvariants({
    snap: okSnap,
    live: liveAtPredecessor({ schemaMigrationRows: rows }),
    repoMigrations,
  }), /checksum/);
  const renamed = history0017.map((row, i) => (
    i === history0017.length - 1 ? { ...row, name: "not_the_file_name" } : row
  ));
  assert.throws(() => assertSchemaApplyInvariants({
    snap: okSnap,
    live: liveAtPredecessor({ schemaMigrationRows: renamed }),
    repoMigrations,
  }), /name/);
});

test("unknown migration version STOPs", () => {
  assert.throws(() => assertSchemaApplyInvariants({
    snap: okSnap,
    live: liveAtPredecessor({
      schemaMigrationRows: [...history0017, { version: "0099", name: "evil", checksum: "abc" }],
      latestMigration: { version: "0099", name: "evil" },
    }),
    repoMigrations,
  }), /unknown\/out-of-band migration version: 0099/);
});

test("wrong predecessor STOPs", () => {
  const history0016 = expectedHistoryThrough(repoMigrations, "0016");
  const tables0016 = [...expectedPublicTablesThrough(repoMigrations, "0016")];
  assert.throws(() => assertSchemaApplyInvariants({
    snap: okSnap,
    live: {
      ...baseLive,
      publicTables: tables0016,
      restaurantsTableExists: true,
      restaurants: 0,
      schemaMigrationRows: history0016,
      latestMigration: { version: "0016", name: history0016.at(-1).name },
    },
    repoMigrations,
  }), /latest schema is 0016, required predecessor 0017/);
});

test("exact 0018 is safe idempotent/no-op and does not open writable apply", () => {
  assert.equal(tables0018.includes("production_migration_attempts"), true);
  assert.equal(tables0018.length, 80);
  const decision = assertSchemaApplyInvariants({
    snap: okSnap,
    live: {
      ...baseLive,
      publicTables: tables0018,
      restaurantsTableExists: true,
      restaurants: 0,
      fixtureLike: 0,
      schemaMigrationRows: history0018,
      latestMigration: { version: "0018", name: history0018.at(-1).name },
    },
    repoMigrations,
  });
  assert.equal(decision.mode, SCHEMA_APPLY_MODE.ALREADY_CURRENT);
  assert.equal(decision.allowWritable, false);
  const classified = classifySchemaApplyPath({
    live: {
      ...baseLive,
      publicTables: tables0018,
      restaurantsTableExists: true,
      restaurants: 0,
      schemaMigrationRows: history0018,
      latestMigration: { version: "0018", name: history0018.at(-1).name },
    },
    repoMigrations,
  });
  assert.equal(classified.ok, true);
  assert.equal(classified.allowWritable, false);
});

test("writable connection mismatch STOPs before any writable statement/DDL", async () => {
  const previousLive = liveAtPredecessor();
  const previousDecision = assertSchemaApplyInvariants({
    snap: okSnap,
    live: previousLive,
    repoMigrations,
  });
  assert.equal(previousDecision.mode, SCHEMA_APPLY_MODE.UPGRADE_FROM_PREDECESSOR);
  let writableEntered = false;
  const enterWritableImpl = async () => {
    writableEntered = true;
    return { default_transaction_read_only: "off" };
  };
  await assert.rejects(
    () => revalidateThenEnterWritable({
      client: { marker: "writable-conn" },
      snap: okSnap,
      previousLive,
      previousDecision,
      repoMigrations,
      identifyLiveImpl: async () => liveAtPredecessor({ restaurants: 3 }),
      enterWritableImpl,
    }),
    /restaurants=3/,
  );
  assert.equal(writableEntered, false);
  await assert.rejects(
    () => revalidateThenEnterWritable({
      client: { marker: "writable-conn" },
      snap: okSnap,
      previousLive,
      previousDecision,
      repoMigrations,
      identifyLiveImpl: async () => liveAtPredecessor({
        schemaMigrationRows: history0017.map((row, i) => (
          i === 0 ? { ...row, checksum: "changed" } : row
        )),
      }),
      enterWritableImpl,
    }),
    /checksum|does not match/,
  );
  assert.equal(writableEntered, false);
  await assert.rejects(
    () => revalidateThenEnterWritable({
      client: { marker: "writable-conn" },
      snap: okSnap,
      previousLive: { ...previousLive, systemIdentifier: "111" },
      previousDecision,
      repoMigrations,
      identifyLiveImpl: async () => liveAtPredecessor({ systemIdentifier: "222" }),
      enterWritableImpl,
    }),
    /does not match the read-only classification/,
  );
  assert.equal(writableEntered, false);
  const order = [];
  const ok = await revalidateThenEnterWritable({
    client: { marker: "writable-conn" },
    snap: okSnap,
    previousLive,
    previousDecision,
    repoMigrations,
    identifyLiveImpl: async () => {
      order.push("identify");
      return previousLive;
    },
    enterWritableImpl: async () => {
      order.push("writable");
      writableEntered = true;
      return { default_transaction_read_only: "off" };
    },
  });
  assert.deepEqual(order, ["identify", "writable"]);
  assert.equal(writableEntered, true);
  assert.equal(ok.default_transaction_read_only, "off");
});

test("schema-only apply never rotates nesta_app even when POSTGRES_APP_PASSWORD is set", () => {
  const report = schemaOnlyAppPasswordReport({ POSTGRES_APP_PASSWORD: "would-have-rotated" });
  assert.equal(report.attempted, false);
  assert.equal(report.rotated, false);
  assert.equal(report.credentialMutations, 0);
  assert.equal(report.reason, SCHEMA_ONLY_NO_CREDENTIAL_ROTATION);

  const step2d3 = readFileSync(
    path.join(here, "../scripts/step2d3-railway-schema.mjs"),
    "utf8",
  );
  assert.doesNotMatch(step2d3, /ALTER\s+ROLE/i);
  assert.doesNotMatch(step2d3, /maybeSetAppPassword/);
  assert.match(step2d3, /schemaOnlyAppPasswordReport/);
  assert.match(step2d3, /revalidateThenEnterWritable/);
  const invAt = step2d3.indexOf("assertSchemaApplyInvariants");
  const revalidateAt = step2d3.indexOf("revalidateThenEnterWritable");
  const writableAt = step2d3.indexOf("enterWritableImpl: enterSchemaApplyWritable");
  assert.ok(invAt > 0 && revalidateAt > invAt, "writable revalidation follows read-only invariants");
  assert.ok(writableAt > revalidateAt, "writable session setup is only passed into revalidation");

  const sql0018 = readFileSync(
    path.join(here, "../migrations/0018_production_migration_attempts.up.sql"),
    "utf8",
  );
  assert.doesNotMatch(sql0018, /ALTER\s+ROLE/i);
  assert.match(sql0018, /REVOKE ALL ON TABLE production_migration_attempts FROM nesta_app/);
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

test("precheck wording distinguishes initial provision from in-place 0017 upgrade", () => {
  const precheck = readFileSync(path.join(here, "../scripts/step2d-pg-precheck.mjs"), "utf8");
  assert.match(precheck, /PRODUCTION_SCHEMA_PROVISIONING_REQUIREMENTS/);
  const joined = PRODUCTION_SCHEMA_PROVISIONING_REQUIREMENTS.join("\n");
  assert.match(joined, /initial provisioning/);
  assert.match(joined, /in-place schema-only upgrade/);
  assert.match(joined, /0017/);
  assert.match(joined, /0018/);
  assert.doesNotMatch(joined, /Apply schema migrations through the required production schema version on the empty database before data load/);
});
