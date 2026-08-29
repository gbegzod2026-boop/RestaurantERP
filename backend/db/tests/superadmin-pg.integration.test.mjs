import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { dbAvailable, skipUnavailable } from "./_dbAvailable.mjs";
import { getPool, closePool } from "../postgres.js";
import { getAdminAuth, isAdminAvailable } from "../../firebaseAdmin.js";
import superadminDashboard from "../../routes/superadminDashboard.js";

const REST = `rest_${Date.now()}`;

const available = await dbAvailable();
if (available !== true) {
  await skipUnavailable("superadmin-pg.integration.test.mjs", available.error);
} else if (!isAdminAvailable()) {
  test("superadmin PostgreSQL API: MOCKED auth unavailable", { skip: "Firebase Admin SDK unavailable" }, () => {});
} else {
  test("canonical superadmin APIs use PostgreSQL for features and chat", async () => {
    const previousBackend = process.env.DATA_BACKEND;
    process.env.DATA_BACKEND = "postgres";
    const auth = getAdminAuth();
    const originalVerify = auth.verifyIdToken.bind(auth);
    auth.verifyIdToken = async (token) => {
      if (token === "nesta-test-platform") {
        return { uid: "platform-test-root", platformSuperAdmin: true };
      }
      return originalVerify(token);
    };
    const pool = getPool();
    const setup = await pool.connect();
    let restaurantId;
    const app = express();
    app.use(express.json());
    app.use("/api/superadmin/dashboard", superadminDashboard);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address();
    const api = async (path, options = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/superadmin/dashboard${path}`, {
        ...options,
        headers: {
          Authorization: "Bearer nesta-test-platform",
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
      });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    };
    try {
      restaurantId = (await setup.query(
        `INSERT INTO restaurants (domain, name, legacy_rtdb_id, info)
         VALUES ($1, 'Superadmin API', $2, '{"tariff":"pro"}'::jsonb)
         RETURNING id`,
        [`superadmin-api-${Date.now()}.local`, REST]
      )).rows[0].id;

      const listed = await api("/restaurants");
      assert.equal(listed.status, 200);
      assert.equal(listed.body[REST].info.name, "Superadmin API");

      const features = await api(`/restaurants/${REST}/features`, {
        method: "POST",
        body: JSON.stringify({ customFeatures: ["+finance"], features: ["kds", "finance"] }),
      });
      assert.equal(features.status, 200);
      const stored = (await setup.query(
        `SELECT info->'subscription' AS subscription FROM restaurants WHERE id = $1`,
        [restaurantId]
      )).rows[0].subscription;
      assert.deepEqual(stored.customFeatures, ["+finance"]);
      assert.deepEqual(stored.features, ["kds", "finance"]);

      const sent = await api(`/restaurants/${REST}/superadmin-chat`, {
        method: "POST",
        body: JSON.stringify({ text: "PostgreSQL support message" }),
      });
      assert.equal(sent.status, 200);
      assert.ok(sent.body.key);
      const chat = await api(`/restaurants/${REST}/superadmin-chat`);
      assert.equal(chat.status, 200);
      assert.equal(chat.body[sent.body.key].text, "PostgreSQL support message");

      const malformed = await api("/restaurants/not-a-rest/superadmin-chat");
      assert.equal(malformed.status, 400);
      assert.equal(malformed.body.code, "restId_invalid");
    } finally {
      server.close();
      await once(server, "close");
      if (restaurantId) await setup.query("DELETE FROM restaurants WHERE id = $1", [restaurantId]).catch(() => {});
      setup.release();
      auth.verifyIdToken = originalVerify;
      if (previousBackend === undefined) delete process.env.DATA_BACKEND;
      else process.env.DATA_BACKEND = previousBackend;
      await closePool();
    }
  });
}
