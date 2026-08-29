import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { dbAvailable, skipUnavailable } from "./_dbAvailable.mjs";
import { getPool, closePool } from "../postgres.js";
import { isAdminAvailable, getAdminAuth } from "../../firebaseAdmin.js";
import pgApi from "../../routes/pgApi.js";

const suffix = Date.now();
const REST_A = `rest_${suffix}`;
const REST_B = `rest_${suffix + 1}`;

function mintMock({ restId, userId, role, type, table, tableId }) {
  const payload = {
    uid: type === "customer" ? userId : `${restId}__${userId}`,
    restId,
    restaurantId: restId,
    role,
    rtdbUserId: userId,
    type: type || null,
    table: table ?? "",
    tableId: tableId ?? table ?? "",
  };
  return "nesta-test." + Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function installMockVerify() {
  if (!isAdminAvailable()) return false;
  const auth = getAdminAuth();
  const orig = auth.verifyIdToken.bind(auth);
  auth.verifyIdToken = async (token, checkRevoked) => {
    if (String(token).startsWith("nesta-test.")) {
      return JSON.parse(Buffer.from(String(token).slice("nesta-test.".length), "base64url").toString("utf8"));
    }
    return orig(token, checkRevoked);
  };
  return true;
}

const available = await dbAvailable();
if (available !== true) {
  await skipUnavailable("customer-pricing.integration.test.mjs", available.error);
} else if (!installMockVerify()) {
  test("customer pricing: MOCKED auth unavailable", { skip: "Firebase Admin SDK unavailable" }, () => {});
} else {
  test("customer order items persist catalog prices, not client prices", async () => {
    const previousBackend = process.env.DATA_BACKEND;
    process.env.DATA_BACKEND = "postgres";
    const pool = getPool();
    const setup = await pool.connect();
    let restA;
    let restB;
    const app = express();
    app.use(express.json());
    app.use("/api/pg", pgApi);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address();
    const api = async (token, op, body) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/pg/rtdb/${op}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
    try {
      restA = (await setup.query(
        `INSERT INTO restaurants (domain, name, legacy_rtdb_id) VALUES ($1,$2,$3) RETURNING id`,
        [`price-a-${suffix}.local`, "Price A", REST_A]
      )).rows[0].id;
      restB = (await setup.query(
        `INSERT INTO restaurants (domain, name, legacy_rtdb_id) VALUES ($1,$2,$3) RETURNING id`,
        [`price-b-${suffix}.local`, "Price B", REST_B]
      )).rows[0].id;
      await setup.query(
        `INSERT INTO menu_items (legacy_rtdb_id, restaurant_id, name, price, active, extra)
         VALUES ('dish_plain',$1,'{"uz":"Osh"}'::jsonb,10000,true,'{}'::jsonb),
                ('dish_a',$1,'{"uz":"Osh A"}'::jsonb,10000,true,'{"modifierIds":["mod_a"]}'::jsonb),
                ('dish_other',$1,'{"uz":"Other"}'::jsonb,8000,true,'{"modifierIds":["mod_other"]}'::jsonb),
                ('dish_dead',$1,'{"uz":"Dead"}'::jsonb,5000,true,'{"modifierIds":["mod_dead"]}'::jsonb),
                ('hidden_a',$1,'{"uz":"Staff"}'::jsonb,50,true,'{"adminOnly":true}'::jsonb),
                ('off_a',$1,'{"uz":"Off"}'::jsonb,30,false,'{}'::jsonb),
                ('dish_b',$2,'{"uz":"Foreign"}'::jsonb,1,true,'{}'::jsonb)`,
        [restA, restB]
      );
      await setup.query(
        `INSERT INTO modifiers (legacy_rtdb_id, restaurant_id, name, price_delta, active, extra)
         VALUES ('mod_a',$1,'{"uz":"Cheese"}'::jsonb,2000,true,'{"options":{"cheese":{"name":"Cheese","price":2000}}}'::jsonb),
                ('mod_other',$1,'{"uz":"Pepper"}'::jsonb,500,true,'{"options":{"pepper":{"name":"Pepper","price":500}}}'::jsonb),
                ('mod_attack',$1,'{"uz":"Attack"}'::jsonb,-9000,true,'{}'::jsonb),
                ('mod_dead',$1,'{"uz":"Dead"}'::jsonb,100,false,'{}'::jsonb),
                ('mod_b',$2,'{"uz":"B"}'::jsonb,9,true,'{}'::jsonb)`,
        [restA, restB]
      );
      await setup.query(
        `INSERT INTO stop_list (restaurant_id, legacy_menu_id, extra)
         VALUES ($1,'off_a','{}'::jsonb)`,
        [restA]
      );

      const token = mintMock({
        restId: REST_A, userId: `client_price_${suffix}`, role: "client", type: "customer", table: "", tableId: "",
      });

      const cheap = await api(token, "push", {
        path: `restaurants/${REST_A}/orders`, restId: REST_A,
        value: {
          items: {
            line_1: {
              productId: "dish_plain", qty: 2, price: 0, unitPrice: 1, discount: 999999,
              status: "ready", kitchenStatus: "cooking",
            },
          },
        },
      });
      assert.equal(cheap.status, 200, cheap.body.code);
      const orderId = cheap.body.key;
      const got = await api(token, "get", { path: `restaurants/${REST_A}/orders/${orderId}`, restId: REST_A });
      assert.equal(got.status, 200, got.body.code);
      const items = got.body.value.items || {};
      const line = Object.values(items)[0];
      assert.equal(Number(line.price), 10000);
      assert.equal(Number(got.body.value.total), 20000);
      assert.equal(String(line.status || "pending"), "pending");
      assert.equal(line.kitchenStatus == null, true);

      const negative = await api(token, "push", {
        path: `restaurants/${REST_A}/orders`, restId: REST_A,
        value: { items: { x: { productId: "dish_plain", qty: 1, price: -5 } } },
      });
      assert.equal(negative.status, 200);
      const negGot = await api(token, "get", {
        path: `restaurants/${REST_A}/orders/${negative.body.key}`, restId: REST_A,
      });
      assert.equal(Number(Object.values(negGot.body.value.items)[0].price), 10000);

      const foreignProduct = await api(token, "push", {
        path: `restaurants/${REST_A}/orders`, restId: REST_A,
        value: { items: { x: { productId: "dish_b", qty: 1, price: 1 } } },
      });
      assert.equal(foreignProduct.status, 403);
      assert.equal(foreignProduct.body.code, "product_unknown");

      const foreignMod = await api(token, "push", {
        path: `restaurants/${REST_A}/orders`, restId: REST_A,
        value: { items: { x: { productId: "dish_a", qty: 1, modifiers: [{ id: "mod_b" }] } } },
      });
      assert.equal(foreignMod.status, 403);

      const hidden = await api(token, "push", {
        path: `restaurants/${REST_A}/orders`, restId: REST_A,
        value: { items: { x: { productId: "hidden_a", qty: 1 } } },
      });
      assert.equal(hidden.status, 403);

      const allowedMod = await api(token, "push", {
        path: `restaurants/${REST_A}/orders`, restId: REST_A,
        value: {
          items: {
            x: { productId: "dish_a", qty: 1, modifiers: [{ groupId: "mod_a", optId: "cheese", price: -9000 }] },
          },
        },
      });
      assert.equal(allowedMod.status, 200, allowedMod.body.code);
      const modGot = await api(token, "get", {
        path: `restaurants/${REST_A}/orders/${allowedMod.body.key}`, restId: REST_A,
      });
      const allowedLine = Object.values(modGot.body.value.items)[0];
      assert.equal(Number(allowedLine.price), 12000);
      assert.equal(Number(allowedLine.modifiers[0].price), 2000);
      assert.equal(Number(modGot.body.value.total), 12000);

      const wrongProductMod = await api(token, "push", {
        path: `restaurants/${REST_A}/orders`, restId: REST_A,
        value: { items: { x: { productId: "dish_a", qty: 1, modifiers: [{ groupId: "mod_other", optId: "pepper" }] } } },
      });
      assert.equal(wrongProductMod.status, 403);

      const noAssoc = await api(token, "push", {
        path: `restaurants/${REST_A}/orders`, restId: REST_A,
        value: { items: { x: { productId: "dish_plain", qty: 1, modifiers: [{ id: "mod_attack", price: -9000 }] } } },
      });
      assert.equal(noAssoc.status, 403);
      assert.equal(noAssoc.body.code, "modifier_not_associated");

      const wrongGroupOption = await api(token, "push", {
        path: `restaurants/${REST_A}/orders`, restId: REST_A,
        value: { items: { x: { productId: "dish_a", qty: 1, modifiers: [{ groupId: "mod_a", optId: "pepper" }] } } },
      });
      assert.equal(wrongGroupOption.status, 403);

      const inactiveMod = await api(token, "push", {
        path: `restaurants/${REST_A}/orders`, restId: REST_A,
        value: { items: { x: { productId: "dish_dead", qty: 1, modifiers: [{ id: "mod_dead" }] } } },
      });
      assert.equal(inactiveMod.status, 403);

      const exploit = await api(token, "push", {
        path: `restaurants/${REST_A}/orders`, restId: REST_A,
        value: {
          items: {
            x: { productId: "dish_plain", qty: 1, price: 10000, modifiers: [{ id: "mod_attack", price: -9000 }] },
          },
        },
      });
      assert.equal(exploit.status, 403);
      assert.notEqual(exploit.status, 200);
    } finally {
      if (restA) await setup.query("DELETE FROM restaurants WHERE id = $1", [restA]).catch(() => {});
      if (restB) await setup.query("DELETE FROM restaurants WHERE id = $1", [restB]).catch(() => {});
      setup.release();
      server.close();
      if (previousBackend === undefined) delete process.env.DATA_BACKEND;
      else process.env.DATA_BACKEND = previousBackend;
      await closePool();
    }
  });
}
