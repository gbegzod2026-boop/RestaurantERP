import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertFirebaseDataPlaneAccess,
  classifyBackendDataPath,
  FirebaseDataPlaneAccessError,
} from "../../dataPlane.js";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIRECT_FIREBASE_ADAPTERS = new Set([
  "db.js",
  "systemDb.js",
  path.join("notifications", "dbMonitor.js"),
]);

async function runtimeFiles(dir = backendRoot) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(backendRoot, absolute);
    if (entry.isDirectory()) {
      if (relative === "node_modules" || relative === "scripts" || relative === path.join("db", "scripts") || relative === path.join("db", "tests")) continue;
      out.push(...await runtimeFiles(absolute));
    } else if (/\.(?:c?js|mjs|ts)$/.test(entry.name)) {
      out.push(relative);
    }
  }
  return out;
}

test("canonical classifier distinguishes tenant and approved Firebase infrastructure", () => {
  assert.equal(classifyBackendDataPath("restaurants/rest_a/orders").kind, "tenant");
  assert.equal(classifyBackendDataPath("credentials/rest_a/admin").kind, "tenant");
  assert.equal(classifyBackendDataPath(".info/connected").allowedInPostgres, true);
  assert.equal(classifyBackendDataPath("systemData/platform").allowedInPostgres, true);
  assert.equal(classifyBackendDataPath("systemData/notExplicitlyApproved").allowedInPostgres, false);
  assert.equal(classifyBackendDataPath("mysteryTenantTree/rest_a").allowedInPostgres, false);
  assert.equal(classifyBackendDataPath("restaurants", { purpose: "migration" }).allowedInPostgres, true);
});

test("PostgreSQL mode fails closed before Firebase can receive tenant or unknown paths", () => {
  const previous = process.env.DATA_BACKEND;
  process.env.DATA_BACKEND = "postgres";
  try {
    assert.throws(
      () => assertFirebaseDataPlaneAccess("restaurants/rest_a/orders"),
      (error) => error instanceof FirebaseDataPlaneAccessError
        && error.code === "FIREBASE_DATA_PLANE_FORBIDDEN"
        && error.dataPath === "restaurants/rest_a/orders"
    );
    assert.throws(() => assertFirebaseDataPlaneAccess("unknown/rest_a"), /forbidden/);
    assert.doesNotThrow(() => assertFirebaseDataPlaneAccess(".info/connected"));
    assert.doesNotThrow(() => assertFirebaseDataPlaneAccess("systemData/platform"));
    assert.doesNotThrow(() => assertFirebaseDataPlaneAccess("restaurants/rest_a", { purpose: "test" }));
  } finally {
    if (previous === undefined) delete process.env.DATA_BACKEND;
    else process.env.DATA_BACKEND = previous;
  }
});

test("all backend runtime Firebase RTDB SDK access stays behind canonical adapters", async () => {
  const offenders = [];
  for (const relative of await runtimeFiles()) {
    const source = await readFile(path.join(backendRoot, relative), "utf8");
    const directClient = /from\s+["']firebase\/database["']/.test(source);
    const directAdminDatabase = /\badmin\.database\s*\(/.test(source);
    if (directClient && !DIRECT_FIREBASE_ADAPTERS.has(relative)) offenders.push(`${relative}: firebase/database`);
    if (directAdminDatabase && relative !== "firebaseAdmin.js") offenders.push(`${relative}: admin.database()`);
  }
  assert.deepEqual(offenders, []);
});

test("Admin RTDB refs and wrapped refs both invoke the canonical firewall", async () => {
  const adminSource = await readFile(path.join(backendRoot, "firebaseAdmin.js"), "utf8");
  const wrapperSource = await readFile(path.join(backendRoot, "systemDb.js"), "utf8");
  assert.match(adminSource, /assertFirebaseDataPlaneAccess\(path,\s*\{\s*purpose\s*\}\)/);
  assert.ok(adminSource.indexOf("assertFirebaseDataPlaneAccess(path, { purpose })") < adminSource.indexOf("return target.ref(path)"));
  assert.match(wrapperSource, /postgresTenantPath\(path\)/);
  assert.match(wrapperSource, /pathRouter\.rtdbGet/);
  assert.match(wrapperSource, /assertFirebaseDataPlaneAccess\(path\)/);
});
