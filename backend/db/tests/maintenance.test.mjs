import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import {
  isMaintenanceMode,
  isMaintenanceAllowed,
  isPaymentWebhookPath,
  maintenanceMiddleware,
  MAINTENANCE_CODE,
} from "../../security/maintenance.js";
import { authorizeLegacyPrivilegedEmit } from "../../pg/legacySocketPolicy.js";

test("maintenance mode is opt-in from env only", () => {
  assert.equal(isMaintenanceMode({}), false);
  assert.equal(isMaintenanceMode({ NESTA_MAINTENANCE_MODE: "" }), false);
  assert.equal(isMaintenanceMode({ NESTA_MAINTENANCE_MODE: "0" }), false);
  assert.equal(isMaintenanceMode({ NESTA_MAINTENANCE_MODE: "1" }), true);
  assert.equal(isMaintenanceMode({ NESTA_MAINTENANCE_MODE: "true" }), true);
});

test("tenant writes are blocked; login/health/pg reads are allowed", () => {
  assert.equal(isMaintenanceAllowed("GET", "/api/health"), true);
  assert.equal(isMaintenanceAllowed("GET", "/api/pg/meta"), true);
  assert.equal(isMaintenanceAllowed("POST", "/api/pg/rtdb/get"), true);
  assert.equal(isMaintenanceAllowed("POST", "/api/auth/staff-login"), true);
  assert.equal(isMaintenanceAllowed("POST", "/api/auth/manager-login"), true);
  assert.equal(isMaintenanceAllowed("POST", "/api/qr/session"), true);
  assert.equal(isMaintenanceAllowed("GET", "/api/foods"), true);
  assert.equal(isMaintenanceAllowed("POST", "/api/pg/rtdb/set"), false);
  assert.equal(isMaintenanceAllowed("POST", "/api/pg/rtdb/update"), false);
  assert.equal(isMaintenanceAllowed("POST", "/api/pg/rtdb/push"), false);
  assert.equal(isMaintenanceAllowed("POST", "/api/pg/rtdb/transaction"), false);
  assert.equal(isMaintenanceAllowed("POST", "/api/pg/orders"), false);
  assert.equal(isMaintenanceAllowed("POST", "/api/categories"), false);
  assert.equal(isMaintenanceAllowed("POST", "/api/delivery/x/assign"), false);
  assert.equal(isMaintenanceAllowed("POST", "/api/auth/login-as"), false);
  assert.equal(isPaymentWebhookPath("/api/click/webhook"), true);
  assert.equal(isMaintenanceAllowed("POST", "/api/click/webhook"), false);
});

async function withApp(envValue, fn) {
  const prev = process.env.NESTA_MAINTENANCE_MODE;
  process.env.NESTA_MAINTENANCE_MODE = envValue;
  const app = express();
  app.use(express.json());
  app.use(maintenanceMiddleware);
  app.post("/api/pg/rtdb/set", (_req, res) => res.json({ wrote: true }));
  app.post("/api/pg/rtdb/get", (_req, res) => res.json({ read: true }));
  app.post("/api/auth/staff-login", (_req, res) => res.json({ token: "x" }));
  app.post("/api/click/webhook", (_req, res) => res.json({ error: 0 }));
  app.post("/api/payme/webhook", (_req, res) => res.json({ result: {} }));
  app.post("/api/uzum/webhook", (_req, res) => res.json({ ok: true }));
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address();
    await fn(port);
  } finally {
    server.close();
    await once(server, "close");
    if (prev === undefined) delete process.env.NESTA_MAINTENANCE_MODE;
    else process.env.NESTA_MAINTENANCE_MODE = prev;
  }
}

test("middleware blocks tenant writes and never 200s payment webhooks", async () => {
  await withApp("1", async (port) => {
    const setRes = await fetch(`http://127.0.0.1:${port}/api/pg/rtdb/set`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const setBody = await setRes.json();
    assert.equal(setRes.status, 503);
    assert.equal(setBody.code, MAINTENANCE_CODE);
    assert.equal(setBody.wrote, undefined);

    const getRes = await fetch(`http://127.0.0.1:${port}/api/pg/rtdb/get`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(getRes.status, 200);
    assert.deepEqual(await getRes.json(), { read: true });

    const login = await fetch(`http://127.0.0.1:${port}/api/auth/staff-login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(login.status, 200);

    const click = await fetch(`http://127.0.0.1:${port}/api/click/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const clickBody = await click.json();
    assert.equal(click.status, 503);
    assert.equal(clickBody.error, -7);
    assert.equal(clickBody.retryable, true);
    assert.equal(clickBody.retry_guaranteed, false);

    const payme = await fetch(`http://127.0.0.1:${port}/api/payme/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: 9 }) });
    const paymeBody = await payme.json();
    assert.equal(payme.status, 503);
    assert.equal(paymeBody.error.code, -32400);

    const uzum = await fetch(`http://127.0.0.1:${port}/api/uzum/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(uzum.status, 503);
    assert.equal((await uzum.json()).ok, undefined);
  });
});

test("socket privileged emits fail closed during maintenance", async () => {
  const prev = process.env.NESTA_MAINTENANCE_MODE;
  process.env.NESTA_MAINTENANCE_MODE = "1";
  try {
    const decision = await authorizeLegacyPrivilegedEmit({}, "new-order", async () => ({ ok: true }));
    assert.deepEqual(decision, { ok: false, code: "MAINTENANCE" });
  } finally {
    if (prev === undefined) delete process.env.NESTA_MAINTENANCE_MODE;
    else process.env.NESTA_MAINTENANCE_MODE = prev;
  }
});

test("middleware is a no-op when maintenance is off", async () => {
  await withApp("", async (port) => {
    const setRes = await fetch(`http://127.0.0.1:${port}/api/pg/rtdb/set`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(setRes.status, 200);
    assert.deepEqual(await setRes.json(), { wrote: true });
    const click = await fetch(`http://127.0.0.1:${port}/api/click/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(click.status, 200);
    assert.deepEqual(await click.json(), { error: 0 });
  });
});
