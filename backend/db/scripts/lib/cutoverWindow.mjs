// Current cutover-window identity and evidence binding.
//
// Trust boundary: unsigned local WRITE_STOP.json / FREEZE.json are not
// tamper-proof against a malicious filesystem operator. SHA-256 identity
// is a deterministic binding hash of public revision fields, not a
// cryptographic signature. The goal is fail-closed protection against
// stale or accidental cross-window reuse.
//
// The gate always recomputes the expected identity in memory. An identity
// string copied from an artifact has zero authority by itself.
import { createHash } from "crypto";
import { readdirSync, existsSync, readFileSync } from "fs";
import path from "path";
import {
  CUTOVER_CANDIDATE_TAG,
  REVIEWED_CUTOVER_PURPOSE,
  REVIEWED_CUTOVER_APPROVAL_VERSION,
} from "./deployFreeze.mjs";
import {
  sanitizeRevisionSha,
  REQUIRED_PRODUCTION_PROBE_ORIGIN,
} from "./deployedRevision.mjs";
const CANONICAL_ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isCanonicalIsoUtc(value) {
  if (typeof value !== "string" || !CANONICAL_ISO_UTC_RE.test(value)) return false;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;
  return new Date(ms).toISOString() === value;
}

export const CUTOVER_EVIDENCE_VERSION = 1;
/**
 * Maximum age of WRITE_STOP.json / FREEZE.json for the current window.
 * After 60 minutes both artifacts expire. The operator must rerun
 * write-stop, then freeze snapshot, then the final gate. TTL does not
 * auto-extend.
 */
export const CUTOVER_EVIDENCE_TTL_MS = 60 * 60 * 1000;
/** Allowed future clock skew for evidence generatedAt. */
export const CUTOVER_CLOCK_SKEW_MS = 60_000;
export const CUTOVER_WINDOW_IDENTITY_RE = /^[a-f0-9]{64}$/;

export const WRITE_STOP_EVIDENCE_KEYS = Object.freeze([
  "evidenceVersion",
  "generatedAt",
  "productionWriteStop",
  "maintenance",
  "writeObserved",
  "tenantWriteBlocked",
  "clickBlocked",
  "paymeBlocked",
  "uzumBlocked",
  "origin",
  "candidateCommit",
  "cutoverWindowIdentity",
]);

export const FREEZE_EVIDENCE_KEYS = Object.freeze([
  "evidenceVersion",
  "generatedAt",
  "freezeWindow",
  "mode",
  "firebaseProject",
  "counts",
  "candidateCommit",
  "cutoverWindowIdentity",
]);

export const FREEZE_COUNT_KEYS = Object.freeze([
  "restaurants",
  "users",
  "employees",
  "orders",
  "orderItems",
  "payments",
  "menu",
  "tables",
  "customers",
  "credentialTrees",
  "customRoles",
  "platformPromoCodes",
]);

export function canonicalFreezeCounts(values) {
  if (!freezeCountsClosed(values)) {
    throw new Error("FREEZE_COUNTS_INCOMPLETE");
  }
  const out = {};
  for (const k of FREEZE_COUNT_KEYS) out[k] = values[k];
  return out;
}

export function canonicalWindowBindingString({
  candidateCommit,
  remoteMain,
  deployedRevision,
} = {}) {
  const a = sanitizeRevisionSha(candidateCommit);
  const b = sanitizeRevisionSha(remoteMain);
  const c = sanitizeRevisionSha(deployedRevision);
  if (!a || !b || !c || a !== b || a !== c) return null;
  return JSON.stringify({
    purpose: REVIEWED_CUTOVER_PURPOSE,
    version: REVIEWED_CUTOVER_APPROVAL_VERSION,
    candidateTag: CUTOVER_CANDIDATE_TAG,
    candidateCommit: a,
    remoteMain: b,
    deployedRevision: c,
    productionOrigin: REQUIRED_PRODUCTION_PROBE_ORIGIN,
  });
}

export function computeCutoverWindowIdentity(input = {}) {
  const canonical = canonicalWindowBindingString(input);
  if (!canonical) return null;
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function exactKeys(obj, keys) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const actual = Object.keys(obj);
  if (actual.length !== keys.length) return false;
  return keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k));
}

function timestampInWindow(value, now, { ttlMs = CUTOVER_EVIDENCE_TTL_MS, skewMs = CUTOVER_CLOCK_SKEW_MS } = {}) {
  if (!isCanonicalIsoUtc(value)) return { ok: false, reason: value == null ? "missing-timestamp" : "malformed-timestamp" };
  const ms = Date.parse(value);
  if (ms > now + skewMs) return { ok: false, reason: "future-timestamp" };
  if (ms < now - ttlMs) return { ok: false, reason: "stale-timestamp" };
  return { ok: true, reason: null, ms };
}

export function buildWriteStopEvidence({
  classified,
  generatedAt,
  origin,
  candidateCommit,
  cutoverWindowIdentity,
} = {}) {
  return {
    evidenceVersion: CUTOVER_EVIDENCE_VERSION,
    generatedAt,
    productionWriteStop: classified?.productionWriteStop === "PASS" ? "PASS" : (classified?.productionWriteStop || "FAIL"),
    maintenance: classified?.maintenance === "ON" || classified?.maintenance === true ? "ON" : "OFF",
    writeObserved: classified?.writeObserved === true,
    tenantWriteBlocked: classified?.tenantWriteBlocked === true,
    clickBlocked: classified?.clickBlocked === true,
    paymeBlocked: classified?.paymeBlocked === true,
    uzumBlocked: classified?.uzumBlocked === true,
    origin,
    candidateCommit,
    cutoverWindowIdentity,
  };
}

export function evaluateWriteStopEvidence(doc, {
  expectedIdentity,
  expectedCommit,
  now = Date.now(),
  ttlMs = CUTOVER_EVIDENCE_TTL_MS,
  skewMs = CUTOVER_CLOCK_SKEW_MS,
} = {}) {
  const fail = (reason) => ({ ok: false, reason, productionWriteStop: "FAIL" });
  const identity = CUTOVER_WINDOW_IDENTITY_RE.test(expectedIdentity || "") ? expectedIdentity : null;
  const commit = sanitizeRevisionSha(expectedCommit);
  if (!identity || !commit) return fail("window-identity-uncomputed");
  if (!exactKeys(doc, WRITE_STOP_EVIDENCE_KEYS)) return fail("schema");
  if (doc.evidenceVersion !== CUTOVER_EVIDENCE_VERSION) return fail("schema");
  const ts = timestampInWindow(doc.generatedAt, now, { ttlMs, skewMs });
  if (!ts.ok) return fail(ts.reason);
  if (doc.productionWriteStop !== "PASS") return fail("status");
  if (doc.maintenance !== "ON") return fail("maintenance");
  if (doc.writeObserved !== false) return fail("write-observed");
  if (doc.tenantWriteBlocked !== true) return fail("tenant");
  if (doc.clickBlocked !== true) return fail("click");
  if (doc.paymeBlocked !== true) return fail("payme");
  if (doc.uzumBlocked !== true) return fail("uzum");
  if (doc.origin !== REQUIRED_PRODUCTION_PROBE_ORIGIN) return fail("origin");
  if (doc.candidateCommit !== commit) return fail("candidate-commit");
  if (doc.cutoverWindowIdentity !== identity) return fail("window-identity");
  return { ok: true, reason: null, productionWriteStop: "PASS", generatedAt: doc.generatedAt, generatedMs: ts.ms };
}

export function freezeCountsClosed(counts) {
  if (!exactKeys(counts, FREEZE_COUNT_KEYS)) return false;
  return FREEZE_COUNT_KEYS.every((k) => {
    const n = counts[k];
    return typeof n === "number" && Number.isInteger(n) && n >= 0;
  });
}

export function buildFreezeEvidence({
  generatedAt,
  firebaseProject,
  counts,
  candidateCommit,
  cutoverWindowIdentity,
} = {}) {
  const closedCounts = {};
  for (const k of FREEZE_COUNT_KEYS) closedCounts[k] = counts?.[k];
  return {
    evidenceVersion: CUTOVER_EVIDENCE_VERSION,
    generatedAt,
    freezeWindow: true,
    mode: "READ-ONLY",
    firebaseProject,
    counts: closedCounts,
    candidateCommit,
    cutoverWindowIdentity,
  };
}

export function evaluateFreezeEvidence(doc, {
  expectedIdentity,
  expectedCommit,
  writeStopGeneratedAt,
  livePreflightCompletedAt,
  now = Date.now(),
  ttlMs = CUTOVER_EVIDENCE_TTL_MS,
  skewMs = CUTOVER_CLOCK_SKEW_MS,
} = {}) {
  const fail = (reason) => ({ ok: false, reason });
  const identity = CUTOVER_WINDOW_IDENTITY_RE.test(expectedIdentity || "") ? expectedIdentity : null;
  const commit = sanitizeRevisionSha(expectedCommit);
  if (!identity || !commit) return fail("window-identity-uncomputed");
  if (!exactKeys(doc, FREEZE_EVIDENCE_KEYS)) return fail("schema");
  if (doc.evidenceVersion !== CUTOVER_EVIDENCE_VERSION) return fail("schema");
  if (doc.freezeWindow !== true || doc.mode !== "READ-ONLY") return fail("mode");
  if (doc.firebaseProject !== "restoran-30d51") return fail("firebase-project");
  if (!freezeCountsClosed(doc.counts)) return fail("counts");
  const ts = timestampInWindow(doc.generatedAt, now, { ttlMs, skewMs });
  if (!ts.ok) return fail(ts.reason);
  if (doc.candidateCommit !== commit) return fail("candidate-commit");
  if (doc.cutoverWindowIdentity !== identity) return fail("window-identity");
  if (!isCanonicalIsoUtc(writeStopGeneratedAt)) return fail("write-stop-timestamp");
  const writeMs = Date.parse(writeStopGeneratedAt);
  if (ts.ms < writeMs) return fail("ordering");
  if (livePreflightCompletedAt != null) {
    if (!isCanonicalIsoUtc(livePreflightCompletedAt)) return fail("preflight-timestamp");
    if (ts.ms > Date.parse(livePreflightCompletedAt)) return fail("ordering");
  }
  return { ok: true, reason: null, generatedAt: doc.generatedAt, generatedMs: ts.ms };
}

function walkNamedFiles(repoRoot, fileName) {
  const root = path.join(repoRoot, "cutover-backups");
  if (!existsSync(root)) return [];
  const files = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && ent.name === fileName) files.push(full);
    }
  };
  walk(root);
  return files;
}

/**
 * Select the newest semantically valid current-window WRITE_STOP.json by
 * generatedAt. Directory names have no security significance. A later
 * malformed artifact does not hide an earlier valid one.
 */
export function currentWriteStopBinding(repoRoot, {
  now = Date.now(),
  expectedIdentity = null,
  expectedCommit = null,
} = {}) {
  if (!expectedIdentity || !expectedCommit) {
    return { ok: false, reason: "window identity required; latest WRITE_STOP.json is not authoritative" };
  }
  const valid = [];
  for (const file of walkNamedFiles(repoRoot, "WRITE_STOP.json")) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const ev = evaluateWriteStopEvidence(doc, { expectedIdentity, expectedCommit, now });
    if (!ev.ok) continue;
    valid.push({ file, doc, generatedMs: ev.generatedMs });
  }
  valid.sort((a, b) => b.generatedMs - a.generatedMs);
  if (valid.length === 0) return { ok: false, reason: "no write-stop evidence bound to the current window" };
  const current = valid[0];
  return { ok: true, file: current.file, doc: current.doc, writeStopGeneratedAt: current.doc.generatedAt };
}
