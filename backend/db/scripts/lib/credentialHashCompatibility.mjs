// Classify Firebase credentials/$restId/$uid password/passwordHash values
// against backend/security/password.js verifyPassword() acceptance paths.
// Never logs or returns the secret itself. Never stringifies objects/arrays.
import { hashPassword, isHashed } from "../../../security/password.js";

export const MALFORMED_SOURCE = Symbol("malformed-credential-source");

// bcryptjs / verifyPassword structural requirements:
// prefix $2a/$2b/$2y only, cost 4–31, 60-char alphabet, 53-char tail.
const BCRYPT_FULL_RE = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/;
const SHA256_LOWER_RE = /^[a-f0-9]{64}$/;
const SHA256_HEX_RE = /^[a-fA-F0-9]{64}$/;
const MD5_HEX_RE = /^[a-fA-F0-9]{32}$/;
const OTHER_HASH_RE = /^\$[a-z0-9]+/i;
const BCRYPT_MIN_COST = 4;
const BCRYPT_MAX_COST = 31;

function base(kind, extra = {}) {
  return {
    kind,
    loginCompatible: false,
    copyable: false,
    migratable: false,
    requiresReset: false,
    ...extra,
  };
}

export function classifyStoredPassword(stored) {
  if (stored == null) return base("empty");
  if (typeof stored !== "string") return base("incompatible-type");
  if (stored === MALFORMED_SOURCE) return base("incompatible-type");
  if (!stored) return base("empty");

  if (isHashed(stored)) {
    if (stored.length !== 60) return base("ambiguous-bcrypt-prefix");
    const matched = BCRYPT_FULL_RE.exec(stored);
    if (!matched) return base("ambiguous-bcrypt-prefix");
    const cost = Number(matched[1]);
    if (!Number.isInteger(cost) || cost < BCRYPT_MIN_COST || cost > BCRYPT_MAX_COST) {
      return base("bcrypt-cost-invalid");
    }
    return base("bcrypt", { loginCompatible: true, copyable: true, migratable: true });
  }

  if (OTHER_HASH_RE.test(stored) || stored.startsWith("$2")) {
    return base("incompatible-hash");
  }

  if (SHA256_LOWER_RE.test(stored)) {
    // verifyPassword() SHA path uses digest("hex") (lowercase) and also
    // accepts stored === submitted via the plaintext-equality branch, so
    // copying SHA into PostgreSQL would let the SHA string itself log in.
    return base("sha256", { loginCompatible: true, requiresReset: true });
  }
  if (SHA256_HEX_RE.test(stored)) {
    return base("sha256-uppercase");
  }
  if (MD5_HEX_RE.test(stored)) {
    return base("ambiguous-md5-hex");
  }
  if (stored.length > 64) {
    return base("ambiguous-long-secret");
  }
  return base("plaintext", { loginCompatible: true, migratable: true });
}

function firstCredentialField(record, keys) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const raw = record[key];
    if (raw == null || raw === "") continue;
    if (typeof raw !== "string") return MALFORMED_SOURCE;
    return raw;
  }
  return null;
}

export function sourceHashValue(record) {
  return firstCredentialField(record, ["password", "passwordHash"]);
}

export function sourceEncValue(record) {
  return firstCredentialField(record, ["passwordEnc"]);
}

export function isMalformedSource(value) {
  return value === MALFORMED_SOURCE;
}

export async function materializeMigratableHash(classified, sourceValue) {
  if (!classified?.migratable || typeof sourceValue !== "string" || !sourceValue) return null;
  if (classified.kind === "bcrypt") return sourceValue;
  if (classified.kind === "plaintext") return hashPassword(sourceValue);
  return null;
}
