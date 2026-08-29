import test from "node:test";
import assert from "node:assert/strict";
import {
  attachPgRealtime,
  evaluateResync,
  evaluateSubscribe,
  revalidateSocketAuthority,
} from "../../pg/socket.js";
import { authorizeSocketJoin } from "../../pg/rbacPg.js";

const REST = "rest_1784740340104";
const REST_B = "rest_2000000000002";
const GEN = "generation-1";

function createIoHarness() {
  const middleware = [];
  let onConnection = null;
  return {
    use(fn) { middleware.push(fn); },
    on(ev, fn) { if (ev === "connection") onConnection = fn; },
    async connect(socket) {
      for (const mw of middleware) {
        await new Promise((resolve, reject) => mw(socket, (err) => (err ? reject(err) : resolve())));
      }
      onConnection(socket);
      return socket;
    },
  };
}

function mockSocket() {
  const handlers = {};
  const emitted = [];
  const joined = [];
  const left = [];
  return {
    handshake: { auth: {}, address: "127.0.0.1" },
    nestaToken: null,
    on(ev, fn) { (handlers[ev] ||= []).push(fn); },
    emit(ev, data) { emitted.push([ev, data]); },
    join(room) { joined.push(room); },
    leave(room) { left.push(room); },
    async fire(ev, data) {
      for (const fn of handlers[ev] || []) await fn(data);
    },
    emitted,
    joined,
    left,
  };
}

test("two clients cannot resync before subscribed ack", async () => {
  const io = createIoHarness();
  attachPgRealtime(io);
  const a = mockSocket();
  const b = mockSocket();
  await io.connect(a);
  await io.connect(b);
  await a.fire("nesta:resync", { restId: REST, afterSeq: 0 });
  await b.fire("nesta:resync", { restId: REST, afterSeq: 0 });
  assert.ok(a.emitted.some(([ev, msg]) => ev === "nesta:error" && msg.error === "not_subscribed"));
  assert.ok(b.emitted.some(([ev, msg]) => ev === "nesta:error" && msg.error === "not_subscribed"));
  assert.equal(evaluateResync({ nestaSubscribed: false, nestaRestId: REST }, REST, GEN).error, "not_subscribed");
  const sub = evaluateSubscribe(REST, { userId: "u1" }, GEN);
  assert.equal(sub.ok, true);
  assert.equal(evaluateResync({
    nestaSubscribed: true,
    nestaRestId: REST,
    nestaGeneration: GEN,
  }, REST, GEN).ok, true);
  assert.equal(evaluateResync({
    nestaSubscribed: true,
    nestaRestId: REST,
    nestaGeneration: GEN,
  }, "", GEN).error, "restId_invalid");
});

test("socket join uses current PostgreSQL employee authority, not token role", async () => {
  const identity = {
    verified: true,
    restId: REST,
    userId: "employee_1",
    role: "admin",
  };
  const current = await authorizeSocketJoin({
    token: "valid",
    restId: REST,
    resolveIdentityFn: async () => identity,
    resolvePermissionsFn: async () => ({ role: "waiter", modules: ["orders"], actions: {} }),
  });
  assert.equal(current.role, "waiter");
  assert.equal(current.permissions.role, "waiter");
});

test("deleted, inactive, blocked, or revoked employees cannot subscribe", async () => {
  const identity = { verified: true, restId: REST, userId: "employee_1", role: "admin" };
  for (const state of ["deleted", "inactive", "blocked", "revoked"]) {
    const result = await authorizeSocketJoin({
      token: "old-valid-token",
      restId: REST,
      resolveIdentityFn: async () => identity,
      resolvePermissionsFn: async () => null,
    });
    assert.equal(result, null, state);
  }
});

test("subscription generation correlates ACK and rejects stale resync", () => {
  const first = evaluateSubscribe(REST, { userId: "a" }, "generation-a");
  const second = evaluateSubscribe(REST, { userId: "b" }, "generation-b");
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const active = {
    nestaSubscribed: true,
    nestaRestId: REST,
    nestaGeneration: second.generation,
  };
  assert.equal(evaluateResync(active, REST, first.generation).error, "not_subscribed");
  assert.equal(evaluateResync(active, REST, second.generation).ok, true);
});

test("rapid tenant transition ignores a late authorization result", async () => {
  let releaseA;
  const pendingA = new Promise((resolve) => { releaseA = resolve; });
  const io = createIoHarness();
  attachPgRealtime(io, {
    authorizeSocketJoinFn: async ({ restId }) => {
      if (restId === REST) return pendingA;
      return { userId: "user-b", restId, role: "admin", permissions: { role: "admin" } };
    },
  });
  const socket = mockSocket();
  await io.connect(socket);
  const first = socket.fire("nesta:subscribe", { restId: REST, generation: "gen-a", token: "a" });
  await socket.fire("nesta:subscribe", { restId: REST_B, generation: "gen-b", token: "b" });
  releaseA({ userId: "user-a", restId: REST, role: "admin", permissions: { role: "admin" } });
  await first;

  const acks = socket.emitted.filter(([event]) => event === "nesta:subscribed");
  assert.deepEqual(acks, [["nesta:subscribed", { restId: REST_B, generation: "gen-b", ok: true }]]);
  assert.equal(socket.nestaRestId, REST_B);
  assert.equal(socket.nestaGeneration, "gen-b");
  assert.ok(socket.joined.includes(`rest-${REST_B}`));
  assert.ok(!socket.joined.includes(`rest-${REST}`));
});

test("resync revalidates authority and leaves the room when authority disappears", async () => {
  let authorized = true;
  const io = createIoHarness();
  attachPgRealtime(io, {
    authorizeSocketJoinFn: async ({ restId }) => authorized
      ? { userId: "user-a", restId, role: "waiter", permissions: { role: "waiter" } }
      : null,
    lookupRestaurantFn: async () => ({ id: "restaurant-uuid" }),
    withTenantContextFn: async (_id, fn) => fn({}),
    listEventsSinceFn: async () => [],
  });
  const socket = mockSocket();
  await io.connect(socket);
  await socket.fire("nesta:subscribe", { restId: REST, generation: GEN, token: "token" });
  assert.equal(socket.nestaSubscribed, true);

  authorized = false;
  await socket.fire("nesta:resync", { restId: REST, generation: GEN, afterSeq: 0 });
  assert.equal(socket.nestaSubscribed, false);
  assert.equal(socket.nestaRestId, null);
  assert.ok(socket.left.includes(`rest-${REST}`));
  assert.ok(socket.emitted.some(([event, message]) =>
    event === "nesta:error" &&
    message.error === "subscribe_denied" &&
    message.generation === GEN));
});

test("duplicate subscribe invalidates the previous generation without retry loops", async () => {
  const io = createIoHarness();
  attachPgRealtime(io, {
    authorizeSocketJoinFn: async ({ restId }) => ({
      userId: "user-a",
      restId,
      role: "waiter",
      permissions: { role: "waiter" },
    }),
  });
  const socket = mockSocket();
  await io.connect(socket);
  await socket.fire("nesta:subscribe", { restId: REST, generation: "gen-1", token: "token" });
  await socket.fire("nesta:subscribe", { restId: REST, generation: "gen-2", token: "token" });
  assert.equal(socket.nestaGeneration, "gen-2");
  assert.equal(socket.emitted.filter(([event]) => event === "nesta:subscribed").length, 2);
  assert.ok(socket.left.includes(`rest-${REST}`));
});

test("logout unsubscribe invalidates pending subscribe and clears room state", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const io = createIoHarness();
  attachPgRealtime(io, { authorizeSocketJoinFn: async () => pending });
  const socket = mockSocket();
  await io.connect(socket);
  const subscribe = socket.fire("nesta:subscribe", { restId: REST, generation: GEN, token: "token" });
  await socket.fire("nesta:unsubscribe", { restId: REST, generation: GEN });
  release({ userId: "user-a", restId: REST, role: "admin", permissions: { role: "admin" } });
  await subscribe;
  assert.equal(socket.nestaSubscribed, false);
  assert.equal(socket.nestaRestId, null);
  assert.equal(socket.emitted.some(([event]) => event === "nesta:subscribed"), false);
});

test("connected socket periodic authority check fails closed", async () => {
  const socket = mockSocket();
  Object.assign(socket, {
    nestaSubscribed: true,
    nestaRestId: REST,
    nestaGeneration: GEN,
    nestaToken: "old-token",
    nestaUserId: "removed-user",
  });
  const result = await revalidateSocketAuthority(socket, async () => null);
  assert.equal(result, null);
  assert.equal(socket.nestaSubscribed, false);
  assert.equal(socket.nestaRestId, null);
  assert.ok(socket.left.includes(`rest-${REST}`));
});

test("canonical customer tokens cannot subscribe to the tenant realtime room", async () => {
  const authz = await authorizeSocketJoin({
    token: "customer-token",
    restId: REST,
    resolveIdentityFn: async () => ({
      verified: true,
      userId: `client_${REST}_1`,
      restId: REST,
      role: "client",
      isCustomer: true,
      tokenType: "customer",
    }),
    resolvePermissionsFn: async () => ({ role: "admin", modules: null, actions: null }),
  });
  assert.equal(authz, null);
});
