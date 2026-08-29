import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, skipUnavailable } from "./_dbAvailable.mjs";
import { getPool, closePool, withTenantContext } from "../postgres.js";

const avail = await dbAvailable();
if (avail !== true) {
  await skipUnavailable("rls-customer-context.test.mjs", avail.error);
} else {
  test("customer actingRole cannot read unbound or foreign orders", async () => {
    const pool = getPool();
    const setup = await pool.connect();
    const stamp = Date.now();
    let restId;
    try {
      restId = (await setup.query(
        `INSERT INTO restaurants (domain, name, legacy_rtdb_id) VALUES ($1,$2,$3) RETURNING id`,
        [`cust-rls-${stamp}.local`, "Customer RLS", `rest_${stamp}`]
      )).rows[0].id;
      await setup.query(
        `INSERT INTO orders (legacy_rtdb_id, restaurant_id, order_type, status, customer_session_id)
         VALUES ('own',$1,'takeaway','order_created','sess-a'),
                ('peer',$1,'takeaway','order_created','sess-b'),
                ('legacy',$1,'takeaway','order_created',NULL)`,
        [restId]
      );
      const seen = await withTenantContext(restId, async (client) => {
        const { rows } = await client.query(`SELECT legacy_rtdb_id FROM orders ORDER BY legacy_rtdb_id`);
        return rows.map((r) => r.legacy_rtdb_id);
      }, { actingRole: "customer", customerUid: "sess-a" });
      assert.deepEqual(seen, ["own"]);

      const waiterSees = await withTenantContext(restId, async (client) => {
        const { rows } = await client.query(`SELECT count(*)::int AS n FROM orders`);
        return rows[0].n;
      }, { actingRole: "waiter" });
      assert.equal(waiterSees, 3);
    } finally {
      if (restId) await setup.query("DELETE FROM restaurants WHERE id = $1", [restId]).catch(() => {});
      setup.release();
      await closePool();
    }
  });
}
