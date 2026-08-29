// security/qrSign.js — HMAC for printed table/QR ordering links.
// Production must have a stable configured secret. An ephemeral in-memory
// key is allowed only in explicit non-production environments.
import crypto from "crypto";
import { safeEqual } from "./crypto.js";

const DEFAULT_TTL_MS = 5 * 365 * 24 * 60 * 60 * 1000;
const PRODUCTION_MIN_KEY_LENGTH = 32;

let _ephemeralKey = null;
let _warnedEphemeral = false;

export function isProductionEnv(env = process.env) {
  return String(env.NODE_ENV || "") === "production";
}

export function resolveQrSigningKey(env = process.env) {
  const qr = String(env.QR_SIGNING_KEY || "").trim();
  const enc = String(env.ENCRYPTION_KEY || "").trim();
  const configured = qr || enc;
  const source = qr ? "QR_SIGNING_KEY" : (enc ? "ENCRYPTION_KEY" : null);
  const production = isProductionEnv(env);
  if (configured) {
    if (production && configured.length < PRODUCTION_MIN_KEY_LENGTH) {
      return { ok: false, error: "qr_signing_key_too_short", source, ephemeral: false };
    }
    return { ok: true, source, ephemeral: false, configured: true };
  }
  if (production) {
    return { ok: false, error: "qr_signing_key_missing", source: null, ephemeral: false };
  }
  return { ok: true, source: "ephemeral", ephemeral: true, configured: false };
}

export function assertQrSigningConfigured(env = process.env) {
  const resolved = resolveQrSigningKey(env);
  if (!resolved.ok) {
    const err = new Error(
      resolved.error === "qr_signing_key_too_short"
        ? "Production QR signing key is too short. Set QR_SIGNING_KEY (preferred) or ENCRYPTION_KEY to at least 32 characters."
        : "Production QR signing requires QR_SIGNING_KEY (preferred) or ENCRYPTION_KEY. Refusing to start with an ephemeral key."
    );
    err.code = resolved.error;
    throw err;
  }
  if (resolved.ephemeral && !_warnedEphemeral) {
    _warnedEphemeral = true;
    console.warn(
      "[QR signing] Non-production ephemeral in-memory key in use. Printed QR codes will not survive restart or multiple instances. Set QR_SIGNING_KEY for stable signatures."
    );
  }
  return resolved;
}

export function qrSigningHealth(env = process.env) {
  const resolved = resolveQrSigningKey(env);
  if (!resolved.ok) {
    return { ok: false, qrSigning: resolved.error };
  }
  return {
    ok: true,
    qrSigning: resolved.ephemeral ? "ephemeral" : (resolved.source === "QR_SIGNING_KEY" ? "qr_signing_key" : "encryption_key"),
  };
}

export function resetQrSigningState() {
  _ephemeralKey = null;
  _warnedEphemeral = false;
}

function keyMaterial(env = process.env) {
  const resolved = resolveQrSigningKey(env);
  if (!resolved.ok) {
    const err = new Error(resolved.error);
    err.code = resolved.error;
    throw err;
  }
  if (!resolved.ephemeral) {
    return String(env.QR_SIGNING_KEY || env.ENCRYPTION_KEY || "").trim();
  }
  if (!_ephemeralKey) _ephemeralKey = crypto.randomBytes(32).toString("hex");
  return _ephemeralKey;
}

function payload({ restId, table, tableId, exp }) {
  return `${restId || ""}|${table || ""}|${tableId || ""}|${exp}`;
}

export function signQrParams({ restId, table, tableId, ttlMs = DEFAULT_TTL_MS }, env = process.env) {
  const exp = Date.now() + ttlMs;
  const sig = crypto.createHmac("sha256", keyMaterial(env)).update(payload({ restId, table, tableId, exp })).digest("hex");
  return { sig, exp };
}

export function verifyQrParams({ restId, table, tableId, sig, exp }, env = process.env) {
  if (!sig || !exp) return { valid: false, reason: "missing_signature" };
  if (Date.now() > Number(exp)) return { valid: false, reason: "expired" };
  let key;
  try {
    key = keyMaterial(env);
  } catch (err) {
    return { valid: false, reason: err.code || "qr_signing_key_missing" };
  }
  const expected = crypto.createHmac("sha256", key).update(payload({ restId, table, tableId, exp })).digest("hex");
  const valid = safeEqual(expected, String(sig));
  return { valid, reason: valid ? null : "invalid_signature" };
}
