// security/crypto.js — at-rest encryption for secrets this app must store
// somewhere persistent (today: Firebase RTDB) but never wants readable as
// plain text even by someone with raw DB access — 2FA TOTP seeds, backup
// codes. Uses AES-256-GCM with a server-only key from process.env
// (ENCRYPTION_KEY, .env — never committed, never sent to any client).
//
// Backward compatible by construction: this module is new, nothing existing
// calls it, so there is no legacy plaintext format to migrate.
import crypto from "crypto";

const ALGO = "aes-256-gcm";

function getKey() {
  const raw = process.env.ENCRYPTION_KEY || "";
  if (!raw) {
    throw new Error(
      "ENCRYPTION_KEY is not set — required for any feature that stores a secret (2FA). " +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" and put it in backend/.env"
    );
  }
  // Accept a 64-char hex string (32 bytes) — documented in .env.example.
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : crypto.createHash("sha256").update(raw).digest();
  return key;
}

export function encryptSecret(plainText) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), enc.toString("base64"), tag.toString("base64")].join(".");
}

export function decryptSecret(payload) {
  const key = getKey();
  const [ivB64, encB64, tagB64] = String(payload || "").split(".");
  if (!ivB64 || !encB64 || !tagB64) throw new Error("Malformed encrypted payload");
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const dec = Buffer.concat([decipher.update(Buffer.from(encB64, "base64")), decipher.final()]);
  return dec.toString("utf8");
}

/** Timing-safe string compare (equal-length hex/base64 tokens, HMAC digests, etc.). */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ""), "utf8");
  const bufB = Buffer.from(String(b ?? ""), "utf8");
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal-length dummy buffers so the function's
    // timing doesn't leak the correct length either.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}
