// READ-ONLY freeze-time Firebase count collection.
// Required source reads never collapse errors into empty/zero evidence.
import { writeFileSync as defaultWriteFileSync, mkdirSync as defaultMkdirSync } from "fs";
import path from "path";
import { freezeSnapshotComplete, EXPECTED_FIREBASE_PROJECT } from "./freezeSnapshot.mjs";
import {
  canonicalFreezeCounts,
  buildFreezeEvidence,
  FREEZE_COUNT_KEYS,
} from "./cutoverWindow.mjs";

export const FREEZE_READ_FAILED = "FREEZE_READ_FAILED";

export const REQUIRED_FREEZE_TENANT_COLS = Object.freeze([
  "users",
  "orders",
  "menu",
  "tables",
  "customers",
  "customRoles",
]);

export class FreezeReadFailed extends Error {
  constructor(dimension) {
    super(FREEZE_READ_FAILED);
    this.name = "FreezeReadFailed";
    this.code = FREEZE_READ_FAILED;
    this.dimension = dimension;
  }
}

function failRead(dimension) {
  throw new FreezeReadFailed(dimension);
}

async function requiredShallow(shallowKeys, p, dimension) {
  let keys;
  try {
    keys = await shallowKeys(p);
  } catch (err) {
    if (err instanceof FreezeReadFailed) throw err;
    failRead(dimension);
  }
  if (!Array.isArray(keys)) failRead(dimension);
  return keys;
}

async function requiredValue(getValue, p, dimension) {
  try {
    return await getValue(p);
  } catch (err) {
    if (err instanceof FreezeReadFailed) throw err;
    failRead(dimension);
  }
}

function tallyOrderTree(orders, orderKeys) {
  if (orderKeys.length === 0) {
    if (orders == null) return { orderItems: 0, payments: 0 };
    if (typeof orders !== "object" || Array.isArray(orders)) failRead("orders.deep");
    if (Object.keys(orders).length !== 0) failRead("orders.deep");
    return { orderItems: 0, payments: 0 };
  }
  if (orders == null || typeof orders !== "object" || Array.isArray(orders)) failRead("orders.deep");
  let orderItems = 0;
  let payments = 0;
  for (const k of orderKeys) {
    if (!Object.prototype.hasOwnProperty.call(orders, k)) failRead("orders.deep");
    const rec = orders[k];
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) failRead("orders.deep");
    if (rec.items == null) {
      // successful order object with no items is count 0
    } else if (typeof rec.items !== "object" || Array.isArray(rec.items)) {
      failRead("orderItems");
    } else {
      orderItems += Object.keys(rec.items).length;
    }
    if (rec.payment == null) {
      // successful order object with no payment is count 0
    } else if (typeof rec.payment !== "object" || Array.isArray(rec.payment)) {
      failRead("payments");
    } else {
      payments++;
    }
  }
  return { orderItems, payments };
}

/**
 * Collect the exact 12 freeze dimensions from READ-ONLY Firebase accessors.
 * Successful empty children count as 0. Thrown/failed reads abort.
 */
export async function collectFreezeSourceCounts({ shallowKeys, getValue } = {}) {
  if (typeof shallowKeys !== "function" || typeof getValue !== "function") {
    failRead("readers");
  }
  const restIds = await requiredShallow(shallowKeys, "restaurants", "restaurants");
  const credTrees = await requiredShallow(shallowKeys, "credentials", "credentialTrees");
  const systemPromo = await requiredShallow(shallowKeys, "systemData/promoCodes", "platformPromoCodes");

  const counts = {
    restaurants: restIds.length,
    users: 0,
    employees: 0,
    orders: 0,
    orderItems: 0,
    payments: 0,
    menu: 0,
    tables: 0,
    customers: 0,
    credentialTrees: credTrees.length,
    customRoles: 0,
    platformPromoCodes: systemPromo.length,
  };

  for (const rid of restIds) {
    const users = await requiredShallow(shallowKeys, `restaurants/${rid}/users`, "users");
    const orderKeys = await requiredShallow(shallowKeys, `restaurants/${rid}/orders`, "orders");
    const menu = await requiredShallow(shallowKeys, `restaurants/${rid}/menu`, "menu");
    const tables = await requiredShallow(shallowKeys, `restaurants/${rid}/tables`, "tables");
    const customers = await requiredShallow(shallowKeys, `restaurants/${rid}/customers`, "customers");
    const customRoles = await requiredShallow(shallowKeys, `restaurants/${rid}/customRoles`, "customRoles");
    const orders = await requiredValue(getValue, `restaurants/${rid}/orders`, "orders.deep");
    const deep = tallyOrderTree(orders, orderKeys);

    counts.users += users.length;
    counts.orders += orderKeys.length;
    counts.menu += menu.length;
    counts.tables += tables.length;
    counts.customers += customers.length;
    counts.customRoles += customRoles.length;
    counts.orderItems += deep.orderItems;
    counts.payments += deep.payments;
  }
  counts.employees = counts.users;
  return canonicalFreezeCounts(counts);
}

function failClosedResult(dimension = null) {
  return {
    ok: false,
    freezeFirebaseSnapshot: "FAIL",
    code: FREEZE_READ_FAILED,
    dimension,
    doc: null,
    written: false,
    file: null,
    counts: null,
  };
}

/**
 * Collect first, then write FREEZE.json only if the closed 12-count snapshot is complete.
 * Failures write nothing consumable.
 */
export async function produceFreezeSnapshot({
  shallowKeys,
  getValue,
  outDir,
  generatedAt,
  candidateCommit,
  cutoverWindowIdentity,
  firebaseProject = EXPECTED_FIREBASE_PROJECT,
  writeFileSyncImpl = defaultWriteFileSync,
  mkdirSyncImpl = defaultMkdirSync,
} = {}) {
  let counts;
  try {
    counts = await collectFreezeSourceCounts({ shallowKeys, getValue });
  } catch (err) {
    const dimension = err instanceof FreezeReadFailed ? err.dimension : null;
    return failClosedResult(dimension);
  }

  let closedCounts;
  try {
    closedCounts = canonicalFreezeCounts(counts);
  } catch {
    return failClosedResult("counts");
  }

  const doc = buildFreezeEvidence({
    generatedAt,
    firebaseProject,
    counts: closedCounts,
    candidateCommit,
    cutoverWindowIdentity,
  });
  if (!freezeSnapshotComplete(doc) || !FREEZE_COUNT_KEYS.every((k) => Object.prototype.hasOwnProperty.call(doc.counts, k))) {
    return failClosedResult("counts");
  }
  if (!outDir) return failClosedResult("artifact");
  const file = path.join(outDir, "FREEZE.json");
  mkdirSyncImpl(outDir, { recursive: true });
  writeFileSyncImpl(file, JSON.stringify(doc, null, 2));
  return {
    ok: true,
    freezeFirebaseSnapshot: "PASS",
    code: null,
    dimension: null,
    doc,
    written: true,
    file,
    counts: doc.counts,
  };
}
