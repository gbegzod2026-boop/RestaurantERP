import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, skipUnavailable } from "./_dbAvailable.mjs";
import { getPool, closePool, withTenantContext } from "../postgres.js";

const avail = await dbAvailable();
if (avail !== true) {
  await skipUnavailable("pg-pool-leak.test.mjs", avail.error);
} else {
  test("pooled connection reuse does not leak tenant context after thrown callback", async () => {
    const pool = getPool();
    const setup = await pool.connect();
    const stamp = Date.now();
    let restA;
    let restB;
    try {
      restA = (await setup.query(
        `INSERT INTO restaurants (domain, name, legacy_rtdb_id) VALUES ($1,$2,$3) RETURNING id`,
        [`pool-a-${stamp}.local`, "Pool A", `rest_${stamp}`]
      )).rows[0].id;
      restB = (await setup.query(
        `INSERT INTO restaurants (domain, name, legacy_rtdb_id) VALUES ($1,$2,$3) RETURNING id`,
        [`pool-b-${stamp}.local`, "Pool B", `rest_${stamp + 1}`]
      )).rows[0].id;

      const seenA = await withTenantContext(restA, async (client) => {
        const { rows } = await client.query(`SELECT current_setting('app.current_restaurant_id', true) AS v`);
        return rows[0].v;
      }, { actingRole: "admin" });
      assert.equal(seenA, restA);

      const seenB = await withTenantContext(restB, async (client) => {
        const { rows } = await client.query(`SELECT current_setting('app.current_restaurant_id', true) AS v`);
        return rows[0].v;
      }, { actingRole: "admin" });
      assert.equal(seenB, restB);

      await assert.rejects(
        () => withTenantContext(restA, async () => {
          throw new Error("boom");
        }, { actingRole: "admin" }),
        /boom/
      );

      const reused = await withTenantContext(restB, async (client) => {
        const { rows } = await client.query(`SELECT current_setting('app.current_restaurant_id', true) AS v`);
        const leaked = await client.query(`SELECT count(*)::int AS n FROM restaurants WHERE id = $1`, [restA]);
        return { ctx: rows[0].v, leakedA: leaked.rows[0].n };
      }, { actingRole: "admin" });
      assert.equal(reused.ctx, restB);
      assert.equal(reused.leakedA, 0);
    } finally {
      if (restA) await setup.query("DELETE FROM restaurants WHERE id = $1", [restA]).catch(() => {});
      if (restB) await setup.query("DELETE FROM restaurants WHERE id = $1", [restB]).catch(() => {});
      setup.release();
      await closePool();
    }
  });
}
