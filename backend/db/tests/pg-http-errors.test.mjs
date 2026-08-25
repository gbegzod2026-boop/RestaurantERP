import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { createRequirePgTenant } from "../../pg/tenant.js";
import { sendPgFailure } from "../../routes/pgApi.js";

async function request(handler, { headers = {} } = {}) {
  const app = express();
  app.get("/probe", handler, (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/probe`, { headers });
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("tenant middleware rejects invalid credentials before restaurant lookup", async () => {
  let lookups = 0;
  const middleware = createRequirePgTenant({
    resolveIdentityFn: async () => ({ verified: false, tokenError: "invalid" }),
    lookupRestaurantFn: async () => { lookups += 1; },
  });
  const result = await request(middleware);
  assert.deepEqual(result, { status: 401, body: { error: "Authentication required" } });
  assert.equal(lookups, 0);
});

test("tenant mismatch is 403 before restaurant lookup", async () => {
  let lookups = 0;
  const middleware = createRequirePgTenant({
    resolveIdentityFn: async () => ({ verified: true, userId: "u1", restId: "tenant-a" }),
    lookupRestaurantFn: async () => { lookups += 1; },
  });
  const result = await request(middleware, { headers: { "x-rest-id": "tenant-b" } });
  assert.deepEqual(result, { status: 403, body: { error: "Access Denied" } });
  assert.equal(lookups, 0);
});

test("missing restaurant is 404", async () => {
  const middleware = createRequirePgTenant({
    resolveIdentityFn: async () => ({ verified: true, userId: "u1", restId: "tenant-a" }),
    lookupRestaurantFn: async () => null,
  });
  assert.deepEqual(await request(middleware), { status: 404, body: { error: "Restaurant not found" } });
});

test("transient PG lookup failure is sanitized 503", async () => {
  const middleware = createRequirePgTenant({
    resolveIdentityFn: async () => ({ verified: true, userId: "u1", restId: "tenant-a" }),
    lookupRestaurantFn: async () => { throw Object.assign(new Error("password=secret host=private"), { code: "ECONNREFUSED" }); },
  });
  assert.deepEqual(await request(middleware), { status: 503, body: { error: "PG_UNAVAILABLE" } });
});

test("unexpected tenant lookup failure is sanitized 500", async () => {
  const middleware = createRequirePgTenant({
    resolveIdentityFn: async () => ({ verified: true, userId: "u1", restId: "tenant-a" }),
    lookupRestaurantFn: async () => { throw new Error("SELECT secret FROM credentials"); },
  });
  assert.deepEqual(await request(middleware), { status: 500, body: { error: "Internal server error" } });
});

test("route PG failure mapper returns deterministic sanitized responses", () => {
  const capture = () => {
    const value = {};
    return { value, res: { status(code) { value.status = code; return this; }, json(body) { value.body = body; return this; } } };
  };
  const transient = capture();
  sendPgFailure(transient.res, Object.assign(new Error("password=secret"), { code: "57P03" }));
  assert.deepEqual(transient.value, { status: 503, body: { error: "PG_UNAVAILABLE" } });
  const unexpected = capture();
  sendPgFailure(unexpected.res, new Error("raw SQL detail"));
  assert.deepEqual(unexpected.value, { status: 500, body: { error: "Internal server error" } });
});
