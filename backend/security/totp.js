// security/totp.js — server-side TOTP (RFC 6238) + backup codes.
// Used by routes/twoFactor.js (restaurant owner/admin/manager optional 2FA)
// and routes/auth.js's verify2FA() (login-time check), and by
// routes/superadmin2fa.js (Superadmin/platform-user 2FA — Security Center).
// Hand-rolled on Node's built-in crypto module — no new npm dependency,
// same convention as security/crypto.js's AES-GCM.
import crypto from "crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buffer) {
  let bits = "";
  for (const byte of buffer) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  const rem = bits.length % 5;
  if (rem) {
    out += BASE32_ALPHABET[parseInt(bits.slice(bits.length - rem).padEnd(5, "0"), 2)];
  }
  return out;
}

function base32Decode(base32) {
  const clean = String(base32 || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/** New random 20-byte (160-bit) secret, base32-encoded — standard TOTP
 *  secret size (same as most authenticator apps generate/expect). */
export function generateBase32Secret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretBuffer, counter) {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", secretBuffer).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

/** Validates a 6-digit code against `secretBase32` for the current 30s
 *  step, allowing ±`window` steps of clock drift. Returns true/false. */
export function verifyTotpCode(secretBase32, code, window = 1) {
  const clean = String(code || "").trim();
  if (!/^\d{6}$/.test(clean)) return false;
  const secretBuffer = base32Decode(secretBase32);
  if (!secretBuffer.length) return false;
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let errorWindow = -window; errorWindow <= window; errorWindow++) {
    const candidate = hotp(secretBuffer, counter + errorWindow);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(clean))) return true;
  }
  return false;
}

/** otpauth:// URI for QR-code rendering during setup. */
export function buildOtpAuthUri({ secretBase32, accountLabel, issuer = "Nesta ERP" }) {
  const encodedLabel = encodeURIComponent(`${issuer}:${accountLabel}`);
  return `otpauth://totp/${encodedLabel}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/** 10 single-use recovery codes (8 uppercase alphanumeric chars each,
 *  Crockford-ish alphabet minus visually-ambiguous 0/O/1/I/L) — shown once
 *  at enable time, stored only as sha256Hex hashes (security/crypto.js),
 *  never in plaintext. */
export function generateBackupCodes(count = 10) {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const codes = [];
  for (let i = 0; i < count; i++) {
    let code = "";
    const bytes = crypto.randomBytes(8);
    for (let j = 0; j < 8; j++) code += alphabet[bytes[j] % alphabet.length];
    codes.push(code);
  }
  return codes;
}
