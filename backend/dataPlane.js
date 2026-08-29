import { usePostgres } from "./pg/config.js";

const APPROVED_SYSTEM_ROOTS = new Set([
  "_healthPing", "_healthPingS1", "_healthPingS2", "_healthPingF",
  "activeSessions", "auditLogs", "backups", "broadcastHistory",
  "disabledDevices", "loginHistory", "paymeTxIndex", "paymentHistory",
  "platform", "platformUsers", "promoCodes", "securityLog", "settings",
  "twoFactorSuperAdmin",
]);

const TENANT_ROOTS = new Set(["restaurants", "restaurants_meta", "credentials"]);
const TOOLING_PURPOSES = new Set(["migration", "test", "tooling"]);

export function normalizeDataPath(path) {
  return String(path ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

export function classifyBackendDataPath(path, { purpose = "runtime" } = {}) {
  const normalized = normalizeDataPath(path);
  const segments = normalized ? normalized.split("/").filter(Boolean) : [];
  if (TOOLING_PURPOSES.has(purpose)) {
    return { kind: "tooling", allowedInPostgres: true, path: normalized, segments };
  }
  if (segments[0] === ".info") {
    return { kind: "firebase-info", allowedInPostgres: true, path: normalized, segments };
  }
  if (segments[0] === "systemData" && APPROVED_SYSTEM_ROOTS.has(segments[1])) {
    return { kind: "platform-infrastructure", allowedInPostgres: true, path: normalized, segments };
  }
  if (TENANT_ROOTS.has(segments[0])) {
    return { kind: "tenant", allowedInPostgres: false, path: normalized, segments };
  }
  return { kind: "unclassified", allowedInPostgres: false, path: normalized, segments };
}

export class FirebaseDataPlaneAccessError extends Error {
  constructor(path, kind) {
    super(`Firebase RTDB access is forbidden for ${kind} data while DATA_BACKEND=postgres`);
    this.name = "FirebaseDataPlaneAccessError";
    this.code = "FIREBASE_DATA_PLANE_FORBIDDEN";
    this.pathKind = kind;
    this.dataPath = normalizeDataPath(path);
  }
}

export function assertFirebaseDataPlaneAccess(path, options) {
  const classification = classifyBackendDataPath(path, options);
  if (usePostgres() && !classification.allowedInPostgres) {
    throw new FirebaseDataPlaneAccessError(classification.path, classification.kind);
  }
  return classification;
}

export function isTenantDataPath(path) {
  return classifyBackendDataPath(path).kind === "tenant";
}
