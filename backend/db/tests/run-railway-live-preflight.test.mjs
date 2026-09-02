import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import os from "os";
import path from "path";
import {
  runRailwayLivePreflight,
  evaluateLiveRailwayPreflight,
  sanitizeLiveRailwayPreflightResult,
  validateClosedSchema,
  LIVE_RESULT_SCHEMA,
  railwayLivePreflightSqlList,
  assertReadOnlySql,
  requiredUniquesSatisfied,
  requiredRolesSatisfied,
  requiredRlsSatisfied,
  railwayProductionPublicProxyHostClass,
  REQUIRED_PREFLIGHT_ROLES,
  REQUIRED_PREFLIGHT_UNIQUES,
  REQUIRED_NAMED_RLS_TABLES,
  CANONICAL_TENANT_RLS_TABLES,
  EXPECTED_TENANT_CATALOG_COUNT,
  REQUIRED_CONFIGURED_POOL_MAX,
  PREFLIGHT_SQL,
  classifyPreflightFailure,
  sanitizeDiagnosticText,
  classifyOperatorCliFailure,
  isCanonicalIsoUtc,
} from "../scripts/lib/runRailwayLivePreflight.mjs";
import { canonicalRlsCatalogRows } from "../scripts/lib/tenantCatalog.mjs";
import { REQUIRED_SCHEMA_VERSION } from "../scripts/lib/migrationTargetGuard.mjs";
import { exampleLiveTargetFingerprint } from "../scripts/lib/pgTargetFingerprint.mjs";
import {
  writeRailwayLivePreflightAudit,
  buildRailwayLivePreflightAudit,
  resolveRailwayLivePreflightEvidence,
  RAILWAY_PREFLIGHT_FILE,
} from "../scripts/lib/railwayLivePreflightEvidence.mjs";
import { evaluateStep2dFinalGates, EXPECTED_PAUSE_CONFIRM } from "../scripts/lib/step2dFinalGate.mjs";
import {
  evaluateDeployFreeze,
  intendedCutoverCandidateTag,
  resolveReviewedCandidate,
  freezeGitFromResolved,
  reviewedCutoverApprovalMessage,
  annotationSatisfiesPolicy,
  extractAnnotatedTagMessage,
  STEP2C_TAG,
  CUTOVER_CANDIDATE_TAG,
  HISTORICAL_FROZEN_TAG,
  REQUIRED_FREEZE_BRANCH,
} from "../scripts/lib/deployFreeze.mjs";
import {
  evaluateCommitEqualityBinding,
  sanitizeRevisionSha,
  revisionFromProbeResponse,
  probeRuntimeRevision,
  publicDeploymentIdentity,
  REQUIRED_PRODUCTION_PROBE_ORIGIN,
} from "../scripts/lib/deployedRevision.mjs";
import {
  computeCutoverWindowIdentity,
  buildWriteStopEvidence,
  buildFreezeEvidence,
  canonicalFreezeCounts,
} from "../scripts/lib/cutoverWindow.mjs";

const PUBLIC_ENV = {
  DATABASE_PUBLIC_URL: "postgres://nesta:placeholder@switchback.proxy.rlwy.net:12345/railway",
  POSTGRES_SSL: "true",
  POSTGRES_POOL_MAX: "10",
};

const HEAD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function approvalGit(overrides = {}) {
  const head = overrides.head || HEAD_SHA;
  return {
    head,
    tag: overrides.tag === undefined ? head : overrides.tag,
    dirty: false,
    candidateTag: CUTOVER_CANDIDATE_TAG,
    tagType: "tag",
    tagAnnotation: reviewedCutoverApprovalMessage(),
    branch: REQUIRED_FREEZE_BRANCH,
    originMain: head,
    ...overrides,
  };
}

function uniqueRows(mutate) {
  const rows = REQUIRED_PREFLIGHT_UNIQUES.map((spec) => ({
    table: spec.table,
    cols: [...spec.cols],
    ok: true,
  }));
  return mutate ? mutate(rows) : rows;
}

function rlsCatalog(mutate) {
  const rows = canonicalRlsCatalogRows();
  return mutate ? mutate(rows) : rows;
}

function validLive(overrides = {}) {
  return sanitizeLiveRailwayPreflightResult({
    ok: true,
    verdict: "GO",
    mode: "READ-ONLY",
    readOnly: true,
    executed: true,
    status: "PASS",
    hostClass: "*.proxy.rlwy.net",
    database: "railway",
    sslLive: "on",
    pgcrypto: true,
    latestMigration: { version: REQUIRED_SCHEMA_VERSION },
    restaurants: 0,
    fixtureLike: 0,
    configuredPoolMax: REQUIRED_CONFIGURED_POOL_MAX,
    rolesPresent: [...REQUIRED_PREFLIGHT_ROLES],
    requiredUniques: uniqueRows(),
    rls: rlsCatalog(),
    rlsCatalogCount: EXPECTED_TENANT_CATALOG_COUNT,
    targetFingerprint: exampleLiveTargetFingerprint(),
    failures: [],
    ...overrides,
  });
}

function currentWindowEvidence(head) {
  const identity = computeCutoverWindowIdentity({
    candidateCommit: head,
    remoteMain: head,
    deployedRevision: head,
  });
  return {
    now: Date.parse("2026-08-31T10:30:00.000Z"),
    writeStopEvidence: buildWriteStopEvidence({
      classified: {
        productionWriteStop: "PASS",
        maintenance: "ON",
        writeObserved: false,
        tenantWriteBlocked: true,
        clickBlocked: true,
        paymeBlocked: true,
        uzumBlocked: true,
      },
      generatedAt: "2026-08-31T10:10:00.000Z",
      origin: REQUIRED_PRODUCTION_PROBE_ORIGIN,
      candidateCommit: head,
      cutoverWindowIdentity: identity,
    }),
    freezeEvidence: buildFreezeEvidence({
      generatedAt: "2026-08-31T10:15:00.000Z",
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
      candidateCommit: head,
      cutoverWindowIdentity: identity,
    }),
  };
}

function armedGates(railwayLivePreflight, gitOverrides = {}, extra = {}) {
  const git = {
    ...approvalGit(),
    ...gitOverrides,
  };
  const window = currentWindowEvidence(git.head);
  return evaluateStep2dFinalGates({
    env: {
      NESTA_PAYMENT_CUTOVER_MODE: "OPERATOR_PAUSED",
      NESTA_PAYMENT_PAUSE_CONFIRM: EXPECTED_PAUSE_CONFIRM,
      NESTA_MAINTENANCE_MODE: "1",
    },
    backups: { firebase: 1, pg: 1, appConfig: 1 },
    git,
    railwayLivePreflight,
    runtimeRevision: git.head,
    liveRemoteMain: git.head,
    now: window.now,
    writeStopEvidence: window.writeStopEvidence,
    freezeEvidence: window.freezeEvidence,
    ...extra,
  });
}

function mockClient(overrides = {}) {
  const recorded = [];
  const roles = overrides.roles || [...REQUIRED_PREFLIGHT_ROLES];
  const rls = overrides.rls || rlsCatalog();
  const uniques = overrides.uniques || uniqueRows();
  const ssl = overrides.ssl ?? "on";
  const pgcrypto = overrides.pgcrypto !== false;
  const latest = overrides.latest ?? REQUIRED_SCHEMA_VERSION;
  const restaurants = overrides.restaurants ?? 0;
  const fixtureLike = overrides.fixtureLike ?? 0;
  const connectError = overrides.connectError || null;
  const queryError = overrides.queryError || null;
  const client = {
    recorded,
    async connect() {
      if (connectError) throw new Error(connectError);
    },
    async end() {},
    async query(sql, params) {
      recorded.push(sql);
      const s = String(sql).replace(/\s+/g, " ").trim();
      if (/^(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE)\b/i.test(s)) {
        throw new Error("cannot execute INSERT/UPDATE/DELETE in a read-only transaction");
      }
      if (queryError) throw new Error(queryError);
      if (/^SET /i.test(s) || /^BEGIN /i.test(s) || /^ROLLBACK/i.test(s)) return { rows: [], rowCount: 0 };
      if (/SHOW ssl/i.test(s)) return { rows: [{ ssl }] };
      if (/pg_extension/i.test(s)) return { rowCount: pgcrypto ? 1 : 0, rows: pgcrypto ? [{}] : [] };
      if (/pg_roles/i.test(s)) return { rows: roles.map((rolname) => ({ rolname })) };
      if (/schema_migrations/i.test(s)) return { rows: latest ? [{ version: latest }] : [] };
      if (/relrowsecurity/i.test(s)) {
        return {
          rows: rls.map((row) => ({
            table_name: row.table,
            relrowsecurity: row.rls,
            relforcerowsecurity: row.force_rls,
          })),
        };
      }
      if (/rest_1999/i.test(s)) return { rows: [{ n: fixtureLike }] };
      if (/FROM restaurants/i.test(s)) return { rows: [{ n: restaurants }] };
      if (/pg_index/i.test(s)) {
        const table = params?.[0];
        const cols = params?.[1] || [];
        const ok = uniques.some((u) => u.table === table && u.ok && u.cols.join(",") === cols.join(","));
        return { rowCount: ok ? 1 : 0, rows: ok ? [{}] : [] };
      }
      if (/pg_control_system/i.test(s) || /current_database\(\)/i.test(s)) {
        return {
          rows: [{
            current_database: overrides.currentDatabase ?? "railway",
            inet_server_addr: overrides.inetServerAddr ?? "10.0.0.1",
            inet_server_port: overrides.inetServerPort ?? 5432,
            system_identifier: overrides.systemIdentifier ?? "1111111111111111111",
          }],
        };
      }
      if (/SHOW max_connections/i.test(s)) return { rows: [{ max_connections: "100" }] };
      return { rows: [], rowCount: 0 };
    },
  };
  return client;
}

test("no live preflight + perfect forged PREFLIGHT.json => FAIL", () => {
  const forged = buildRailwayLivePreflightAudit(validLive());
  const ev = evaluateLiveRailwayPreflight(null, { auditArtifact: forged });
  assert.equal(ev.railwayLivePreflight, "NOT RUN");
  const gated = armedGates(ev.railwayLivePreflight);
  assert.equal(gated.approvalBlockers.includes("railwayPgSchema"), true);
  assert.equal(gated.safeToRequestHumanApproval, false);
  assert.equal(gated.safeToMigrateProductionData, false);
  assert.equal(gated.migrationAuthorized, false);
});

test("stale PREFLIGHT.json + live unavailable => FAIL", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "nesta-audit-"));
  try {
    writeRailwayLivePreflightAudit(tmp, validLive());
    const live = await runRailwayLivePreflight({ env: {}, requireDatabasePublicUrl: true });
    const ev = evaluateLiveRailwayPreflight(live, { auditArtifact: { verdict: "GO" } });
    assert.equal(ev.railwayLivePreflight, "NOT RUN");
    assert.equal(resolveRailwayLivePreflightEvidence().railwayLivePreflight, "NOT RUN");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("valid audit artifact + live NO-GO => FAIL", async () => {
  const client = mockClient({ restaurants: 3 });
  const live = await runRailwayLivePreflight({
    env: PUBLIC_ENV,
    requireDatabasePublicUrl: true,
    clientFactory: async () => client,
  });
  const audit = buildRailwayLivePreflightAudit(validLive());
  const ev = evaluateLiveRailwayPreflight(live, { auditArtifact: audit });
  assert.equal(ev.railwayLivePreflight, "FAIL");
  const gated = armedGates(ev.railwayLivePreflight);
  assert.equal(gated.approvalBlockers.includes("railwayPgSchema"), true);
  assert.equal(gated.safeToMigrateProductionData, false);
});

test("default live GO still requires restaurants = 0", () => {
  assert.equal(evaluateLiveRailwayPreflight(validLive({ restaurants: 3 })).railwayLivePreflight, "FAIL");
});

test("structural live GO allows populated restaurants when requireZeroRestaurants is false", () => {
  const live = validLive({ restaurants: 3 });
  assert.equal(evaluateLiveRailwayPreflight(live, { requireZeroRestaurants: false }).railwayLivePreflight, "PASS");
  assert.equal(evaluateLiveRailwayPreflight(live, { requireZeroRestaurants: true }).railwayLivePreflight, "FAIL");
});

test("missing targetFingerprint fails live GO", () => {
  const live = validLive({ targetFingerprint: "" });
  assert.equal(evaluateLiveRailwayPreflight(live).railwayLivePreflight, "FAIL");
});

test("live preflight fingerprint binds host, database, and cluster identity", async () => {
  const live = await runRailwayLivePreflight({
    env: PUBLIC_ENV,
    clientFactory: async () => mockClient(),
  });
  assert.equal(live.targetFingerprint, exampleLiveTargetFingerprint());
  assert.equal(evaluateLiveRailwayPreflight(live).railwayLivePreflight, "PASS");

  const otherCluster = await runRailwayLivePreflight({
    env: PUBLIC_ENV,
    clientFactory: async () => mockClient({ systemIdentifier: "9999999999999999999" }),
  });
  assert.notEqual(otherCluster.targetFingerprint, live.targetFingerprint);

  const otherDb = await runRailwayLivePreflight({
    env: { ...PUBLIC_ENV, DATABASE_PUBLIC_URL: "postgres://nesta:placeholder@switchback.proxy.rlwy.net:12345/otherdb" },
    clientFactory: async () => mockClient({ currentDatabase: "otherdb" }),
  });
  assert.notEqual(otherDb.targetFingerprint, live.targetFingerprint);

  const otherInet = await runRailwayLivePreflight({
    env: PUBLIC_ENV,
    clientFactory: async () => mockClient({ inetServerAddr: "10.9.8.7", inetServerPort: 59999 }),
  });
  assert.equal(otherInet.targetFingerprint, live.targetFingerprint);
});

test("no artifact + genuine live GO => PASS", async () => {
  const client = mockClient();
  const live = await runRailwayLivePreflight({
    env: PUBLIC_ENV,
    requireDatabasePublicUrl: true,
    clientFactory: async () => client,
  });
  const ev = evaluateLiveRailwayPreflight(live, { auditArtifact: null });
  assert.equal(live.executed, true);
  assert.equal(ev.railwayLivePreflight, "PASS");
  const blob = JSON.stringify(live);
  assert.equal(blob.includes("placeholder"), false);
  assert.equal(blob.includes("DATABASE_PUBLIC_URL"), false);
});

test("genuine live GO result => railwayLivePreflight PASS", () => {
  const ev = evaluateLiveRailwayPreflight(validLive());
  assert.equal(ev.railwayLivePreflight, "PASS");
  const gated = armedGates("PASS");
  assert.equal(gated.cutoverWindowArmed, true);
  assert.equal(gated.safeToRequestHumanApproval, true);
  assert.equal(gated.safeToMigrateProductionData, false);
  assert.equal(gated.migrationAuthorized, false);
});

test("read-only query surface is the declared preflight allowlist", () => {
  for (const sql of railwayLivePreflightSqlList()) {
    assert.doesNotThrow(() => assertReadOnlySql(sql));
    assert.match(String(sql).trim(), /^(SET|BEGIN|SELECT|SHOW|ROLLBACK)/i);
  }
  for (const sql of Object.values(PREFLIGHT_SQL)) {
    assert.doesNotThrow(() => assertReadOnlySql(sql));
  }
  assert.throws(() => assertReadOnlySql("SELECT 1"));
  assert.throws(() => assertReadOnlySql("SELECT 1; DELETE FROM restaurants"));
  assert.throws(() => assertReadOnlySql("WITH x AS (DELETE FROM restaurants) SELECT 1"));
  assert.throws(() => assertReadOnlySql("CALL something()"));
  assert.throws(() => assertReadOnlySql("COPY restaurants TO STDOUT"));
  assert.throws(() => assertReadOnlySql("/* comment */ DELETE FROM restaurants"));
  assert.throws(() => assertReadOnlySql("-- comment\nUPDATE restaurants SET id = 1"));
  assert.throws(() => assertReadOnlySql("insert into restaurants values (1)"));
  assert.throws(() => assertReadOnlySql("LOCK TABLE restaurants"));
});

test("mock read-only transaction denies attempted write", async () => {
  const client = mockClient();
  await runRailwayLivePreflight({
    env: PUBLIC_ENV,
    clientFactory: async () => client,
  });
  const fromRunner = client.recorded.slice();
  await assert.rejects(() => client.query("INSERT INTO restaurants VALUES (1)"));
  for (const sql of fromRunner) {
    assert.doesNotThrow(() => assertReadOnlySql(sql));
  }
});

test("all required roles pass; each missing role fails; extras cannot compensate", () => {
  assert.equal(requiredRolesSatisfied([...REQUIRED_PREFLIGHT_ROLES]), true);
  assert.equal(evaluateLiveRailwayPreflight(validLive()).railwayLivePreflight, "PASS");
  for (const missing of REQUIRED_PREFLIGHT_ROLES) {
    const roles = REQUIRED_PREFLIGHT_ROLES.filter((r) => r !== missing).concat("postgres");
    assert.equal(requiredRolesSatisfied(roles), false);
    assert.equal(evaluateLiveRailwayPreflight(validLive({ rolesPresent: roles })).railwayLivePreflight, "FAIL");
  }
});

test("exact 4/4 unique checks pass", () => {
  assert.equal(requiredUniquesSatisfied(uniqueRows()), true);
  assert.equal(evaluateLiveRailwayPreflight(validLive()).railwayLivePreflight, "PASS");
});

test("3/4 unique checks fail", () => {
  const rows = uniqueRows().slice(0, 3);
  assert.equal(requiredUniquesSatisfied(rows), false);
  assert.equal(evaluateLiveRailwayPreflight(validLive({ requiredUniques: rows })).railwayLivePreflight, "FAIL");
});

test("canonical catalog has 74 unique identities", () => {
  assert.equal(CANONICAL_TENANT_RLS_TABLES.length, 74);
  assert.equal(new Set(CANONICAL_TENANT_RLS_TABLES).size, 74);
});

test("exact 74 unique expected names, all true => PASS", () => {
  assert.equal(requiredRlsSatisfied(rlsCatalog(), EXPECTED_TENANT_CATALOG_COUNT), true);
  assert.equal(evaluateLiveRailwayPreflight(validLive()).railwayLivePreflight, "PASS");
});

test("74 expected identities in different order pass", () => {
  const rows = [...rlsCatalog()].reverse();
  assert.equal(requiredRlsSatisfied(rows, EXPECTED_TENANT_CATALOG_COUNT), true);
  assert.equal(evaluateLiveRailwayPreflight(validLive({ rls: rows })).railwayLivePreflight, "PASS");
});

test("73 expected + one duplicate fails", () => {
  const rows = rlsCatalog().slice(0, 73);
  rows.push({ ...rows[0] });
  assert.equal(requiredRlsSatisfied(rows, EXPECTED_TENANT_CATALOG_COUNT), false);
});

test("73 expected + one unexpected new table fails", () => {
  const rows = rlsCatalog().slice(0, 73);
  rows.push({ table: "unexpected_table", rls: true, force_rls: true });
  assert.equal(requiredRlsSatisfied(rows, EXPECTED_TENANT_CATALOG_COUNT), false);
});

test("74 rows with duplicate noncritical identity fails", () => {
  const rows = rlsCatalog().filter((r) => r.table !== "waste_log");
  rows.push({ table: "activity_logs", rls: true, force_rls: true });
  assert.equal(rows.length, EXPECTED_TENANT_CATALOG_COUNT);
  assert.equal(requiredRlsSatisfied(rows, EXPECTED_TENANT_CATALOG_COUNT), false);
});

test("missing noncritical intended table fails", () => {
  const rows = rlsCatalog().filter((r) => r.table !== "waste_log");
  assert.equal(requiredRlsSatisfied(rows, rows.length), false);
});

test("missing critical table fails", () => {
  const rows = rlsCatalog().filter((r) => r.table !== "restaurants");
  assert.equal(REQUIRED_NAMED_RLS_TABLES.includes("restaurants"), true);
  assert.equal(requiredRlsSatisfied(rows, rows.length), false);
});

test("rls=false on one table fails", () => {
  const rows = rlsCatalog((all) => all.map((row, i) => (i === 0 ? { ...row, rls: false } : row)));
  assert.equal(requiredRlsSatisfied(rows, EXPECTED_TENANT_CATALOG_COUNT), false);
});

test("force_rls=false on one table fails", () => {
  const rows = rlsCatalog((all) => all.map((row, i) => (i === 2 ? { ...row, force_rls: false } : row)));
  assert.equal(requiredRlsSatisfied(rows, EXPECTED_TENANT_CATALOG_COUNT), false);
});

test("75 rows with all expected plus extra fails", () => {
  const rows = [...rlsCatalog(), { table: "extra_table", rls: true, force_rls: true }];
  assert.equal(requiredRlsSatisfied(rows, rows.length), false);
});

test("malformed RLS rows fail", () => {
  assert.equal(requiredRlsSatisfied(null, 74), false);
  assert.equal(requiredRlsSatisfied([{ table: 1, rls: true, force_rls: true }], 1), false);
  assert.equal(requiredRlsSatisfied(["restaurants"], 1), false);
});

test("DATABASE_PUBLIC_URL presence alone cannot pass", async () => {
  const live = await runRailwayLivePreflight({
    env: PUBLIC_ENV,
    requireDatabasePublicUrl: true,
    clientFactory: async () => mockClient({ connectError: "ECONNREFUSED" }),
  });
  assert.notEqual(evaluateLiveRailwayPreflight(live).railwayLivePreflight, "PASS");
});

test("missing DATABASE_PUBLIC_URL is NOT RUN and blocks approval", async () => {
  const live = await runRailwayLivePreflight({ env: { POSTGRES_SSL: "true" }, requireDatabasePublicUrl: true });
  const ev = evaluateLiveRailwayPreflight(live);
  assert.equal(ev.railwayLivePreflight, "NOT RUN");
  const gated = armedGates(ev.railwayLivePreflight);
  assert.equal(gated.approvalBlockers.includes("railwayPgSchema"), true);
});

test("connection failure is FAIL without leaking secrets", async () => {
  const live = await runRailwayLivePreflight({
    env: PUBLIC_ENV,
    clientFactory: async () => mockClient({ connectError: "ECONNREFUSED postgres://u:secret@h/db" }),
  });
  assert.equal(evaluateLiveRailwayPreflight(live).railwayLivePreflight, "FAIL");
  const blob = JSON.stringify(live);
  assert.equal(blob.includes("secret"), false);
  assert.equal(blob.includes("postgres://"), false);
  assert.equal(live.failures.every((code) => /^[A-Z][A-Z0-9_]{2,64}$/.test(code)), true);
});

test("error sanitization strips URLs, tokens, keys, and credential blobs", () => {
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.abc";
  const stripeLikeKey = ["sk", "live", "abcdefghijklmnopqrstuvwxyz"].join("_");
  for (const raw of [
    "postgres://nesta:hunter2@switchback.proxy.rlwy.net:5432/railway",
    "Authorization: Bearer super-secret-token",
    jwt,
    `api_key=${stripeLikeKey}`,
    "https://restoran-30d51.firebaseio.com and type service_account",
    "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----",
  ]) {
    const code = classifyPreflightFailure(raw);
    assert.match(code, /^[A-Z][A-Z0-9_]+$/);
    assert.equal(sanitizeDiagnosticText(raw), code);
    const live = sanitizeLiveRailwayPreflightResult(validLive({
      ok: false,
      verdict: "NO-GO",
      status: "FAIL",
      failures: [raw],
    }));
    const blob = JSON.stringify(live);
    assert.equal(blob.includes("postgres://"), false);
    assert.equal(blob.includes("Bearer"), false);
    assert.equal(blob.includes(jwt), false);
    assert.equal(blob.includes(stripeLikeKey), false);
    assert.equal(blob.includes("BEGIN PRIVATE"), false);
    assert.equal(blob.includes("firebaseio.com"), false);
  }
});

test("candidate commit with no approval binding fails", () => {
  const r = evaluateDeployFreeze({
    head: HEAD_SHA,
    tag: null,
    dirty: false,
    candidateTag: CUTOVER_CANDIDATE_TAG,
  });
  assert.equal(r.deployFreeze, "FAIL");
  assert.equal(r.noApprovalBinding, true);
});

test("arbitrary lightweight tag fails", () => {
  const r = evaluateDeployFreeze(approvalGit({
    tagType: "commit",
    tagAnnotation: null,
  }));
  assert.equal(r.deployFreeze, "FAIL");
  assert.equal(r.lightweightTagRefused, true);
});

test("wrong annotation fails", () => {
  const r = evaluateDeployFreeze(approvalGit({
    tagAnnotation: "lgtm\npurpose=step2-production-cutover\nversion=1",
  }));
  assert.equal(r.deployFreeze, "FAIL");
  assert.equal(r.annotatedApproval, "FAIL");
});

test("tag pointing to another commit fails", () => {
  const r = evaluateDeployFreeze(approvalGit({ tag: OTHER_SHA }));
  assert.equal(r.deployFreeze, "FAIL");
  assert.equal(r.headMatch, "FAIL");
  assert.equal(r.tagMatch, "FAIL");
});

test("arbitrary tag name fails", () => {
  const r = evaluateDeployFreeze(approvalGit({
    candidateTag: "nesta-custom-local-tag",
  }));
  assert.equal(r.deployFreeze, "FAIL");
  assert.equal(r.unapprovedCandidateTag, true);
});

test("historical Step2C tag fails", () => {
  const r = evaluateDeployFreeze(approvalGit({ candidateTag: STEP2C_TAG }));
  assert.equal(r.deployFreeze, "FAIL");
  assert.equal(r.historicalStep2cRefused, true);
});

test("historical frozen tag does not authorize", () => {
  const r = evaluateDeployFreeze(approvalGit({ candidateTag: HISTORICAL_FROZEN_TAG }));
  assert.equal(r.deployFreeze, "FAIL");
  assert.equal(r.historicalFrozenTagRefused, true);
});

test("correct approved annotated tag pointing to HEAD + clean tree passes", () => {
  const r = evaluateDeployFreeze(approvalGit());
  assert.equal(r.deployFreeze, "PASS");
  assert.equal(r.annotatedApproval, "PASS");
  assert.equal(r.branchMatch, "PASS");
  assert.equal(r.detachedHead, false);
});

test("dirty tree fails", () => {
  const r = evaluateDeployFreeze(approvalGit({ dirty: true }));
  assert.equal(r.deployFreeze, "FAIL");
  assert.equal(r.workingTreeClean, "FAIL");
});

test("env arbitrary override fails", () => {
  assert.equal(resolveReviewedCandidate({ NESTA_CUTOVER_CANDIDATE_TAG: "nesta-step2-cutover-ready-v2" }).ok, false);
  const git = freezeGitFromResolved({
    env: { NESTA_CUTOVER_CANDIDATE_TAG: "nesta-step2-cutover-ready-v2" },
    head: HEAD_SHA,
    dirty: false,
    inspectTag: () => ({
      type: "tag",
      annotation: reviewedCutoverApprovalMessage(),
      peeledCommit: HEAD_SHA,
    }),
  });
  assert.equal(evaluateDeployFreeze(git, { NESTA_CUTOVER_CANDIDATE_TAG: "nesta-step2-cutover-ready-v2" }).deployFreeze, "FAIL");
});

test("env unset follows approved default; still needs annotated binding", () => {
  assert.equal(intendedCutoverCandidateTag({}), CUTOVER_CANDIDATE_TAG);
  assert.equal(resolveReviewedCandidate({}).ok, true);
  const unbound = freezeGitFromResolved({
    env: {},
    head: HEAD_SHA,
    dirty: false,
  });
  assert.equal(evaluateDeployFreeze(unbound, {}).deployFreeze, "FAIL");
  const bound = freezeGitFromResolved({
    env: {},
    head: HEAD_SHA,
    dirty: false,
    branch: REQUIRED_FREEZE_BRANCH,
    originMain: HEAD_SHA,
    inspectTag: () => ({
      type: "tag",
      annotation: reviewedCutoverApprovalMessage(),
      peeledCommit: HEAD_SHA,
    }),
  });
  assert.equal(evaluateDeployFreeze(bound, {}).deployFreeze, "PASS");
});

test("operator CLI errors emit codes not raw secrets", () => {
  const code = classifyOperatorCliFailure(new Error("ECONNREFUSED postgres://u:secret@h/db"));
  assert.equal(code, "PG_CONNECT_FAILED");
  assert.equal(code.includes("secret"), false);
  assert.equal(classifyOperatorCliFailure(new Error("unexpected boom https://example.com")), "OPERATOR_CLI_FAILED");
});

test("canonical exact annotation passes; CRLF equivalent passes; cat-file body passes", () => {
  const canonical = reviewedCutoverApprovalMessage();
  assert.equal(annotationSatisfiesPolicy(canonical), true);
  assert.equal(annotationSatisfiesPolicy(canonical.replace(/\n/g, "\r\n")), true);
  const catFile = [
    `object ${HEAD_SHA}`,
    "type commit",
    `tag ${CUTOVER_CANDIDATE_TAG}`,
    "tagger Nesta <nesta@example.test> 1 +0000",
    "",
    canonical,
    "",
  ].join("\n");
  assert.equal(extractAnnotatedTagMessage(catFile), canonical);
  assert.equal(annotationSatisfiesPolicy(catFile), true);
});

test("conflicting and identical annotation duplicates fail", () => {
  const canonical = reviewedCutoverApprovalMessage();
  assert.equal(annotationSatisfiesPolicy(
    `${canonical}\npurpose=other-purpose`,
  ), false);
  assert.equal(annotationSatisfiesPolicy(
    `${canonical}\npurpose=step2-production-cutover`,
  ), false);
  assert.equal(annotationSatisfiesPolicy(
    `${canonical}\nversion=2`,
  ), false);
  assert.equal(annotationSatisfiesPolicy(
    `${canonical}\nversion=1`,
  ), false);
  assert.equal(annotationSatisfiesPolicy(
    `NESTA_STEP2_REVIEWED_CUTOVER_APPROVAL_V1\n${canonical}`,
  ), false);
});

test("annotation whitespace, order, extra line, substring, and padded version fail", () => {
  assert.equal(annotationSatisfiesPolicy(
    " NESTA_STEP2_REVIEWED_CUTOVER_APPROVAL_V1\npurpose=step2-production-cutover\nversion=1",
  ), false);
  assert.equal(annotationSatisfiesPolicy(
    "NESTA_STEP2_REVIEWED_CUTOVER_APPROVAL_V1 \npurpose=step2-production-cutover\nversion=1",
  ), false);
  assert.equal(annotationSatisfiesPolicy(
    "NESTA_STEP2_REVIEWED_CUTOVER_APPROVAL_V1\npurpose=step2-production-cutover \nversion=1",
  ), false);
  assert.equal(annotationSatisfiesPolicy(
    "NESTA_STEP2_REVIEWED_CUTOVER_APPROVAL_V1\npurpose =step2-production-cutover\nversion=1",
  ), false);
  assert.equal(annotationSatisfiesPolicy(
    "NESTA_STEP2_REVIEWED_CUTOVER_APPROVAL_V1\t\npurpose=step2-production-cutover\nversion=1",
  ), false);
  assert.equal(annotationSatisfiesPolicy(
    "purpose=step2-production-cutover\nNESTA_STEP2_REVIEWED_CUTOVER_APPROVAL_V1\nversion=1",
  ), false);
  assert.equal(annotationSatisfiesPolicy(
    `${reviewedCutoverApprovalMessage()}\napproved-by=alice`,
  ), false);
  assert.equal(annotationSatisfiesPolicy(
    "XNESTA_STEP2_REVIEWED_CUTOVER_APPROVAL_V1\npurpose=step2-production-cutover\nversion=1",
  ), false);
  assert.equal(annotationSatisfiesPolicy(
    "nesta_step2_reviewed_cutover_approval_v1\npurpose=step2-production-cutover\nversion=1",
  ), false);
  assert.equal(annotationSatisfiesPolicy(
    "NESTA_STEP2_REVIEWED_CUTOVER_APPROVAL_V1\npurpose=step2-production-cutover\nversion=01",
  ), false);
  assert.equal(annotationSatisfiesPolicy(
    "NESTA_STEP2_REVIEWED_CUTOVER_APPROVAL_V1\npurpose=step2-production-cutover\nversion=1.0",
  ), false);
  assert.equal(annotationSatisfiesPolicy(
    "NESTA_STEP2_REVIEWED_CUTOVER_APPROVAL_V1\npurpose=step2-production-cutover\nversion=10",
  ), false);
});

test("detached HEAD at the same commit fails", () => {
  const r = evaluateDeployFreeze(approvalGit({ branch: null }));
  assert.equal(r.deployFreeze, "FAIL");
  assert.equal(r.detachedHead, true);
  assert.equal(r.branchMatch, "FAIL");
  assert.equal(r.headMatch, "PASS");
});

test("non-main branch at the same commit fails", () => {
  const r = evaluateDeployFreeze(approvalGit({ branch: "cutover" }));
  assert.equal(r.deployFreeze, "FAIL");
  assert.equal(r.detachedHead, false);
  assert.equal(r.branchMatch, "FAIL");
});

test("symbolic-ref failure is detached and fails", () => {
  const r = evaluateDeployFreeze(approvalGit({ branch: "" }));
  assert.equal(r.deployFreeze, "FAIL");
  assert.equal(r.detachedHead, true);
});

test("cached origin/main matching HEAD does not authorize if live GitHub main differs", () => {
  const gated = armedGates("PASS", { originMain: HEAD_SHA }, { liveRemoteMain: OTHER_SHA });
  assert.equal(evaluateDeployFreeze(approvalGit({ originMain: HEAD_SHA })).deployFreeze, "PASS");
  assert.equal(gated.approvalBlockers.includes("originMainMatch"), true);
  assert.equal(gated.remoteMainLive, "FAIL");
  assert.equal(gated.cutoverWindowArmed, false);
  assert.equal(gated.safeToRequestHumanApproval, false);
});

test("cached origin/main old is ignored when live GitHub main equals HEAD", () => {
  const gated = armedGates("PASS", { originMain: OTHER_SHA }, { liveRemoteMain: HEAD_SHA });
  assert.equal(gated.approvalBlockers.includes("originMainMatch"), false);
  assert.equal(gated.remoteMainLive, "PASS");
});

test("origin/main match but runtime old fails deployedRevision", () => {
  const gated = armedGates("PASS", {}, { runtimeRevision: OTHER_SHA });
  assert.equal(gated.approvalBlockers.includes("deployedRevision"), true);
  assert.equal(gated.cutoverWindowArmed, false);
});

test("runtime match but local tag wrong fails", () => {
  const gated = armedGates("PASS", { tag: OTHER_SHA }, { runtimeRevision: HEAD_SHA });
  assert.equal(gated.approvalBlockers.includes("deployFreeze"), true);
  assert.equal(gated.approvalBlockers.includes("deployedRevision"), true);
  assert.equal(gated.cutoverWindowArmed, false);
});

test("missing and malformed runtime revision fail deployedRevision", () => {
  assert.equal(armedGates("PASS", {}, { runtimeRevision: null }).approvalBlockers.includes("deployedRevision"), true);
  assert.equal(armedGates("PASS", {}, { runtimeRevision: "not-a-sha" }).approvalBlockers.includes("deployedRevision"), true);
  assert.equal(armedGates("PASS", {}, { runtimeRevision: ` ${HEAD_SHA}` }).approvalBlockers.includes("deployedRevision"), true);
  assert.equal(armedGates("PASS", {}, { runtimeRevision: HEAD_SHA.toUpperCase() }).approvalBlockers.includes("deployedRevision"), true);
});

test("local HEAD, reviewed tag, live GitHub main, and runtime revision equality passes", () => {
  const eq = evaluateCommitEqualityBinding({
    head: HEAD_SHA,
    tag: HEAD_SHA,
    originMain: OTHER_SHA,
    liveRemoteMain: HEAD_SHA,
    runtimeRevision: HEAD_SHA,
  });
  assert.equal(eq.originMainMatch, "PASS");
  assert.equal(eq.deployedRevision, "PASS");
  assert.equal(eq.allMatch, true);
  assert.equal(eq.cachedOriginMainAuthoritative, false);
  const gated = armedGates("PASS");
  assert.equal(gated.cutoverWindowArmed, true);
  assert.equal(gated.remoteMainLive, "PASS");
  assert.equal(gated.approvalBlockers.includes("originMainMatch"), false);
  assert.equal(gated.approvalBlockers.includes("deployedRevision"), false);
  assert.equal(gated.safeToMigrateProductionData, false);
  assert.equal(gated.migrationAuthorized, false);
});

test("revision sanitizer accepts only exact lowercase 40-hex", () => {
  assert.equal(sanitizeRevisionSha(HEAD_SHA), HEAD_SHA);
  assert.equal(sanitizeRevisionSha(null), null);
  assert.equal(sanitizeRevisionSha(` ${HEAD_SHA}`), null);
  assert.equal(sanitizeRevisionSha(`${HEAD_SHA} `), null);
  assert.equal(sanitizeRevisionSha(HEAD_SHA.toUpperCase()), null);
  assert.equal(sanitizeRevisionSha("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), null);
  assert.equal(publicDeploymentIdentity({}).revision, null);
  assert.equal(publicDeploymentIdentity({ RAILWAY_GIT_COMMIT_SHA: HEAD_SHA }).revision, HEAD_SHA);
  assert.equal(publicDeploymentIdentity({ RAILWAY_GIT_COMMIT_SHA: ` ${HEAD_SHA}` }).revision, null);
});

test("probe revision parser and mocked fetch fail closed", async () => {
  assert.equal(revisionFromProbeResponse(200, { revision: HEAD_SHA }).ok, true);
  assert.equal(revisionFromProbeResponse(200, { revision: HEAD_SHA }).revision, HEAD_SHA);
  assert.equal(revisionFromProbeResponse(503, { revision: HEAD_SHA }).ok, false);
  assert.equal(revisionFromProbeResponse(200, {}).reason, "malformed");
  assert.equal(revisionFromProbeResponse(200, { revision: "nope" }).reason, "malformed");
  assert.equal(revisionFromProbeResponse(200, { revision: ` ${HEAD_SHA}` }).reason, "malformed");
  assert.equal(revisionFromProbeResponse(200, { ok: true, revision: HEAD_SHA }).reason, "malformed");
  const unsetUsesProd = await probeRuntimeRevision({ baseUrl: "", fetchImpl: null });
  assert.equal(unsetUsesProd.reason, "unavailable");
  const headers = { get: (k) => (String(k).toLowerCase() === "content-type" ? "application/json" : null) };
  const mocked = await probeRuntimeRevision({
    baseUrl: REQUIRED_PRODUCTION_PROBE_ORIGIN,
    fetchImpl: async (url, opts) => {
      assert.equal(opts.redirect, "manual");
      assert.equal(url, `${REQUIRED_PRODUCTION_PROBE_ORIGIN}/api/deployment`);
      return {
        status: 200,
        url: `${REQUIRED_PRODUCTION_PROBE_ORIGIN}/api/deployment`,
        headers,
        json: async () => ({ revision: HEAD_SHA }),
      };
    },
  });
  assert.equal(mocked.ok, true);
  assert.equal(mocked.revision, HEAD_SHA);
  const mismatch = await probeRuntimeRevision({
    baseUrl: REQUIRED_PRODUCTION_PROBE_ORIGIN,
    fetchImpl: async () => ({
      status: 200,
      url: `${REQUIRED_PRODUCTION_PROBE_ORIGIN}/api/deployment`,
      headers,
      json: async () => ({ revision: OTHER_SHA }),
    }),
  });
  assert.equal(mismatch.revision, OTHER_SHA);
  const down = await probeRuntimeRevision({
    baseUrl: REQUIRED_PRODUCTION_PROBE_ORIGIN,
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(down.ok, false);
  assert.equal(down.reason, "unavailable");
});

test("safeToMigrateProductionData and migrationAuthorized stay false", () => {
  const gated = armedGates("PASS");
  assert.equal(gated.safeToMigrateProductionData, false);
  assert.equal(gated.migrationAuthorized, false);
});

test("audit artifact is written after live result and cannot authorize", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "nesta-audit-"));
  try {
    const written = writeRailwayLivePreflightAudit(tmp, validLive(), {
      generatedAt: "2026-08-31T10:00:00.000Z",
      completedAt: "2026-08-31T10:01:00.000Z",
    });
    const onDisk = JSON.parse(readFileSync(path.join(written.dir, RAILWAY_PREFLIGHT_FILE), "utf8"));
    assert.equal(onDisk.evidenceKind, "AUDIT_ONLY");
    assert.equal(onDisk.usableForApproval, false);
    assert.equal(evaluateLiveRailwayPreflight(null, { auditArtifact: onDisk }).railwayLivePreflight, "NOT RUN");
    mkdirSync(path.join(tmp, "cutover-backups", "zzz-forged"), { recursive: true });
    writeFileSync(path.join(tmp, "cutover-backups", "zzz-forged", RAILWAY_PREFLIGHT_FILE), JSON.stringify(onDisk));
    assert.equal(resolveRailwayLivePreflightEvidence(tmp).reason.includes("audit-only"), true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("opaque extra property fails recursive schema", () => {
  const live = validLive();
  live.extra = "innocent";
  assert.equal(validateClosedSchema(live, LIVE_RESULT_SCHEMA), "$.extra: unknown property");
  assert.equal(evaluateLiveRailwayPreflight(live).railwayLivePreflight, "FAIL");
});

test("canonical toISOString timestamps pass; noncanonical Date.parse-able fail", () => {
  assert.equal(isCanonicalIsoUtc("2026-08-31T10:00:00.000Z"), true);
  assert.equal(isCanonicalIsoUtc("2026-08-31T10:00:00Z"), false);
});
