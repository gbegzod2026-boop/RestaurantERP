import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { fileURLToPath } from "url";
import { REQUIRED_SCHEMA_VERSION } from "../scripts/lib/migrationTargetGuard.mjs";
import {
  loadRepoMigrations,
  assertRepoMigrationContract,
  expectedContiguousVersions,
  predecessorOf,
  SCHEMA_APPLY_PREDECESSOR_VERSION,
} from "../scripts/lib/schemaMigrationCatalog.mjs";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

function fake(versions) {
  return versions.map((version) => ({
    version,
    name: `n${version}`,
    file: `${version}_n${version}.up.sql`,
    sql: "SELECT 1;",
    checksum: "abc",
  }));
}

test("exact 0001..0018 repository contract PASSes; predecessor is 0017", () => {
  const expected = expectedContiguousVersions("0018");
  assert.deepEqual(expected[0], "0001");
  assert.deepEqual(expected.at(-1), "0018");
  assert.equal(expected.length, 18);
  assert.doesNotThrow(() => assertRepoMigrationContract(fake(expected), "0018"));
  const loaded = loadRepoMigrations(MIGRATIONS_DIR);
  assert.equal(loaded.length, 18);
  assert.equal(loaded[0].version, "0001");
  assert.equal(loaded.at(-1).version, "0018");
  assert.equal(predecessorOf(REQUIRED_SCHEMA_VERSION), "0017");
  assert.equal(SCHEMA_APPLY_PREDECESSOR_VERSION, "0017");
});

test("duplicate version FAILs the catalog contract", () => {
  const versions = expectedContiguousVersions("0018");
  const list = fake(versions);
  list.push({ ...list[6], file: "0007_duplicate.up.sql" });
  assert.throws(() => assertRepoMigrationContract(list, "0018"), /duplicate migration version 0007/);
});

test("missing 0007 / gap FAILs the catalog contract", () => {
  const missing = expectedContiguousVersions("0018").filter((v) => v !== "0007");
  assert.throws(() => assertRepoMigrationContract(fake(missing), "0018"), /contiguous 0001\.\.0018/);
  const gap = expectedContiguousVersions("0018").filter((v) => v !== "0012");
  assert.throws(() => assertRepoMigrationContract(fake(gap), "0018"), /contiguous 0001\.\.0018/);
});

test("duplicate filename FAILs the catalog contract", () => {
  const list = fake(expectedContiguousVersions("0018"));
  list[7] = { ...list[7], version: "0008", file: list[6].file };
  assert.throws(() => assertRepoMigrationContract(list, "0018"), /duplicate migration filename/);
});

test("unexpected 0019 FAILs the current required contract", () => {
  const extra = [...expectedContiguousVersions("0018"), "0019"];
  assert.throws(
    () => assertRepoMigrationContract(fake(extra), "0018"),
    /unexpected future migration version 0019/,
  );
});
