#!/usr/bin/env node
// Live FK orphan + EXPLAIN ANALYZE evidence for Phase 1.
import { writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getPool, closePool } from "../postgres.js";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/migration-reports/fk-explain-verification.json");

const pool = getPool();
const client = await pool.connect();
const report = { verifiedAt: new Date().toISOString(), orphans: {}, explain: [] };

try {
  const checks = [
    ["orders.customer_id", `SELECT count(*)::int AS n FROM orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE o.customer_id IS NOT NULL AND c.id IS NULL`],
    ["orders.table_id", `SELECT count(*)::int AS n FROM orders o LEFT JOIN tables t ON t.id = o.table_id WHERE o.table_id IS NOT NULL AND t.id IS NULL`],
    ["orders.waiter_id", `SELECT count(*)::int AS n FROM orders o LEFT JOIN employees e ON e.id = o.waiter_id WHERE o.waiter_id IS NOT NULL AND e.id IS NULL`],
    ["order_items.order_id", `SELECT count(*)::int AS n FROM order_items i LEFT JOIN orders o ON o.id = i.order_id WHERE o.id IS NULL`],
    ["order_items.menu_item_id", `SELECT count(*)::int AS n FROM order_items i LEFT JOIN menu_items m ON m.id = i.menu_item_id WHERE i.menu_item_id IS NOT NULL AND m.id IS NULL`],
    ["payments.order_id", `SELECT count(*)::int AS n FROM payments p LEFT JOIN orders o ON o.id = p.order_id WHERE p.order_id IS NOT NULL AND o.id IS NULL`],
    ["reservations.table_id", `SELECT count(*)::int AS n FROM reservations r LEFT JOIN tables t ON t.id = r.table_id WHERE r.table_id IS NOT NULL AND t.id IS NULL`],
    ["reservations.customer_id", `SELECT count(*)::int AS n FROM reservations r LEFT JOIN customers c ON c.id = r.customer_id WHERE r.customer_id IS NOT NULL AND c.id IS NULL`],
    ["recipe_items.recipe_id", `SELECT count(*)::int AS n FROM recipe_items i LEFT JOIN recipes r ON r.id = i.recipe_id WHERE r.id IS NULL`],
    ["purchase_order_items.purchase_order_id", `SELECT count(*)::int AS n FROM purchase_order_items i LEFT JOIN purchase_orders p ON p.id = i.purchase_order_id WHERE p.id IS NULL`],
    ["inventory_items.supplier_id", `SELECT count(*)::int AS n FROM inventory_items i LEFT JOIN suppliers s ON s.id = i.supplier_id WHERE i.supplier_id IS NOT NULL AND s.id IS NULL`],
    ["chat_messages.chat_id", `SELECT count(*)::int AS n FROM chat_messages m LEFT JOIN chats c ON c.id = m.chat_id WHERE c.id IS NULL`],
  ];
  for (const [name, sql] of checks) {
    const n = (await client.query(sql)).rows[0].n;
    report.orphans[name] = n;
    console.log(`orphan ${name}: ${n}`);
  }

  const rest = (await client.query(
    "SELECT restaurant_id AS id FROM orders GROUP BY 1 ORDER BY count(*) DESC LIMIT 1"
  )).rows[0] || (await client.query("SELECT id FROM restaurants LIMIT 1")).rows[0];
  if (!rest) throw new Error("no restaurants");
  const rid = rest.id;

  const queries = [
    ["restaurant → orders", `SELECT * FROM orders WHERE restaurant_id = $1 ORDER BY created_at DESC LIMIT 50`],
    ["restaurant → order status", `SELECT * FROM orders WHERE restaurant_id = $1 AND status = 'completed' ORDER BY created_at DESC LIMIT 50`],
    ["order → order items", `SELECT i.* FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.restaurant_id = $1 LIMIT 50`],
    ["employee → orders", `SELECT * FROM orders WHERE restaurant_id = $1 AND waiter_id IS NOT NULL LIMIT 50`],
    ["customer → orders", `SELECT * FROM orders WHERE restaurant_id = $1 AND customer_id IS NOT NULL LIMIT 50`],
    ["table → active orders", `SELECT * FROM orders WHERE restaurant_id = $1 AND table_id IS NOT NULL AND status NOT IN ('completed','cancelled') LIMIT 50`],
    ["inventory → restaurant stock", `SELECT * FROM inventory_items WHERE restaurant_id = $1 ORDER BY stock LIMIT 50`],
    ["reservations → date/restaurant", `SELECT * FROM reservations WHERE restaurant_id = $1 ORDER BY reserved_date DESC NULLS LAST LIMIT 50`],
    ["payments → order", `SELECT p.* FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.restaurant_id = $1 LIMIT 50`],
    ["menu → restaurant", `SELECT * FROM menu_items WHERE restaurant_id = $1 LIMIT 50`],
  ];

  for (const [label, sql] of queries) {
    const r = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, [rid]);
    const plan = r.rows[0]["QUERY PLAN"][0];
    const node = plan.Plan;
    const summary = {
      label,
      planningMs: plan["Planning Time"],
      executionMs: plan["Execution Time"],
      nodeType: node["Node Type"],
      indexName: node["Index Name"] || node["Plans"]?.[0]?.["Index Name"] || null,
      seqScan: JSON.stringify(plan).includes('"Node Type":"Seq Scan"'),
      plan: node,
    };
    report.explain.push(summary);
    console.log(`EXPLAIN ${label}: ${node["Node Type"]} exec=${plan["Execution Time"]}ms seqScan=${summary.seqScan} idx=${summary.indexName || "-"}`);
  }

  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log("wrote", OUT);
} finally {
  client.release();
  await closePool();
}
