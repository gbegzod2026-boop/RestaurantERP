import test from "node:test";
import assert from "node:assert/strict";
import {
  matchesSubscriptionMessage,
  matchesTenantEvent,
} from "../public/js/pgRealtimeProtocol.js";

const A = "rest_1784740340104";
const B = "rest_2000000000002";

test("late ACK from tenant A cannot activate tenant B subscription", () => {
  const active = { restId: B, generation: "generation-b", epoch: 4 };
  assert.equal(matchesSubscriptionMessage(active, {
    ok: true,
    restId: A,
    generation: "generation-a",
  }, 4, { requireOk: true }), false);
  assert.equal(matchesSubscriptionMessage(active, {
    ok: true,
    restId: B,
    generation: "generation-a",
  }, 4, { requireOk: true }), false);
  assert.equal(matchesSubscriptionMessage(active, {
    ok: true,
    restId: B,
    generation: "generation-b",
  }, 4, { requireOk: true }), true);
});

test("logout or identity epoch change rejects old ACK and resync", () => {
  const old = { restId: A, generation: "old", epoch: 2 };
  const message = { ok: true, restId: A, generation: "old" };
  assert.equal(matchesSubscriptionMessage(old, message, 3, { requireOk: true }), false);
  assert.equal(matchesSubscriptionMessage(null, message, 3, { requireOk: true }), false);
});

test("stale old-tenant events are never applied", () => {
  const active = { restId: B, generation: "new", epoch: 8 };
  assert.equal(matchesTenantEvent(active, { restId: A }, 8, true), false);
  assert.equal(matchesTenantEvent(active, { restId: B }, 7, true), false);
  assert.equal(matchesTenantEvent(active, { restId: B }, 8, false), false);
  assert.equal(matchesTenantEvent(active, { restId: B }, 8, true), true);
});
