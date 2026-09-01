import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync, rmSync, readFileSync } from "fs";
import os from "os";
import path from "path";
import {
  collectFreezeSourceCounts,
  produceFreezeSnapshot,
  FREEZE_READ_FAILED,
  FreezeReadFailed,
} from "../scripts/lib/freezeCollector.mjs";
import { canonicalFreezeCounts, FREEZE_COUNT_KEYS } from "../scripts/lib/cutoverWindow.mjs";
import { freezeSnapshotComplete } from "../scripts/lib/freezeSnapshot.mjs";

const THROW = Symbol("throw");
const HEAD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const IDENTITY = "ab".repeat(32);
const GENERATED_AT = "2026-08-31T10:15:00.000Z";

function lookup(tree, p) {
  const parts = String(p).split("/").filter(Boolean);
  let cur = tree;
  for (const part of parts) {
    if (cur === THROW) return THROW;
    if (cur == null || typeof cur !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return null;
    cur = cur[part];
  }
  return cur;
}

function readersFromTree(tree) {
  const calls = [];
  async function shallowKeys(p) {
    calls.push({ op: "shallowKeys", path: p });
    const val = lookup(tree, p);
    if (val === THROW) throw new Error("simulated firebase read failure");
    if (val === null || typeof val !== "object") return [];
    return Object.keys(val);
  }
  async function getValue(p) {
    calls.push({ op: "getValue", path: p });
    const val = lookup(tree, p);
    if (val === THROW) throw new Error("simulated firebase read failure");
    return val;
  }
  return { shallowKeys, getValue, calls };
}

function emptyTree() {
  return {
    restaurants: null,
    credentials: null,
    systemData: { promoCodes: null },
  };
}

function completeTree() {
  return {
    restaurants: {
      r1: {
        users: { u1: true },
        orders: {
          o1: {
            items: { i1: { name: "tea" }, i2: { name: "bread" } },
            payment: { amount: 10 },
          },
        },
        menu: { m1: true, m2: true },
        tables: { t1: true },
        customers: { c1: true },
        customRoles: { cr1: true },
      },
    },
    credentials: { tree1: true, tree2: true },
    systemData: { promoCodes: { p1: true } },
  };
}

async function produce(tree, outDir) {
  const { shallowKeys, getValue, calls } = readersFromTree(tree);
  const result = await produceFreezeSnapshot({
    shallowKeys,
    getValue,
    outDir,
    generatedAt: GENERATED_AT,
    candidateCommit: HEAD_SHA,
    cutoverWindowIdentity: IDENTITY,
  });
  return { result, calls, freezeFile: path.join(outDir, "FREEZE.json") };
}

test("canonicalFreezeCounts requires all 12 keys and does not default missing to zero", () => {
  const twelve = {
    restaurants: 0,
    users: 0,
    employees: 0,
    orders: 0,
    orderItems: 0,
    payments: 0,
    menu: 0,
    tables: 0,
    customers: 0,
    credentialTrees: 0,
    customRoles: 0,
    platformPromoCodes: 0,
  };
  assert.deepEqual(canonicalFreezeCounts(twelve), twelve);
  assert.throws(() => canonicalFreezeCounts({ restaurants: 1 }));
  const missingEmployees = { ...twelve };
  delete missingEmployees.employees;
  assert.throws(() => canonicalFreezeCounts(missingEmployees));
  assert.throws(() => canonicalFreezeCounts({ ...twelve, unexpected: 1 }));
  assert.throws(() => canonicalFreezeCounts(null));
  assert.throws(() => canonicalFreezeCounts({ ...twelve, employees: "0" }));
  assert.throws(() => canonicalFreezeCounts({ ...twelve, restaurants: -1 }));
});

test("successful empty Firebase reads emit a complete 12-count zero snapshot", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "nesta-freeze-"));
  try {
    const { result, freezeFile, calls } = await produce(emptyTree(), tmp);
    assert.equal(result.ok, true);
    assert.equal(result.freezeFirebaseSnapshot, "PASS");
    assert.equal(result.written, true);
    assert.equal(existsSync(freezeFile), true);
    assert.deepEqual(result.counts, canonicalFreezeCounts({
      restaurants: 0,
      users: 0,
      employees: 0,
      orders: 0,
      orderItems: 0,
      payments: 0,
      menu: 0,
      tables: 0,
      customers: 0,
      credentialTrees: 0,
      customRoles: 0,
      platformPromoCodes: 0,
    }));
    assert.equal(freezeSnapshotComplete(result.doc), true);
    assert.equal(Object.keys(result.counts).length, 12);
    assert.equal(calls.some((c) => c.op !== "shallowKeys" && c.op !== "getValue"), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("all required reads succeeding emit the complete 12-count snapshot", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "nesta-freeze-"));
  try {
    const { result, freezeFile } = await produce(completeTree(), tmp);
    assert.equal(result.ok, true);
    assert.equal(result.freezeFirebaseSnapshot, "PASS");
    assert.equal(existsSync(freezeFile), true);
    assert.deepEqual(result.counts, {
      restaurants: 1,
      users: 1,
      employees: 1,
      orders: 1,
      orderItems: 2,
      payments: 1,
      menu: 2,
      tables: 1,
      customers: 1,
      credentialTrees: 2,
      customRoles: 1,
      platformPromoCodes: 1,
    });
    assert.deepEqual([...FREEZE_COUNT_KEYS], Object.keys(result.counts));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

async function assertReadFailure(tree, dimension) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "nesta-freeze-"));
  try {
    const { result, freezeFile } = await produce(tree, tmp);
    assert.equal(result.ok, false);
    assert.equal(result.freezeFirebaseSnapshot, "FAIL");
    assert.equal(result.code, FREEZE_READ_FAILED);
    assert.equal(result.written, false);
    assert.equal(result.doc, null);
    assert.equal(result.counts, null);
    assert.equal(existsSync(freezeFile), false);
    assert.equal(readdirSync(tmp).includes("FREEZE.json"), false);
    if (dimension) assert.equal(result.dimension, dimension);
    await assert.rejects(
      () => collectFreezeSourceCounts(readersFromTree(tree)),
      (err) => err instanceof FreezeReadFailed && err.code === FREEZE_READ_FAILED,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test("restaurants root read throw fails closed with no FREEZE.json", async () => {
  await assertReadFailure({ restaurants: THROW, credentials: null, systemData: { promoCodes: null } }, "restaurants");
});

test("users read throw for one tenant fails the entire snapshot", async () => {
  const tree = completeTree();
  tree.restaurants.r1.users = THROW;
  await assertReadFailure(tree, "users");
});

test("orders shallow read throw fails closed", async () => {
  const tree = completeTree();
  tree.restaurants.r1.orders = THROW;
  await assertReadFailure(tree, "orders");
});

test("deep order read throw fails closed and does not undercount", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "nesta-freeze-"));
  try {
    const tree = completeTree();
    const { shallowKeys, getValue } = readersFromTree(tree);
    async function failingDeep(p) {
      if (p === "restaurants/r1/orders") throw new Error("deep order read failed");
      return getValue(p);
    }
    const result = await produceFreezeSnapshot({
      shallowKeys,
      getValue: failingDeep,
      outDir: tmp,
      generatedAt: GENERATED_AT,
      candidateCommit: HEAD_SHA,
      cutoverWindowIdentity: IDENTITY,
    });
    assert.equal(result.ok, false);
    assert.equal(result.freezeFirebaseSnapshot, "FAIL");
    assert.equal(result.code, FREEZE_READ_FAILED);
    assert.equal(result.dimension, "orders.deep");
    assert.equal(result.written, false);
    assert.equal(existsSync(path.join(tmp, "FREEZE.json")), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("menu read throw fails closed", async () => {
  const tree = completeTree();
  tree.restaurants.r1.menu = THROW;
  await assertReadFailure(tree, "menu");
});

test("tables read throw fails closed", async () => {
  const tree = completeTree();
  tree.restaurants.r1.tables = THROW;
  await assertReadFailure(tree, "tables");
});

test("customers read throw fails closed", async () => {
  const tree = completeTree();
  tree.restaurants.r1.customers = THROW;
  await assertReadFailure(tree, "customers");
});

test("customRoles read throw fails closed", async () => {
  const tree = completeTree();
  tree.restaurants.r1.customRoles = THROW;
  await assertReadFailure(tree, "customRoles");
});

test("credentialTrees read throw fails closed", async () => {
  const tree = completeTree();
  tree.credentials = THROW;
  await assertReadFailure(tree, "credentialTrees");
});

test("platformPromoCodes read throw fails closed", async () => {
  const tree = completeTree();
  tree.systemData.promoCodes = THROW;
  await assertReadFailure(tree, "platformPromoCodes");
});

test("second tenant read failure aborts after a successful first tenant", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "nesta-freeze-"));
  try {
    const tree = completeTree();
    tree.restaurants.r2 = {
      users: THROW,
      orders: {},
      menu: {},
      tables: {},
      customers: {},
      customRoles: {},
    };
    const { result, freezeFile } = await produce(tree, tmp);
    assert.equal(result.ok, false);
    assert.equal(result.freezeFirebaseSnapshot, "FAIL");
    assert.equal(result.code, FREEZE_READ_FAILED);
    assert.equal(result.dimension, "users");
    assert.equal(result.written, false);
    assert.equal(result.counts, null);
    assert.equal(existsSync(freezeFile), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("counted order with a null/non-object deep record fails closed instead of skipping", async () => {
  const tree = completeTree();
  tree.restaurants.r1.orders.o1 = null;
  await assertReadFailure(tree, "orders.deep");
});

test("deep payload missing a counted order id fails closed", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "nesta-freeze-"));
  try {
    const tree = completeTree();
    const { shallowKeys, getValue } = readersFromTree(tree);
    async function incompleteDeep(p) {
      if (p === "restaurants/r1/orders") return {};
      return getValue(p);
    }
    const result = await produceFreezeSnapshot({
      shallowKeys,
      getValue: incompleteDeep,
      outDir: tmp,
      generatedAt: GENERATED_AT,
      candidateCommit: HEAD_SHA,
      cutoverWindowIdentity: IDENTITY,
    });
    assert.equal(result.ok, false);
    assert.equal(result.freezeFirebaseSnapshot, "FAIL");
    assert.equal(result.code, FREEZE_READ_FAILED);
    assert.equal(result.dimension, "orders.deep");
    assert.equal(result.written, false);
    assert.equal(existsSync(path.join(tmp, "FREEZE.json")), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("freeze producer source never collapses required reads into empty arrays or null", () => {
  const collector = readFileSync(new URL("../scripts/lib/freezeCollector.mjs", import.meta.url), "utf8");
  const cli = readFileSync(new URL("../scripts/step2d5-freeze-snapshot.mjs", import.meta.url), "utf8");
  for (const src of [collector, cli]) {
    assert.equal(src.includes(".catch(() => [])"), false);
    assert.equal(src.includes(".catch(() => null)"), false);
    assert.equal(src.includes(".catch(() => 0)"), false);
    assert.equal(src.includes(".catch(() => {})"), false);
  }
});
