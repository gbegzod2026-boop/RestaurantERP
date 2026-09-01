import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import os from "os";
import path from "path";
import {
  writeRailwayLivePreflightAudit,
  buildRailwayLivePreflightAudit,
  resolveRailwayLivePreflightEvidence,
  RAILWAY_PREFLIGHT_FILE,
} from "../scripts/lib/railwayLivePreflightEvidence.mjs";
import { canonicalRlsCatalogRows } from "../scripts/lib/tenantCatalog.mjs";
import {
  sanitizeLiveRailwayPreflightResult,
  evaluateLiveRailwayPreflight,
  REQUIRED_PREFLIGHT_ROLES,
  REQUIRED_PREFLIGHT_UNIQUES,
  EXPECTED_TENANT_CATALOG_COUNT,
  isCanonicalIsoUtc,
} from "../scripts/lib/runRailwayLivePreflight.mjs";
import { freezeSnapshotValidForCutoverWindow, isCanonicalIsoUtc as freezeCanonical } from "../scripts/lib/freezeSnapshot.mjs";
import { computeCutoverWindowIdentity, buildFreezeEvidence, canonicalFreezeCounts } from "../scripts/lib/cutoverWindow.mjs";

function liveGo() {
  const rows = canonicalRlsCatalogRows();
  return sanitizeLiveRailwayPreflightResult({
    ok: true,
    verdict: "GO",
    executed: true,
    hostClass: "*.proxy.rlwy.net",
    database: "railway",
    sslLive: "on",
    pgcrypto: true,
    latestMigration: { version: "0017" },
    restaurants: 0,
    fixtureLike: 0,
    configuredPoolMax: 10,
    rolesPresent: [...REQUIRED_PREFLIGHT_ROLES],
    requiredUniques: REQUIRED_PREFLIGHT_UNIQUES.map((spec) => ({ table: spec.table, cols: [...spec.cols], ok: true })),
    rls: rows,
    rlsCatalogCount: EXPECTED_TENANT_CATALOG_COUNT,
    failures: [],
  });
}

test("audit artifact is labeled AUDIT_ONLY and never authorizes", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "nesta-audit-"));
  try {
    const written = writeRailwayLivePreflightAudit(tmp, liveGo(), {
      generatedAt: "2026-08-31T10:00:00.000Z",
      completedAt: "2026-08-31T10:01:00.000Z",
    });
    const doc = JSON.parse(readFileSync(path.join(written.dir, RAILWAY_PREFLIGHT_FILE), "utf8"));
    assert.equal(doc.evidenceKind, "AUDIT_ONLY");
    assert.equal(doc.usableForApproval, false);
    assert.equal(doc.live.password, undefined);
    assert.equal(JSON.stringify(doc).includes("postgres://"), false);
    assert.equal(evaluateLiveRailwayPreflight(null, { auditArtifact: doc }).railwayLivePreflight, "NOT RUN");
    assert.equal(resolveRailwayLivePreflightEvidence().railwayLivePreflight, "NOT RUN");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("audit builder refuses noncanonical timestamps", () => {
  assert.throws(() => buildRailwayLivePreflightAudit(liveGo(), {
    generatedAt: "2026-08-31T10:00:00Z",
    completedAt: "2026-08-31T10:00:00.000Z",
  }));
});

test("canonical freeze generatedAt is required; Date.parse-able noncanonical fails", () => {
  const now = Date.parse("2026-08-31T10:30:00.000Z");
  const identity = computeCutoverWindowIdentity({
    candidateCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    remoteMain: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    deployedRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  const bound = buildFreezeEvidence({
    generatedAt: "2026-08-31T10:20:00.000Z",
    firebaseProject: "restoran-30d51",
    counts: canonicalFreezeCounts({
      restaurants: 1,
      users: 1,
      employees: 1,
      orders: 1,
      orderItems: 1,
      payments: 1,
      menu: 1,
      tables: 1,
      customers: 1,
      credentialTrees: 1,
      customRoles: 1,
      platformPromoCodes: 1,
    }),
    candidateCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    cutoverWindowIdentity: identity,
  });
  assert.equal(isCanonicalIsoUtc("2026-08-31T09:00:00.000Z"), true);
  assert.equal(freezeCanonical("2026-08-31T09:00:00Z"), false);
  assert.equal(freezeSnapshotValidForCutoverWindow(bound, {
    now,
    expectedIdentity: identity,
    expectedCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    writeStopGeneratedAt: "2026-08-31T10:10:00.000Z",
  }), true);
  assert.equal(freezeSnapshotValidForCutoverWindow({ ...bound, generatedAt: "2026-08-31T09:00:00Z" }, {
    now,
    expectedIdentity: identity,
    expectedCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    writeStopGeneratedAt: "2026-08-31T10:10:00.000Z",
  }), false);
});
