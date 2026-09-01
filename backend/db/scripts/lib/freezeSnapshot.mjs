import { readdirSync, existsSync, readFileSync } from "fs";
import path from "path";
import {
  evaluateFreezeEvidence,
  isCanonicalIsoUtc,
  freezeCountsClosed,
} from "./cutoverWindow.mjs";

export { isCanonicalIsoUtc, isCanonicalIsoUtc as isValidIsoTimestamp };
export const EXPECTED_FIREBASE_PROJECT = "restoran-30d51";
/** Allowed future skew for freeze generatedAt. Documented bound used by the cutover gate. */
export const FREEZE_CLOCK_SKEW_MS = 60_000;

export function freezeSnapshotComplete(doc) {
  if (!doc || doc.freezeWindow !== true || doc.mode !== "READ-ONLY") return false;
  if (doc.firebaseProject !== EXPECTED_FIREBASE_PROJECT) return false;
  return freezeCountsClosed(doc.counts);
}

/**
 * Fail-closed freeze for Step 2D.5. Requires current-window identity,
 * candidate commit, freshness TTL, and write-stop ordering when provided.
 * Unsigned local JSON is not tamper-proof; this rejects stale/cross-window reuse.
 */
export function freezeSnapshotValidForCutoverWindow(doc, {
  now = Date.now(),
  clockSkewMs = FREEZE_CLOCK_SKEW_MS,
  expectedIdentity = null,
  expectedCommit = null,
  writeStopGeneratedAt = null,
  livePreflightCompletedAt = null,
} = {}) {
  const r = evaluateFreezeEvidence(doc, {
    expectedIdentity,
    expectedCommit,
    writeStopGeneratedAt,
    livePreflightCompletedAt,
    now,
    skewMs: clockSkewMs,
  });
  return r.ok === true;
}

export function currentFreezeBinding(repoRoot, {
  now = Date.now(),
  expectedIdentity = null,
  expectedCommit = null,
  writeStopGeneratedAt = null,
  livePreflightCompletedAt = null,
} = {}) {
  if (!expectedIdentity || !expectedCommit) {
    return { ok: false, reason: "window identity required; latest FREEZE.json is not authoritative" };
  }
  const root = path.join(repoRoot, "cutover-backups");
  if (!existsSync(root)) return { ok: false, reason: "no freeze snapshot bound to the current window" };
  const files = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && ent.name === "FREEZE.json") files.push(full);
    }
  };
  walk(root);
  const valid = [];
  for (const file of files) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (!freezeSnapshotValidForCutoverWindow(doc, {
      now,
      expectedIdentity,
      expectedCommit,
      writeStopGeneratedAt,
      livePreflightCompletedAt,
    })) continue;
    valid.push({ file, doc, generatedMs: Date.parse(doc.generatedAt) });
  }
  valid.sort((a, b) => b.generatedMs - a.generatedMs);
  if (valid.length === 0) return { ok: false, reason: "no freeze snapshot bound to the current window" };
  const current = valid[0];
  return { ok: true, file: current.file, doc: current.doc, freezeGeneratedAt: current.doc.generatedAt };
}
