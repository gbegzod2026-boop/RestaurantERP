// security/password.js

import bcrypt from "bcryptjs";
import crypto from "crypto";

const BCRYPT_ROUNDS = 10;

// bcrypt format:
// $2a$10$...
// $2b$10$...
// $2y$10$...
const BCRYPT_PREFIX_RE = /^\$2[aby]\$\d{2}\$/;

export function isHashed(value) {
    return typeof value === "string" && BCRYPT_PREFIX_RE.test(value);
}

export async function hashPassword(plain) {
    return bcrypt.hash(String(plain ?? ""), BCRYPT_ROUNDS);
}

/**
 * Verifies password against:
 * 1. bcrypt hash
 * 2. legacy plaintext
 * 3. legacy SHA-256
 *
 * Returns:
 * { ok: boolean, migratedHash?: string }
 */
export async function verifyPassword(plain, stored) {
    const plainStr = String(plain ?? "");
    const storedStr = String(stored ?? "");

    if (!plainStr || !storedStr) {
        return { ok: false };
    }

    // ============================================
    // 1. BCRYPT
    // ============================================

    if (isHashed(storedStr)) {
        const ok = await bcrypt.compare(
            plainStr,
            storedStr
        );

        return { ok };
    }

    // ============================================
    // 2. LEGACY PLAINTEXT
    // ============================================

    if (plainStr === storedStr) {
        return {
            ok: true,
            migratedHash: await hashPassword(plainStr)
        };
    }

    // ============================================
    // 3. LEGACY SHA-256
    // ============================================

    const sha256 = crypto
        .createHash("sha256")
        .update(plainStr)
        .digest("hex");

    if (sha256 === storedStr) {
        return {
            ok: true,
            migratedHash: await hashPassword(plainStr)
        };
    }

    return {
        ok: false
    };
}