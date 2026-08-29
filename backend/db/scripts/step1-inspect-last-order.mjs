#!/usr/bin/env node
import { closePool, withPlatformContext } from "../postgres.js";

const rest = await withPlatformContext(async (client) => {
  const restaurant = await client.query(
    "SELECT id, legacy_rtdb_id FROM restaurants WHERE legacy_rtdb_id = $1",
    ["rest_1999000000001"]
  );
  const restaurantId = restaurant.rows[0]?.id;
  if (!restaurantId) return { error: "restaurant_missing" };
  const orders = await client.query(
    `SELECT legacy_rtdb_id, order_number, status, payment_status, total, subtotal,
            table_label, customer_session_id, source
       FROM orders
      WHERE restaurant_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [restaurantId]
  );
  const order = orders.rows[0];
  if (!order) return { restaurantId, order: null, items: [] };
  const items = await client.query(
    `SELECT legacy_menu_id, qty, price_snapshot, line_total, modifiers, status, kitchen_status
       FROM order_items
      WHERE order_id = (
        SELECT id FROM orders
         WHERE restaurant_id = $1 AND legacy_rtdb_id = $2
      )`,
    [restaurantId, order.legacy_rtdb_id]
  );
  return { restaurantId, order, items: items.rows };
});
process.stdout.write(`${JSON.stringify(rest, null, 2)}\n`);
await closePool();
