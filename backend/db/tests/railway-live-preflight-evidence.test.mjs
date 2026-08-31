import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import os from "os";
import path from "path";
import {
  evaluateRailwayLivePreflightEvidence,
  sanitizeRailwayLivePreflightEvidence,
  writeRailwayLivePreflightEvidence,
  loadLatestRailwayLivePreflightEvidence,
  REQUIRED_PREFLIGHT_RLS_TABLES,
} from "../scripts/lib/railwayLivePreflightEvidence.mjs";
import { evaluateStep2dFinalGates, EXPECTED_PAUSE_CONFIRM } from "../scripts/lib/step2dFinalGate.mjs";

function rlsRows() {
  return REQUIRED_PREFLIGHT_RLS_TABLES.map((table) => ({ table, rls: true, force_rls: true }));
}

function uniqueRows() {
  return [
    { table: "restaurants", cols: ["legacy_rtdb_id"], ok: true },
    { table: "employees", cols: ["restaurant_id", "legacy_rtdb_id"], ok: true },
    { table: "orders", cols: ["restaurant_id", "legacy_rtdb_id"], ok: true },
    { table: "custom_roles", cols: ["restaurant_id", "legacy_rtdb_id"], ok: true },
  ];
}

function validGo(overrides = {}) {
  return {
    generatedAt: "2026-08-31T10:00:00.000Z",
    mode: "READ-ONLY",
    readOnly: true,
    verdict: "GO",
    hostClass: "*.proxy.rlwy.net",
    database: "railway",
    sslLive: "on",
    pgcrypto: true,
    latestMigration: { version: "0017" },
    restaurants: 0,
    fixtureLike: 0,
    rls: rlsRows(),
    requiredUniques: uniqueRows(),
    failures: [],
    ...overrides,
  };
}

const now = Date.parse("2026-08-31T10:30:00.000Z");

test("no evidence is NOT RUN and blocks approval", () => {
  const ev = evaluateRailwayLivePreflightEvidence(null, { now });
  assert.equal(ev.railwayLivePreflight, "NOT RUN");
  const gated = evaluateStep2dFinalGates({
    env: {
      NESTA_PAYMENT_CUTOVER_MODE: "OPERATOR_PAUSED",
      NESTA_PAYMENT_PAUSE_CONFIRM: EXPECTED_PAUSE_CONFIRM,
      NESTA_MAINTENANCE_MODE: "1",
    },
    backups: { firebase: 1, pg: 1, appConfig: 1 },
    git: {
      head: "cccccccccccccccccccccccccccccccccccccccc",
      tag: "cccccccccccccccccccccccccccccccccccccccc",
      expectedCommit: "cccccccccccccccccccccccccccccccccccccccc",
      dirty: false,
    },
    freezeSnapshotVerified: true,
    productionWriteStopVerified: true,
    railwayLivePreflight: ev.railwayLivePreflight,
  });
  assert.equal(gated.safeToRequestHumanApproval, false);
  assert.equal(gated.safeToMigrateProductionData, false);
  assert.equal(gated.approvalBlockers.includes("railwayPgSchema"), true);
});

test("DATABASE_PUBLIC_URL alone is never PASS", () => {
  const ev = evaluateRailwayLivePreflightEvidence(null, {
    now,
    env: { DATABASE_PUBLIC_URL: "postgres://u:p@altaria.proxy.rlwy.net:1/railway" },
  });
  assert.equal(ev.railwayLivePreflight, "NOT RUN");
  assert.match(ev.reason, /DATABASE_PUBLIC_URL/);
  assert.notEqual(ev.railwayLivePreflight, "GO");
  assert.notEqual(ev.railwayLivePreflight, "PASS");
});

test("failed NO-GO evidence is FAIL and blocks approval", () => {
  const ev = evaluateRailwayLivePreflightEvidence(validGo({ verdict: "NO-GO", restaurants: 3 }), { now });
  assert.equal(ev.railwayLivePreflight, "FAIL");
  const gated = evaluateStep2dFinalGates({
    backups: { firebase: 1, pg: 1, appConfig: 1 },
    railwayLivePreflight: ev.railwayLivePreflight,
  });
  assert.equal(gated.approvalBlockers.includes("railwayPgSchema"), true);
  assert.equal(gated.preflightBlockers.includes("railwayPgSchema"), true);
  assert.equal(gated.safeToMigrateProductionData, false);
});

test("malformed evidence is FAIL", () => {
  assert.equal(evaluateRailwayLivePreflightEvidence([], { now }).railwayLivePreflight, "FAIL");
  assert.equal(evaluateRailwayLivePreflightEvidence({ __malformed: true }, { now }).railwayLivePreflight, "FAIL");
  assert.equal(evaluateRailwayLivePreflightEvidence(validGo({ generatedAt: "not-a-date" }), { now }).railwayLivePreflight, "FAIL");
  assert.equal(evaluateRailwayLivePreflightEvidence(validGo({ mode: "READ-WRITE" }), { now }).railwayLivePreflight, "FAIL");
  assert.equal(evaluateRailwayLivePreflightEvidence(validGo({ latestMigration: { version: "0016" } }), { now }).railwayLivePreflight, "FAIL");
  assert.equal(evaluateRailwayLivePreflightEvidence(validGo({ sslLive: "off" }), { now }).railwayLivePreflight, "FAIL");
});

test("stale evidence is NOT VERIFIED and blocks approval", () => {
  const ev = evaluateRailwayLivePreflightEvidence(validGo({
    generatedAt: "2026-08-31T00:00:00.000Z",
  }), { now: Date.parse("2026-08-31T10:30:00.000Z") });
  assert.equal(ev.railwayLivePreflight, "NOT VERIFIED");
  const gated = evaluateStep2dFinalGates({
    backups: { firebase: 1, pg: 1, appConfig: 1 },
    railwayLivePreflight: ev.railwayLivePreflight,
  });
  assert.equal(gated.approvalBlockers.includes("railwayPgSchema"), true);
  assert.equal(gated.safeToMigrateProductionData, false);
});

test("fresh valid GO evidence is railwayLivePreflight GO/PASS", () => {
  const ev = evaluateRailwayLivePreflightEvidence(validGo(), { now });
  assert.equal(ev.railwayLivePreflight, "GO");
  const gated = evaluateStep2dFinalGates({
    env: {
      NESTA_PAYMENT_CUTOVER_MODE: "OPERATOR_PAUSED",
      NESTA_PAYMENT_PAUSE_CONFIRM: EXPECTED_PAUSE_CONFIRM,
      NESTA_MAINTENANCE_MODE: "1",
    },
    backups: { firebase: 1, pg: 1, appConfig: 1 },
    git: {
      head: "cccccccccccccccccccccccccccccccccccccccc",
      tag: "cccccccccccccccccccccccccccccccccccccccc",
      expectedCommit: "cccccccccccccccccccccccccccccccccccccccc",
      dirty: false,
    },
    freezeSnapshotVerified: true,
    productionWriteStopVerified: true,
    railwayLivePreflight: ev.railwayLivePreflight,
  });
  assert.equal(gated.cutoverWindowArmed, true);
  assert.equal(gated.safeToRequestHumanApproval, true);
  assert.equal(gated.safeToMigrateProductionData, false);
  assert.equal(gated.gates.find((g) => g.name === "railwayPgSchema").result, "PASS");
});

test("sanitize strips connection secrets from failures", () => {
  const doc = sanitizeRailwayLivePreflightEvidence({
    verdict: "NO-GO",
    mode: "READ-ONLY",
    failures: ["connect postgres://u:supersecret@altaria.proxy.rlwy.net:1/railway PGPASSWORD=supersecret"],
    latestMigration: { version: "0017", name: "wave" },
    rls: rlsRows(),
    requiredUniques: uniqueRows().map((u) => ({ ...u, error: "postgres://u:supersecret@h/db" })),
  });
  const blob = JSON.stringify(doc);
  assert.equal(blob.includes("supersecret"), false);
  assert.equal(/postgres:\/\/[^:]+:[^@]+@/.test(blob), false);
  assert.equal(doc.latestMigration.version, "0017");
  assert.equal(doc.requiredUniques[0].error, undefined);
});

test("write/load roundtrip stays gitignored-class and fail-closed on secrets", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "nesta-preflight-"));
  try {
    writeRailwayLivePreflightEvidence(tmp, {
      verdict: "GO",
      mode: "READ-ONLY",
      hostClass: "*.proxy.rlwy.net",
      database: "railway",
      sslLive: "on",
      latestMigration: { version: "0017" },
      restaurants: 0,
      fixtureLike: 0,
      rls: rlsRows(),
      requiredUniques: uniqueRows(),
      failures: [],
    }, { generatedAt: "2026-08-31T10:00:00.000Z" });
    const loaded = loadLatestRailwayLivePreflightEvidence(tmp);
    const ev = evaluateRailwayLivePreflightEvidence(loaded, { now });
    assert.equal(ev.railwayLivePreflight, "GO");
    const file = path.join(tmp, "cutover-backups", "railway-preflight-2026-08-31T10-00-00-000Z", "PREFLIGHT.json");
    const onDisk = readFileSync(file, "utf8");
    assert.equal(onDisk.includes("PASSWORD"), false);
    assert.equal(onDisk.includes("postgres://u:"), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
