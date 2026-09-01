// AUDIT-ONLY Railway live preflight artifact.
// PREFLIGHT.json must NEVER authorize the Step 2D.5 cutover window.
// Authorization is the in-process result of runRailwayLivePreflight().
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import {
  sanitizeLiveRailwayPreflightResult,
  validateClosedSchema,
  LIVE_RESULT_SCHEMA,
  isCanonicalIsoUtc,
  RAILWAY_PRODUCTION_PUBLIC_PROXY_HOST_CLASS,
} from "./runRailwayLivePreflight.mjs";

export const RAILWAY_PREFLIGHT_FILE = "PREFLIGHT.json";
export const RAILWAY_PREFLIGHT_AUDIT_KIND = "AUDIT_ONLY";
export const EVIDENCE_VERSION = 3;

export { RAILWAY_PRODUCTION_PUBLIC_PROXY_HOST_CLASS };

const AUDIT_SCHEMA = {
  type: "object",
  keys: {
    evidenceKind: { type: "string" },
    evidenceVersion: { type: "number" },
    usableForApproval: { type: "boolean" },
    generatedAt: { type: "string" },
    completedAt: { type: "string" },
    live: LIVE_RESULT_SCHEMA,
  },
};

export function buildRailwayLivePreflightAudit(liveResult, {
  generatedAt = new Date().toISOString(),
  completedAt = new Date().toISOString(),
} = {}) {
  const live = sanitizeLiveRailwayPreflightResult(liveResult);
  const doc = {
    evidenceKind: RAILWAY_PREFLIGHT_AUDIT_KIND,
    evidenceVersion: EVIDENCE_VERSION,
    usableForApproval: false,
    generatedAt,
    completedAt,
    live,
  };
  const schemaErr = validateClosedSchema(doc, AUDIT_SCHEMA);
  if (schemaErr) throw new Error(`refusing to write audit artifact: ${schemaErr}`);
  if (!isCanonicalIsoUtc(generatedAt) || !isCanonicalIsoUtc(completedAt)) {
    throw new Error("refusing to write audit artifact: timestamps must be canonical Date#toISOString UTC");
  }
  return doc;
}

export function writeRailwayLivePreflightAudit(repoRoot, liveResult, times = {}) {
  const generatedAt = times.generatedAt || new Date().toISOString();
  const completedAt = times.completedAt || new Date().toISOString();
  const doc = buildRailwayLivePreflightAudit(liveResult, { generatedAt, completedAt });
  const stamp = completedAt.replace(/[:.]/g, "-");
  const outDir = path.join(repoRoot, "cutover-backups", `railway-preflight-${stamp}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, RAILWAY_PREFLIGHT_FILE), JSON.stringify(doc, null, 2));
  return {
    fileClass: `cutover-backups/railway-preflight-*/${RAILWAY_PREFLIGHT_FILE}`,
    evidenceKind: RAILWAY_PREFLIGHT_AUDIT_KIND,
    usableForApproval: false,
    dir: outDir,
  };
}

/** Explicitly not an authorization API. Kept so accidental callers fail closed. */
export function resolveRailwayLivePreflightEvidence() {
  return {
    railwayLivePreflight: "NOT RUN",
    reason: "PREFLIGHT.json is audit-only and has zero authorization authority",
  };
}
