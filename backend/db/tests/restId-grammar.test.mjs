import test from "node:test";
import assert from "node:assert/strict";
import {
  parseRestId,
  canonicalizeRestId,
  parseCompositeUid,
  resolveActingRestId,
  resolveRequestRestId,
} from "../../pg/restId.js";

const REST = "rest_1784740340104";
const REST_B = "rest_2000000000002";

test("canonical restId accepts rest_<10-16 digits> only", () => {
  assert.deepEqual(parseRestId(REST), { ok: true, restId: REST, composite: false });
  assert.equal(canonicalizeRestId(REST), REST);
  assert.equal(parseRestId("rest_123456789").ok, false);
  assert.equal(parseRestId("rest_12345678901234567").ok, false);
  assert.equal(parseRestId("REST_1784740340104").ok, false);
  assert.equal(parseRestId("prest_1784740340104").ok, false);
  assert.equal(parseRestId("rest_1784740340104x").ok, false);
  assert.equal(parseRestId("rest_").ok, false);
});

test("legacy staff uid canonicalizes exactly rest_<digits>__<staffUser>", () => {
  assert.deepEqual(parseRestId(`${REST}__admin_1`), {
    ok: true, restId: REST, staffUserId: "admin_1", composite: true,
  });
  assert.equal(canonicalizeRestId(`${REST}__admin_1`), REST);
  assert.deepEqual(parseCompositeUid(`${REST}__chef_2`), { restId: REST, userId: "chef_2" });
  assert.equal(parseRestId("rest_s1a_123__admin_1").ok, false);
  assert.equal(canonicalizeRestId("rest_s1a_123__admin_1"), null);
  assert.equal(parseRestId(`${REST}__`).ok, false);
  assert.equal(parseRestId(`__admin_1`).ok, false);
  assert.equal(parseRestId(`${REST}__${REST}__x`).ok, false);
  assert.equal(parseRestId(`${REST}___admin`).ok, false);
  assert.equal(parseRestId(`${REST}____admin`).ok, false);
  assert.equal(parseRestId("rest_1__admin_1").ok, false);
});

test("whitespace, encoding, overlong, and prefix tricks are rejected", () => {
  assert.equal(parseRestId(` ${REST}`).ok, false);
  assert.equal(parseRestId(`${REST} `).ok, false);
  assert.equal(parseRestId(`${REST}\n`).ok, false);
  assert.equal(parseRestId("rest_1784740340104%2Fother").ok, false);
  assert.equal(parseRestId("rest_1784740340104%2e%2e").ok, false);
  assert.equal(parseRestId(`${REST}/../${REST_B}`).ok, false);
  assert.equal(parseRestId("a".repeat(100)).ok, false);
  assert.equal(parseRestId(`${REST}#x`).ok, false);
  assert.equal(parseRestId("").ok, false);
  assert.equal(parseRestId(null).empty, true);
});

test("acting restId never uses a requested restId for a tenant token", () => {
  assert.equal(resolveActingRestId({ tokenRestId: `${REST}__admin_1` }), REST);
  assert.equal(resolveActingRestId({ uid: `${REST}__chef_2` }), REST);
  assert.equal(resolveActingRestId({
    tokenRestId: REST,
    requestedRestId: REST_B,
    platformSuperAdmin: false,
  }), REST);
  assert.equal(resolveActingRestId({
    tokenRestId: null,
    requestedRestId: REST_B,
    platformSuperAdmin: true,
  }), REST_B);
  assert.equal(resolveActingRestId({ tokenRestId: "tenant-a" }), null);
});

test("conflicting request selectors are restId_conflict", () => {
  const conflict = resolveRequestRestId({
    headers: { "x-rest-id": REST },
    query: {},
    body: { restId: REST_B, path: `restaurants/${REST}/orders` },
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, "restId_conflict");
  assert.equal(conflict.status, 400);
});

test("malformed request selector is restId_invalid not silent null", () => {
  const invalid = resolveRequestRestId({
    headers: { "x-rest-id": `${REST}/../${REST_B}` },
    query: {},
    body: {},
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, "restId_invalid");
  const encoded = resolveRequestRestId({
    headers: { "x-rest-id": "rest_1784740340104%2Finfo" },
    query: {},
    body: {},
  });
  assert.equal(encoded.ok, false);
});

test("absent selectors remain distinct from present empty selectors", () => {
  const absent = resolveRequestRestId({ headers: {}, query: {}, body: {} });
  assert.deepEqual(absent, { ok: true, restId: null, empty: true });

  const cases = [
    { name: "header", req: { headers: { "x-rest-id": "" }, query: {}, body: {} } },
    { name: "header whitespace", req: { headers: { "x-rest-id": " " }, query: {}, body: {} } },
    { name: "body", req: { headers: {}, query: {}, body: { restId: "" } } },
    { name: "query", req: { headers: {}, query: { restId: "" }, body: {} } },
    { name: "middleware", req: { pgRestId: "", headers: {}, query: {}, body: {} } },
    { name: "path", req: { headers: {}, query: {}, body: { path: "restaurants//orders" } } },
  ];
  for (const { name, req } of cases) {
    const result = resolveRequestRestId(req);
    assert.equal(result.ok, false, name);
    assert.equal(result.status, 400, name);
    assert.equal(result.code, "restId_invalid", name);
  }
});

test("valid selectors from every source agree", () => {
  const result = resolveRequestRestId({
    pgRestId: REST,
    headers: { "x-rest-id": REST },
    query: { restId: REST },
    body: { restId: REST, path: `restaurants/${REST}/orders` },
  });
  assert.deepEqual(result, { ok: true, restId: REST });
});
