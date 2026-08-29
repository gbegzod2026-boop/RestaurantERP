import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isCanonicalPlatformSuperAdmin } from "../../security/requireSuperAdmin.js";
import { isPgUnavailableError, tenantScopeDecision } from "../../pg/tenant.js";
import { tenantAuthorityDecision } from "../../rbac.js";

test("arbitrary unscoped Firebase account has no platform authority", () => {
  assert.equal(isCanonicalPlatformSuperAdmin({ uid: "ordinary-user", email: "admin@example.test" }), false);
  assert.equal(isCanonicalPlatformSuperAdmin({ uid: "ordinary-user", role: "superadmin", isSuperAdmin: true }), false);
});

test("server-owned platform claim grants only an unscoped token", () => {
  assert.equal(isCanonicalPlatformSuperAdmin({ uid: "root", platformSuperAdmin: true }), true);
  assert.equal(isCanonicalPlatformSuperAdmin({ uid: "root", platformSuperAdmin: true, restId: "tenant-a" }), false);
  assert.equal(isCanonicalPlatformSuperAdmin({ uid: "root", platformSuperAdmin: true, restaurantId: "tenant-a" }), false);
});

test("bootstrap allowlist is explicit and cannot override tenant scope", () => {
  const before = process.env.PLATFORM_SUPERADMIN_UIDS;
  process.env.PLATFORM_SUPERADMIN_UIDS = "root-a, root-b";
  try {
    assert.equal(isCanonicalPlatformSuperAdmin({ uid: "root-b" }), true);
    assert.equal(isCanonicalPlatformSuperAdmin({ uid: "root-b", restId: "tenant-a", isSuperAdmin: true }), false);
  } finally {
    if (before === undefined) delete process.env.PLATFORM_SUPERADMIN_UIDS;
    else process.env.PLATFORM_SUPERADMIN_UIDS = before;
  }
});

test("transient PostgreSQL connectivity failures map to unavailable", () => {
  assert.equal(isPgUnavailableError({ code: "ECONNREFUSED" }), true);
  assert.equal(isPgUnavailableError({ code: "57P03" }), true);
  assert.equal(isPgUnavailableError({ code: "23505" }), false);
});

test("tenant scope enforces 401, same-tenant access, and unconditional mismatch 403", () => {
  assert.equal(tenantScopeDecision({ verified: false }, "rest_1000000000001").status, 401);
  assert.deepEqual(tenantScopeDecision({ verified: true, restId: "rest_1000000000001" }, "rest_1000000000001"), { restId: "rest_1000000000001" });
  assert.equal(tenantScopeDecision({ verified: true, restId: "rest_1000000000001", isSuperAdmin: true }, "rest_2000000000002").status, 403);
  assert.deepEqual(
    tenantScopeDecision({ verified: true, restId: null, platformSuperAdmin: true }, "rest_1000000000001"),
    { restId: "rest_1000000000001", isSuperAdmin: true }
  );
  assert.equal(tenantScopeDecision({ verified: true, restId: null, platformSuperAdmin: true }, null).code, "token_missing_restId");
});

test("RBAC tenant routes require an exact verified tenant claim", () => {
  assert.equal(tenantAuthorityDecision({ verified: false }, "rest_1000000000001").status, 401);
  assert.deepEqual(tenantAuthorityDecision({ verified: true, restId: "rest_1000000000001" }, "rest_1000000000001"), { restId: "rest_1000000000001" });
  assert.equal(tenantAuthorityDecision({ verified: true, restId: "rest_2000000000002" }, "rest_1000000000001").status, 403);
  assert.deepEqual(tenantAuthorityDecision({ verified: true, restId: null, platformSuperAdmin: true }, "rest_1000000000001"), { restId: "rest_1000000000001" });
  assert.equal(tenantAuthorityDecision({ verified: true, restId: null, platformSuperAdmin: true }, null).status, 403);
});

test("tenant bridge has no request-controlled platform escalation", async () => {
  const source = await readFile(new URL("../../pg/tenant.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /req\.query\.platform/);
  assert.doesNotMatch(source, /readSuperAdminClaim/);
});

test("RTDB platform grants require canonical claim", async () => {
  const raw = await readFile(new URL("../../../database.rules.json", import.meta.url), "utf8");
  assert.doesNotMatch(raw, /auth\.token\.restId == null && auth\.token\.firebase\.sign_in_provider/);
  assert.match(raw, /auth\.token\.platformSuperAdmin == true/);
});

test("legacy admin and chef socket rooms use canonical token plus PostgreSQL authority", async () => {
  const source = await readFile(new URL("../../server.js", import.meta.url), "utf8");
  assert.match(source, /const token = data\.token \|\| socket\.handshake\?\.auth\?\.token/);
  assert.match(source, /authorizeSocketJoin\(\{ token, restId, userId:/);
  assert.match(source, /socket\.on\("chef:join"/);
  assert.match(source, /socket\.on\("admin-connect"/);
  assert.match(source, /revalidateLegacyStaffAuthority/);
  assert.match(source, /authorizeLegacyPrivilegedEmit/);
  assert.match(source, /leaveOperationalRooms\(socket\)/);
});
