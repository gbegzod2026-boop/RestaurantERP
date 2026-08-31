// Fail-closed Railway live preflight evidence.
// Never stores passwords, connection URLs, or tokens. Never treats
// DATABASE_PUBLIC_URL presence as PASS.
import { mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync } from "fs";
import path from "path";
import { REQUIRED_SCHEMA_VERSION } from "./migrationTargetGuard.mjs";

export const RAILWAY_PREFLIGHT_PREFIX = "railway-preflight-";
export const RAILWAY_PREFLIGHT_FILE = "PREFLIGHT.json";
export const RAILWAY_PREFLIGHT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const REQUIRED_PREFLIGHT_RLS_TABLES = [
  "restaurants",
  "employees",
  "orders",
  "order_items",
  "payments",
  "custom_roles",
];

const URLISH = /postgres(?:ql)?:\/\/[^\s*]+:[^@\s]+@/gi;

export function redactPreflightText(value) {
  return String(value || "")
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://***")
    .replace(/PGPASSWORD=\S+/gi, "PGPASSWORD=***")
    .replace(/DATABASE_(?:PUBLIC_|PRIVATE_)?URL=\S+/gi, "DATABASE_URL=***");
}

function isIsoTime(value) {
  if (typeof value !== "string" || !value) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

function rlsOk(rows) {
  if (!Array.isArray(rows) || rows.length < REQUIRED_PREFLIGHT_RLS_TABLES.length) return false;
  return REQUIRED_PREFLIGHT_RLS_TABLES.every((name) => {
    const row = rows.find((r) => r && r.table === name);
    return row?.rls === true && row?.force_rls === true;
  });
}

function uniquesOk(rows) {
  if (!Array.isArray(rows) || rows.length < 1) return false;
  return rows.every((r) => r && r.ok === true);
}

function latestMigrationVersion(doc) {
  const latest = doc?.latestMigration;
  if (latest && typeof latest === "object") return latest.version;
  return null;
}

export function sanitizeRailwayLivePreflightEvidence(raw = {}, { generatedAt = new Date().toISOString() } = {}) {
  const failures = Array.isArray(raw.failures)
    ? raw.failures.map((f) => redactPreflightText(f)).filter(Boolean)
    : [];
  return {
    generatedAt,
    mode: raw.mode === "READ-ONLY" ? "READ-ONLY" : String(raw.mode || ""),
    verdict: raw.verdict === "GO" || raw.verdict === "NO-GO" ? raw.verdict : "NO-GO",
    hostClass: typeof raw.hostClass === "string" ? raw.hostClass : null,
    database: typeof raw.database === "string" ? raw.database : null,
    sslLive: raw.sslLive == null ? null : String(raw.sslLive),
    pgcrypto: raw.pgcrypto === true,
    latestMigration: (() => {
      const ver = latestMigrationVersion(raw) || (typeof raw.latestMigration === "string" ? raw.latestMigration : null);
      return ver ? { version: String(ver) } : null;
    })(),
    restaurants: Number.isFinite(Number(raw.restaurants)) ? Number(raw.restaurants) : null,
    fixtureLike: Number.isFinite(Number(raw.fixtureLike)) ? Number(raw.fixtureLike) : null,
    rls: Array.isArray(raw.rls)
      ? raw.rls.map((row) => ({
        table: String(row?.table || ""),
        rls: row?.rls === true,
        force_rls: row?.force_rls === true,
      }))
      : [],
    requiredUniques: Array.isArray(raw.requiredUniques)
      ? raw.requiredUniques.map((row) => ({
        table: String(row?.table || ""),
        cols: Array.isArray(row?.cols) ? row.cols.map(String) : [],
        ok: row?.ok === true,
      }))
      : [],
    failures,
    readOnly: true,
  };
}

export function evidenceContainsSecrets(doc) {
  const blob = JSON.stringify(doc || {});
  URLISH.lastIndex = 0;
  if (URLISH.test(blob)) return true;
  URLISH.lastIndex = 0;
  return /PGPASSWORD=\S+/i.test(blob);
}

export function evaluateRailwayLivePreflightEvidence(doc, {
  now = Date.now(),
  maxAgeMs = RAILWAY_PREFLIGHT_MAX_AGE_MS,
  notBefore = null,
  env = {},
} = {}) {
  const urlPresent = Boolean(String(env.DATABASE_PUBLIC_URL || "").trim());
  if (doc == null || doc === undefined) {
    return {
      railwayLivePreflight: "NOT RUN",
      reason: urlPresent
        ? "DATABASE_PUBLIC_URL is set but no gitignored PREFLIGHT.json evidence exists"
        : "no railway-preflight evidence artifact",
    };
  }
  if (doc.__malformed === true) {
    return { railwayLivePreflight: "FAIL", reason: "malformed evidence (unparseable JSON)" };
  }
  if (typeof doc !== "object" || Array.isArray(doc)) {
    return { railwayLivePreflight: "FAIL", reason: "malformed evidence (not an object)" };
  }
  if (evidenceContainsSecrets(doc)) {
    return { railwayLivePreflight: "FAIL", reason: "evidence contains secret material" };
  }
  if (doc.mode !== "READ-ONLY" || doc.readOnly !== true) {
    return { railwayLivePreflight: "FAIL", reason: "malformed evidence (mode must be READ-ONLY)" };
  }
  if (!isIsoTime(doc.generatedAt)) {
    return { railwayLivePreflight: "FAIL", reason: "malformed evidence (generatedAt)" };
  }
  const generatedMs = Date.parse(doc.generatedAt);
  if (generatedMs > now + 60_000) {
    return { railwayLivePreflight: "FAIL", reason: "malformed evidence (generatedAt in the future)" };
  }
  if (now - generatedMs > maxAgeMs) {
    return { railwayLivePreflight: "NOT VERIFIED", reason: "stale railway live preflight evidence" };
  }
  if (notBefore) {
    const floor = Date.parse(notBefore);
    if (Number.isFinite(floor) && generatedMs + 1000 < floor) {
      return { railwayLivePreflight: "NOT VERIFIED", reason: "preflight evidence is older than the freeze-time snapshot" };
    }
  }
  if (doc.verdict === "NO-GO") {
    return { railwayLivePreflight: "FAIL", reason: "latest preflight verdict is NO-GO" };
  }
  if (doc.verdict !== "GO") {
    return { railwayLivePreflight: "FAIL", reason: "malformed evidence (verdict)" };
  }
  if (String(doc.sslLive).toLowerCase() !== "on") {
    return { railwayLivePreflight: "FAIL", reason: "sslLive is not on" };
  }
  if (latestMigrationVersion(doc) !== REQUIRED_SCHEMA_VERSION) {
    return { railwayLivePreflight: "FAIL", reason: `latestMigration.version is not ${REQUIRED_SCHEMA_VERSION}` };
  }
  if (doc.restaurants !== 0) {
    return { railwayLivePreflight: "FAIL", reason: "restaurants is not 0" };
  }
  if (doc.fixtureLike !== 0) {
    return { railwayLivePreflight: "FAIL", reason: "fixtureLike is not 0" };
  }
  if (!uniquesOk(doc.requiredUniques)) {
    return { railwayLivePreflight: "FAIL", reason: "required uniques are not all ok" };
  }
  if (!rlsOk(doc.rls)) {
    return { railwayLivePreflight: "FAIL", reason: "required RLS/FORCE RLS checks are not true" };
  }
  if (typeof doc.hostClass !== "string" || !doc.hostClass || doc.hostClass.includes("127.") || /localhost/i.test(doc.hostClass)) {
    return { railwayLivePreflight: "FAIL", reason: "hostClass is not a production Railway class" };
  }
  return { railwayLivePreflight: "GO", reason: "fresh READ-ONLY GO evidence" };
}

export function writeRailwayLivePreflightEvidence(repoRoot, raw, { generatedAt } = {}) {
  const doc = sanitizeRailwayLivePreflightEvidence(raw, { generatedAt });
  const stamp = String(doc.generatedAt).replace(/[:.]/g, "-");
  const outDir = path.join(repoRoot, "cutover-backups", `${RAILWAY_PREFLIGHT_PREFIX}${stamp}`);
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, RAILWAY_PREFLIGHT_FILE);
  writeFileSync(file, JSON.stringify(doc, null, 2));
  return { dirClass: `cutover-backups/${RAILWAY_PREFLIGHT_PREFIX}*/${RAILWAY_PREFLIGHT_FILE}`, generatedAt: doc.generatedAt };
}

export function loadLatestRailwayLivePreflightEvidence(repoRoot) {
  const root = path.join(repoRoot, "cutover-backups");
  if (!existsSync(root)) return null;
  const names = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(RAILWAY_PREFLIGHT_PREFIX))
    .map((e) => e.name)
    .sort();
  const last = names.at(-1);
  if (!last) return null;
  const file = path.join(root, last, RAILWAY_PREFLIGHT_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { __malformed: true };
  }
}
