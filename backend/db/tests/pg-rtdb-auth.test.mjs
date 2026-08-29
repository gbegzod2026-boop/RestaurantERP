import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { canonicalizeRestId, parseCompositeUid, resolveActingRestId } from "../../pg/restId.js";
import { createRequirePgTenant, tenantScopeDecision } from "../../pg/tenant.js";
import { authorizeRtdbPath } from "../../pg/rtdbAuthz.js";
import { isCanonicalPlatformSuperAdmin } from "../../security/requireSuperAdmin.js";

async function request(handler, { headers = {}, method = "GET", body, query = "" } = {}) {
  const app = express();
  app.use(express.json());
  app.post("/rtdb", handler, (_req, res) => res.json({ ok: true, restId: _req.pgTenant?.restId, isSuperAdmin: _req.pgTenant?.isSuperAdmin }));
  app.get("/probe", handler, (_req, res) => res.json({ ok: true, restId: _req.pgTenant?.restId, isSuperAdmin: _req.pgTenant?.isSuperAdmin }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}${method === "POST" ? "/rtdb" : "/probe"}${query}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
    await once(server, "close");
  }
}

function tenantMw(identity, restaurant = { id: "uuid-a", legacy_rtdb_id: "rest_1784740340104" }) {
  return createRequirePgTenant({
    resolveIdentityFn: async () => identity,
    lookupRestaurantFn: async (restId) => (restId === restaurant.legacy_rtdb_id ? restaurant : null),
  });
}

test("legacy composite uid canonicalizes to restaurant restId", () => {
  assert.equal(canonicalizeRestId("rest_s1a_123__admin_1"), null);
  assert.equal(canonicalizeRestId("rest_1784740340104__admin_1"), "rest_1784740340104");
  assert.equal(canonicalizeRestId("rest_1784740340104"), "rest_1784740340104");
  assert.deepEqual(parseCompositeUid("rest_1784740340104__admin_1"), { restId: "rest_1784740340104", userId: "admin_1" });
  assert.equal(resolveActingRestId({ tokenRestId: "rest_1784740340104__admin_1" }), "rest_1784740340104");
  assert.equal(resolveActingRestId({ uid: "rest_1784740340104__chef_2" }), "rest_1784740340104");
  assert.equal(resolveActingRestId({
    tokenRestId: "rest_1000000000001",
    requestedRestId: "rest_2000000000002",
    platformSuperAdmin: false,
  }), "rest_1000000000001");
  assert.equal(resolveActingRestId({
    tokenRestId: null,
    requestedRestId: "rest_2000000000002",
    platformSuperAdmin: true,
  }), "rest_2000000000002");
});

test("missing token is 401 token_missing", async () => {
  const result = await request(tenantMw({ verified: false, tokenError: "token_missing" }));
  assert.equal(result.status, 401);
  assert.equal(result.body.code, "token_missing");
});

test("invalid token is 401 token_invalid", async () => {
  const result = await request(tenantMw({ verified: false, tokenError: "token_invalid" }));
  assert.equal(result.status, 401);
  assert.equal(result.body.code, "token_invalid");
});

test("admin own tenant GET is allowed", async () => {
  const mw = tenantMw({ verified: true, userId: "admin_1", restId: "rest_1784740340104", role: "admin" });
  const result = await request(mw, { headers: { "x-rest-id": "rest_1784740340104" } });
  assert.equal(result.status, 200);
  assert.equal(result.body.restId, "rest_1784740340104");
  assert.equal(result.body.isSuperAdmin, false);
});

test("selector absence falls back to verified token tenant", async () => {
  const mw = tenantMw({ verified: true, userId: "admin_1", restId: "rest_1784740340104", role: "admin" });
  const result = await request(mw);
  assert.equal(result.status, 200);
  assert.equal(result.body.restId, "rest_1784740340104");
});

test("explicit empty selector from header, body, query, and path is restId_invalid", async () => {
  const identity = { verified: true, userId: "admin_1", restId: "rest_1784740340104", role: "admin" };
  const cases = [
    { headers: { "x-rest-id": "" } },
    { method: "POST", body: { restId: "" } },
    { query: "?restId=" },
    { method: "POST", body: { path: "restaurants//orders" } },
  ];
  for (const options of cases) {
    const result = await request(tenantMw(identity), options);
    assert.equal(result.status, 400, JSON.stringify(options));
    assert.equal(result.body.code, "restId_invalid", JSON.stringify(options));
  }
});

test("legacy composite x-rest-id still maps to own tenant", async () => {
  const mw = tenantMw({ verified: true, userId: "admin_1", restId: "rest_1784740340104__admin_1", role: "admin", uid: "rest_1784740340104__admin_1" });
  const result = await request(mw, { headers: { "x-rest-id": "rest_1784740340104__admin_1" } });
  assert.equal(result.status, 200);
  assert.equal(result.body.restId, "rest_1784740340104");
});

test("admin foreign tenant GET is 403 restId_mismatch", async () => {
  const mw = tenantMw({ verified: true, userId: "admin_1", restId: "rest_1784740340104", role: "admin" });
  const result = await request(mw, { headers: { "x-rest-id": "rest_9999999999999" } });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, "restId_mismatch");
});

test("malformed restId spoof is rejected not treated as identity", async () => {
  const mw = tenantMw({ verified: true, userId: "admin_1", restId: "rest_1784740340104", role: "admin" });
  const result = await request(mw, { headers: { "x-rest-id": "rest_1784740340104/../rest_other" } });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, "restId_invalid");
});

test("waiter settings write is role_denied", async () => {
  const decision = await authorizeRtdbPath(
    { restId: "rest_1784740340104", userId: "w1", role: "waiter", isSuperAdmin: false },
    "restaurants/rest_1784740340104/settings",
    "write",
    { resolvePerms: async () => ({ role: "waiter", modules: ["orders", "tables"], actions: { orders: ["view", "edit"], tables: ["view", "edit"] } }) }
  );
  assert.equal(decision.code, "role_denied");
  assert.equal(decision.status, 403);
});

test("admin own tenant allowed write is permitted", async () => {
  const decision = await authorizeRtdbPath(
    { restId: "rest_1784740340104", userId: "admin_1", role: "admin", isSuperAdmin: false },
    "restaurants/rest_1784740340104/settings",
    "write",
    { resolvePerms: async () => ({ role: "admin", modules: null, actions: null }) }
  );
  assert.equal(decision.ok, true);
});

test("tenant admin cannot write platform-owned restaurant info", async () => {
  const decision = await authorizeRtdbPath(
    { restId: "rest_1784740340104", userId: "admin_1", role: "admin", isSuperAdmin: false },
    "restaurants/rest_1784740340104/info",
    "write",
    { resolvePerms: async () => ({ role: "admin", modules: null, actions: null }) }
  );
  assert.equal(decision.code, "role_denied");
  assert.equal(decision.status, 403);
});

test("path restId mismatch is denied even for admin", async () => {
  const decision = await authorizeRtdbPath(
    { restId: "rest_1784740340104", userId: "admin_1", role: "admin", isSuperAdmin: false },
    "restaurants/rest_9999999999999/orders",
    "read",
    { resolvePerms: async () => ({ role: "admin", modules: null, actions: null }) }
  );
  assert.equal(decision.code, "path_restId_mismatch");
});

test("canonical platform superadmin may act on an explicit restaurant", async () => {
  const mw = tenantMw({ verified: true, userId: "root", restId: null, platformSuperAdmin: true });
  const result = await request(mw, { headers: { "x-rest-id": "rest_1784740340104" } });
  assert.equal(result.status, 200);
  assert.equal(result.body.isSuperAdmin, true);
  assert.equal(result.body.restId, "rest_1784740340104");
});

test("legacy isSuperAdmin claim is not platform authority", () => {
  assert.equal(isCanonicalPlatformSuperAdmin({ uid: "u1", isSuperAdmin: true, role: "superadmin" }), false);
  assert.equal(tenantScopeDecision({ verified: true, restId: "rest_1000000000001", isSuperAdmin: true }, "rest_2000000000002").code, "restId_mismatch");
});

test("staff token role does not grant customer collection access", async () => {
  const decision = await authorizeRtdbPath(
    { restId: "rest_1784740340104", userId: "client_1", role: "client", isSuperAdmin: false, isCustomer: false },
    "restaurants/rest_1784740340104/settings",
    "write",
    { resolvePerms: async () => null }
  );
  assert.equal(decision.code, "role_denied");
  assert.equal(decision.status, 403);
});
