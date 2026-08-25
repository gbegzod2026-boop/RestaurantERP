// routes/clientOrders.js — P0 fix: CLIENT ORDER ACCESS SECURITY.
//
// Root cause (Wave 2 audit, live-verified): restaurants/$restId's own
// database.rules.json ".read" grants ANY verified session (staff OR QR
// customer) for that restId broad read access to the ENTIRE subtree,
// including orders/ in full — there is no nested rule anywhere that
// narrows this per-order or per-table, and Firebase RTDB rules cascade
// DOWNWARD for GRANTING only (a child rule can never revoke an ancestor's
// grant — the same structural fact that already forced credentials/ out of
// restaurants/$restId entirely, see that tree's own comments). A QR
// session's `table` claim is minted (routes/qr.js) but never referenced by
// any rule. canClientAccessOrder() (client.js) is a client-side rendering
// filter only — it runs after the data has already been fetched into the
// browser, so it has zero enforcement power against a direct RTDB REST
// call bypassing client.js entirely (live-proven: table-1 session read
// table-2's real order, and the entire /orders node, at HTTP 200).
//
// This endpoint is the "specific order" step of the required architecture
// (Client → secure backend/QR-order endpoint → verified Firebase Auth QR
// session → server-side authorization → specific order). It never lists
// orders — there is no GET /client/orders (plural) route here at all, by
// design, so full-collection enumeration has no surface to exist on this
// path regardless of what database.rules.json ends up doing.
//
// This file alone does NOT close the raw-RTDB-REST-API exploit — that
// requires the accompanying database.rules.json change (written, not yet
// deployed — see the fix report). This file fixes the REAL client.js app's
// own behavior today, independent of when/whether that deploy happens.
import express from "express";
import { getAdminAuth, isAdminAvailable } from "../firebaseAdmin.js";
import { systemGet } from "../systemDb.js";
import { isSafeId } from "../security/sanitize.js";
import { usePostgres } from "../pg/config.js";
import { withLegacyRest } from "../pg/legacyBridge.js";
import { getOrderByLegacy } from "../pg/ordersService.js";

const router = express.Router();

// Verifies the caller's Firebase ID token via the Admin SDK (same
// verifyIdToken() call rbac.js already uses for staff requests — reused,
// not reinvented) and asserts it is a real, backend-minted QR CUSTOMER
// session — never a staff/admin/superadmin token. Closes "employee/admin
// token cannot be misclassified as a client session" by construction: a
// staff session's custom token (routes/auth.js) never sets
// type:"customer"/role:"client" (routes/qr.js is the only minter of those
// two claims together), so this check rejects every non-QR token outright,
// regardless of what restId/role it does carry.
async function requireCustomerSession(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const idToken = authHeader.slice(7).trim();
    if (!idToken) return res.status(401).json({ error: "Authentication required" });
    if (!isAdminAvailable()) return res.status(503).json({ error: "Session verification unavailable" });

    const decoded = await getAdminAuth().verifyIdToken(idToken);
    if (decoded.type !== "customer" || decoded.role !== "client" || !decoded.restId) {
      return res.status(403).json({ error: "Not a valid customer session" });
    }
    req.clientSession = {
      restId: String(decoded.restId),
      table: decoded.table != null ? String(decoded.table) : "",
      tableId: decoded.tableId != null ? String(decoded.tableId) : "",
    };
    next();
  } catch (_err) {
    // Expired/malformed/forged token — never echo the raw verify error
    // (could reflect attacker-controlled token content back to them).
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}

// Minimum safe surface: exactly the fields the client UI (cart/receipt/
// order-tracking screens) legitimately renders. Deliberately excludes
// internal staff-facing fields not needed by the customer UI (e.g.
// waiterName/chefName/pickedUpByName/servedByName/canceledBy/
// approvedByAdmin/inventoryDeducted/lastTimelineEvent*) even though this is
// the customer's OWN order and those specific fields aren't independently
// sensitive PII — narrower is safer, and the client UI never reads them.
const CLIENT_SAFE_FIELDS = [
  "orderNumber", "orderType", "table", "createdAt", "updatedAt",
  "status", "statusKey", "statusV2", "statusLabel", "statusHistory",
  "items", "originalTotal", "total", "subtotal",
  "discount", "discountAmount", "discountPercent", "discountApplied",
  "serviceFeeAmount", "serviceFeePercent", "fastFeeAmount", "priority",
  "cookTimeEstimate",
  "deliveryFee", "deliveryAddress", "deliveryPaymentMethod", "delivery",
  "payment", "paidAt", "kassaCode",
  "clientId", "customerPhone", "clientPhone", "customerName", "allergyInfo", "allergyNote",
];

function pickClientSafeFields(order) {
  const out = {};
  for (const key of CLIENT_SAFE_FIELDS) {
    if (order[key] !== undefined) out[key] = order[key];
  }
  return out;
}

// GET /api/client/orders/:orderId — the ONLY read this router exposes.
router.get("/client/orders/:orderId", requireCustomerSession, async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!isSafeId(String(orderId))) return res.status(400).json({ error: "Invalid orderId" });

    const { restId, table } = req.clientSession;
    let order = null;
    if (usePostgres()) {
      order = await withLegacyRest(restId, (client, ctx) => getOrderByLegacy(client, ctx.restaurantUuid, orderId));
      if (order === null) return res.status(404).json({ error: "Order not found" });
    } else {
      const snap = await systemGet(`restaurants/${restId}/orders/${orderId}`);
      if (!snap.exists()) return res.status(404).json({ error: "Order not found" });
      order = snap.val();
    }

    // Dine-in orders carry a table — require it to match this session's
    // verified table claim (not a client-supplied value; came from the
    // decoded, signature-checked token). Takeaway/delivery orders have no
    // table field at all — every non-table QR session at a given
    // restaurant shares one anonymous Firebase Auth identity
    // (client_{restId}_na, routes/qr.js), so there is no verifiable
    // per-customer claim to check for those; access for that case is
    // capability-based (this exact, unguessable order id must already be
    // known to the caller — never listable through this or any other route
    // here). See the fix report for why this residual scope is a
    // structural limit of the current session-identity scheme, not an
    // oversight.
    const hasTable = order.table !== undefined && order.table !== null && String(order.table) !== "";
    if (hasTable && String(order.table) !== table) {
      return res.status(403).json({ error: "Access Denied" });
    }

    res.json({ order: { ...pickClientSafeFields(order), _id: orderId } });
  } catch (err) {
    console.error("[clientOrders] error:", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
