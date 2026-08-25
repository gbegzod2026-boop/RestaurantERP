// notifications/warehouseScanner.js — periodic warehouse threshold scan.
// Stock crossing a threshold isn't a single "event" the way an order write
// is — it's discovered by comparison, so this runs on a timer (scheduler.js)
// rather than reacting to a single DB write. Every ingredient's alert state
// is persisted (common.js getAlertState/setAlertState) so a restart doesn't
// cause duplicate re-alerts and a fixed ingredient doesn't leave a stale
// "critical" notification behind — satisfies spec section 14 ("Only send
// changed alerts once").
// Architecture Fix Pass: database.rules.json requires `auth != null` on
// restaurants/$restId now, so this read goes through the admin-or-client
// fallback (systemDb.js) instead of the plain client SDK.
import { systemGet } from "../systemDb.js";
import { basePath, getAlertState, setAlertState, isTypeEnabled, getNotificationSettings } from "./common.js";
import { renderWarehouseAlert } from "./templates.js";
import { NotificationService } from "./NotificationService.js";
import { NOTIFICATION_TYPES } from "./types.js";

function priorityForDaysRemaining(days) {
  if (days == null) return "low";
  if (days < 2) return "critical";
  if (days < 5) return "high";
  if (days < 14) return "medium";
  return "low";
}

export async function scanWarehouse(restId) {
  const settings = await getNotificationSettings(restId);
  if (!settings.enabled) return { scanned: 0, alerted: 0 };

  const snap = await systemGet(`${basePath(restId)}/warehouse`);
  const items = Object.entries(snap.val() || {});
  let alerted = 0;

  for (const [id, item] of items) {
    const qty = Number(item.quantity ?? item.qty ?? 0);
    const minQty = Number(item.minQuantity ?? item.minQty ?? 0);
    const avgDailyUsage = Number(item.avgDailyUsage || 0) || (minQty > 0 ? minQty / 7 : 0);
    const daysRemaining = avgDailyUsage > 0 ? qty / avgDailyUsage : null;
    const priority = qty <= 0 ? "out" : priorityForDaysRemaining(daysRemaining);

    if (priority !== "critical" && priority !== "high" && priority !== "out") continue;

    const type =
      priority === "out" ? NOTIFICATION_TYPES.OUT_OF_STOCK :
      priority === "critical" ? NOTIFICATION_TYPES.LOW_STOCK :
      NOTIFICATION_TYPES.WAREHOUSE_ALERT;

    if (!isTypeEnabled(settings, type)) continue;

    // Dedupe key includes the priority bucket so a low→critical escalation
    // still re-alerts, but re-scanning the same unchanged "critical" state
    // every 30 minutes does not spam the channel again the same day.
    const stateKey = `warehouse_${id}`;
    const prior = await getAlertState(restId, stateKey);
    const today = new Date().toDateString();
    if (prior && prior.priority === priority && prior.day === today) continue;

    const toBuy = minQty > 0 ? Math.max(0, minQty * 3 - qty) : 0;
    const text = renderWarehouseAlert(settings.language, {
      name: item.name || id,
      unit: item.unit || "",
      stock: qty,
      priority,
      daysRemaining,
      toBuy,
      supplierName: item.supplierName || item.supplier || "",
    });

    await NotificationService.send(type, restId, null, {}, { text });
    await setAlertState(restId, stateKey, { priority, day: today });
    alerted += 1;
  }

  return { scanned: items.length, alerted };
}
