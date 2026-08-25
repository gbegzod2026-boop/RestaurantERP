// db/scripts/lib/run-engine.mjs — per-restaurant apply/dry-run/verify loop.
// Kept out of migrate-firebase.mjs so the transforms stay importable by tests
// without pulling the write path into the unit-test graph.
import { getValue } from "./fbRead.mjs";
import { OUTCOME, SEVERITY } from "./report.mjs";
import { upsertRow, resolveRestaurantUuid, countTable } from "./upsert.mjs";
import { toTimestamp, toDateKey } from "./normalize.mjs";
import * as w35 from "./transforms-wave35.mjs";

const WAVE2_CONFLICT = {
  customers: ["restaurant_id", "legacy_rtdb_id"],
  couriers: ["restaurant_id", "legacy_rtdb_id"],
  orders: ["restaurant_id", "legacy_rtdb_id"],
  order_change_requests: ["restaurant_id", "legacy_rtdb_id"],
  courier_assignments: ["restaurant_id", "legacy_rtdb_id"],
  reservations: ["restaurant_id", "legacy_rtdb_id"],
  order_items: ["order_id", "legacy_rtdb_id"],
  payments: ["restaurant_id", "legacy_order_id", "legacy_rtdb_id"],
  order_status_history: ["order_id", "status_raw", "changed_at"],
};

function drop(row, ...keys) {
  if (!row) return row;
  const out = { ...row };
  for (const k of keys) delete out[k];
  return out;
}

export async function accept(report, writer, {
  restId, entity, fbPath, legacyId, result, table, conflict, patch,
}) {
  const { row, issues, warnings } = result;
  for (const w of warnings || []) {
    report.warn({
      restId, entity, firebasePath: fbPath, legacyId,
      code: w.reason || w.code,
      detail: w.detail ?? (w.original !== undefined ? `${w.original} -> ${w.rounded}` : null),
    });
  }
  if (issues && issues.length) {
    const malformed = issues.some((x) => /not_an_object|missing/.test(x.reason || ""));
    report.lose({
      restId, entity, firebasePath: fbPath, legacyId,
      reason: issues[0].reason, severity: SEVERITY.ERROR,
      detail: issues.map((x) => `${x.field}:${x.reason}${x.detail ? `(${x.detail})` : ""}`).join("; "),
      outcome: malformed ? OUTCOME.MALFORMED : OUTCOME.SKIPPED,
    });
    return null;
  }
  if (!row) {
    report.lose({
      restId, entity, firebasePath: fbPath, legacyId,
      reason: "transform_produced_no_row", severity: SEVERITY.ERROR, outcome: OUTCOME.FAILED,
    });
    return null;
  }
  let stamped = { ...row };
  if (writer?.restaurantUuid) stamped.restaurant_id = writer.restaurantUuid;
  if (patch) stamped = patch(stamped);

  if (writer?.client && table && conflict) {
    try {
      await writer.client.query("SAVEPOINT rec");
      const wr = await upsertRow(writer.client, table, stamped, conflict);
      await writer.client.query("RELEASE SAVEPOINT rec");
      report.count(restId, entity, OUTCOME.MIGRATED);
      report.countWrite(wr.inserted ? "inserted" : "updated");
      return wr.id;
    } catch (err) {
      await writer.client.query("ROLLBACK TO SAVEPOINT rec").catch(() => {});
      report.lose({
        restId, entity, firebasePath: fbPath, legacyId,
        reason: "postgres_upsert_failed", severity: SEVERITY.ERROR,
        detail: err.message, outcome: OUTCOME.FAILED,
      });
      return null;
    }
  }
  report.count(restId, entity, OUTCOME.MIGRATED);
  return true;
}

async function migrateFlatCollection(restId, ctx, report, writer, {
  entity, collection, transform, table, conflict, extra,
}) {
  const node = await getValue(`restaurants/${restId}/${collection}`).catch(() => null);
  if (!node || typeof node !== "object") return 0;
  const entries = Object.entries(node);
  report.seen(restId, entity, entries.length);
  let n = 0;
  for (const [key, rec] of entries) {
    const result = transform(key, rec, ctx);
    const id = await accept(report, writer, {
      restId, entity,
      fbPath: `restaurants/${restId}/${collection}/${key}`,
      legacyId: key, result, table, conflict,
    });
    if (id && extra) await extra(key, rec, id);
    if (id) n++;
  }
  return n;
}

export async function runWaves35(restId, ctx, report, writer) {
  let touched = 0;
  if (!ctx.maps.suppliers) ctx.maps.suppliers = new Map();
  if (!ctx.maps.inventory) ctx.maps.inventory = new Map();
  if (!ctx.maps.semiFinished) ctx.maps.semiFinished = new Map();
  if (!ctx.maps.purchaseOrders) ctx.maps.purchaseOrders = new Map();

  touched += await migrateFlatCollection(restId, ctx, report, writer, {
    entity: "expenses", collection: "expenses",
    transform: w35.transformExpense, table: "expenses",
    conflict: ["restaurant_id", "legacy_rtdb_id"],
  });
  touched += await migrateFlatCollection(restId, ctx, report, writer, {
    entity: "suppliers", collection: "suppliers",
    transform: w35.transformSupplier, table: "suppliers",
    conflict: ["restaurant_id", "legacy_rtdb_id"],
    extra: async (key, _rec, id) => { if (id) ctx.maps.suppliers.set(key, id); },
  });

  // inventory ∪ ingredients
  {
    const inv = await getValue(`restaurants/${restId}/inventory`).catch(() => null) || {};
    const ing = await getValue(`restaurants/${restId}/ingredients`).catch(() => null) || {};
    const keys = new Set([...Object.keys(isObj(inv) ? inv : {}), ...Object.keys(isObj(ing) ? ing : {})]);
    if (keys.size) {
      report.seen(restId, "inventory_items", keys.size);
      touched += keys.size;
      for (const key of keys) {
        const a = isObj(inv) ? inv[key] : null;
        const b = isObj(ing) ? ing[key] : null;
        const tracked = a && b ? "both" : a ? "inventory" : "ingredients";
        const rec = a && b ? { ...b, ...a } : (a || b);
        if (a && b && a.stock != null && b.stock != null && a.stock !== b.stock) {
          report.warn({
            restId, entity: "inventory_items",
            firebasePath: `restaurants/${restId}/inventory/${key}`,
            legacyId: key, code: "inventory_ingredients_stock_disagree",
            detail: `inventory=${a.stock} ingredients=${b.stock}`,
          });
        }
        const result = w35.transformInventoryItem(key, rec, ctx, tracked);
        const id = await accept(report, writer, {
          restId, entity: "inventory_items",
          fbPath: `restaurants/${restId}/inventory/${key}`,
          legacyId: key, result, table: "inventory_items",
          conflict: ["restaurant_id", "legacy_rtdb_id"],
        });
        if (id) ctx.maps.inventory.set(key, id);
      }
    }
  }

  {
    const menu = await getValue(`restaurants/${restId}/menu`).catch(() => null);
    if (isObj(menu)) {
      for (const [menuId, rec] of Object.entries(menu)) {
        if (!isObj(rec) || !Array.isArray(rec.recipe) || rec.recipe.length === 0) continue;
        report.seen(restId, "recipes", 1);
        touched++;
        const yieldQty = rec.recipeYield ?? rec.yieldQty ?? 1;
        const result = {
          issues: Number(yieldQty) > 0 ? [] : [{ field: "yield_qty", reason: "yield_not_positive" }],
          warnings: [],
          row: {
            restaurant_id: ctx.restaurantId,
            menu_item_id: ctx.maps.menu.get(menuId) || null,
            legacy_menu_id: String(menuId),
            yield_qty: yieldQty,
            notes: rec.recipeNotes ?? null,
          },
        };
        const recipeId = await accept(report, writer, {
          restId, entity: "recipes",
          fbPath: `restaurants/${restId}/menu/${menuId}/recipe`,
          legacyId: menuId, result, table: "recipes",
          conflict: ["restaurant_id", "legacy_menu_id"],
        });
        for (let i = 0; i < rec.recipe.length; i++) {
          const line = rec.recipe[i];
          const body = isObj(line) ? line : { itemId: line };
          const itemId = body.itemId ?? body.id ?? body.ingredientId;
          const qty = body.qty ?? body.quantity ?? 1;
          report.seen(restId, "recipe_items", 1);
          touched++;
          const itemResult = {
            issues: Number(qty) > 0 ? [] : [{ field: "qty", reason: "recipe_item_qty_invalid" }],
            warnings: [],
            row: {
              restaurant_id: ctx.restaurantId,
              recipe_id: typeof recipeId === "string" ? recipeId : null,
              inventory_item_id: itemId ? ctx.maps.inventory.get(String(itemId)) || null : null,
              legacy_item_id: itemId != null ? String(itemId) : String(i),
              qty,
              unit: body.unit ?? null,
              sort_order: i,
            },
          };
          if (!itemResult.row.recipe_id) {
            report.count(restId, "recipe_items", OUTCOME.MIGRATED);
            continue;
          }
          await accept(report, writer, {
            restId, entity: "recipe_items",
            fbPath: `restaurants/${restId}/menu/${menuId}/recipe/${i}`,
            legacyId: `${menuId}/${i}`, result: itemResult, table: "recipe_items",
            conflict: ["recipe_id", "legacy_item_id"],
          });
        }
      }
    }
  }

  touched += await walkDateId(restId, ctx, report, writer, "dailyUsage", "daily_usage",
    (id, rec, dateKey) => w35.transformDailyUsage(id, rec, ctx, dateKey),
    ["restaurant_id", "usage_date", "legacy_item_id"]);

  {
    const node = await getValue(`restaurants/${restId}/purchaseOrders`).catch(() => null);
    if (isObj(node)) {
      const entries = Object.entries(node);
      report.seen(restId, "purchase_orders", entries.length);
      touched += entries.length;
      for (const [key, rec] of entries) {
        const result = w35.transformPurchaseOrder(key, rec, ctx);
        const poId = await accept(report, writer, {
          restId, entity: "purchase_orders",
          fbPath: `restaurants/${restId}/purchaseOrders/${key}`,
          legacyId: key, result, table: "purchase_orders",
          conflict: ["restaurant_id", "legacy_rtdb_id"],
        });
        if (poId) ctx.maps.purchaseOrders.set(key, poId);
        const items = Array.isArray(rec?.items)
          ? rec.items.map((it, i) => [String(i), it])
          : isObj(rec?.items) ? Object.entries(rec.items) : [];
        for (const [idx, it] of items) {
          report.seen(restId, "purchase_order_items", 1);
          touched++;
          const itemResult = w35.transformPoItem(idx, it, ctx);
          if (typeof poId === "string") {
            itemResult.row.purchase_order_id = poId;
            await accept(report, writer, {
              restId, entity: "purchase_order_items",
              fbPath: `restaurants/${restId}/purchaseOrders/${key}/items/${idx}`,
              legacyId: `${key}/${idx}`, result: itemResult, table: "purchase_order_items",
              conflict: ["purchase_order_id", "legacy_rtdb_id"],
            });
          } else {
            report.count(restId, "purchase_order_items", OUTCOME.MIGRATED);
          }
        }
      }
    }
  }
  touched += await migrateFlatCollection(restId, ctx, report, writer, {
    entity: "supplier_payments", collection: "poPayments",
    transform: w35.transformPoPayment, table: "supplier_payments",
    conflict: ["restaurant_id", "legacy_rtdb_id"],
  });
  touched += await migrateFlatCollection(restId, ctx, report, writer, {
    entity: "semi_finished", collection: "semiFinished",
    transform: w35.transformSemiFinished, table: "semi_finished",
    conflict: ["restaurant_id", "legacy_rtdb_id"],
    extra: async (key, _rec, id) => { if (id) ctx.maps.semiFinished.set(key, id); },
  });
  touched += await migrateFlatCollection(restId, ctx, report, writer, {
    entity: "semi_finished_acts", collection: "semiFinishedActs",
    transform: w35.transformSemiFinishedAct, table: "semi_finished_acts",
    conflict: ["restaurant_id", "legacy_rtdb_id"],
  });

  // finance namespace
  {
    const fin = await getValue(`restaurants/${restId}/finance`).catch(() => null);
    if (isObj(fin)) {
      touched += await walkMonthStaff(fin.payroll, restId, ctx, report, writer, "payroll", "payroll_entries");
      // adjustments is staffId/monthKey (reversed)
      if (isObj(fin.adjustments)) {
        for (const [staffId, months] of Object.entries(fin.adjustments)) {
          if (!isObj(months)) continue;
          for (const [monthKey, rec] of Object.entries(months)) {
            report.seen(restId, "payroll_entries", 1);
            touched++;
            const result = w35.transformPayroll(staffId, rec, ctx, monthKey, "adjustment");
            await accept(report, writer, {
              restId, entity: "payroll_entries",
              fbPath: `restaurants/${restId}/finance/adjustments/${staffId}/${monthKey}`,
              legacyId: `${staffId}/${monthKey}`, result,
              table: "payroll_entries",
              conflict: ["restaurant_id", "legacy_employee_id", "period_month", "entry_kind"],
            });
          }
        }
      }
      touched += await walkMonthStaff(fin.staff_stats, restId, ctx, report, writer, "staff", "staff_stats");
      if (isObj(fin.courier_stats)) {
        for (const [cid, months] of Object.entries(fin.courier_stats)) {
          if (!isObj(months)) continue;
          for (const [monthKey, rec] of Object.entries(months)) {
            report.seen(restId, "staff_stats", 1);
            touched++;
            const result = w35.transformStaffStat(cid, rec, ctx, monthKey, "courier");
            await accept(report, writer, {
              restId, entity: "staff_stats",
              fbPath: `restaurants/${restId}/finance/courier_stats/${cid}/${monthKey}`,
              legacyId: `${cid}/${monthKey}`, result,
              table: "staff_stats",
              conflict: ["restaurant_id", "legacy_employee_id", "stat_scope", "period_month"],
            });
          }
        }
      }
    }
  }

  // date-keyed
  touched += await walkDateId(restId, ctx, report, writer, "attendance", "attendance",
    (id, rec, dateKey) => w35.transformAttendance(id, rec, ctx, dateKey),
    ["restaurant_id", "work_date", "legacy_employee_id"]);
  touched += await migrateFlatCollection(restId, ctx, report, writer, {
    entity: "shifts", collection: "shifts",
    transform: w35.transformShift, table: "shifts",
    conflict: ["restaurant_id", "legacy_rtdb_id"],
  });
  {
    const node = await getValue(`restaurants/${restId}/chefTasks`).catch(() => null);
    for (const leaf of w35.walkOwnerDateId(node)) {
      report.seen(restId, "chef_tasks", 1);
      touched++;
      const result = w35.transformChefTask(leaf.key, leaf.rec, ctx, leaf.ownerId, leaf.dateKey);
      await accept(report, writer, {
        restId, entity: "chef_tasks",
        fbPath: `restaurants/${restId}/chefTasks/${leaf.pathKey}`,
        legacyId: leaf.pathKey, result, table: "chef_tasks",
        conflict: ["restaurant_id", "legacy_chef_id", "task_date", "legacy_rtdb_id"],
      });
    }
  }
  touched += await walkDateId(restId, ctx, report, writer, "wasteLog", "waste_log",
    (id, rec, dateKey) => w35.transformWaste(id, rec, ctx, dateKey),
    ["restaurant_id", "waste_date", "legacy_rtdb_id"]);
  touched += await walkDateId(restId, ctx, report, writer, "kitchenAnnouncements", "kitchen_announcements",
    (id, rec, dateKey) => w35.transformAnnouncement(id, rec, ctx, dateKey),
    ["restaurant_id", "announced_date", "legacy_rtdb_id"]);

  {
    const node = await getValue(`restaurants/${restId}/productionPlans`).catch(() => null);
    if (isObj(node)) {
      for (const [dateKey, plan] of Object.entries(node)) {
        const items = isObj(plan) ? (plan.items || plan) : null;
        if (!isObj(items)) continue;
        for (const [menuId, rec] of Object.entries(items)) {
          if (menuId === "items") continue;
          report.seen(restId, "production_plans", 1);
          touched++;
          const body = isObj(rec) ? rec : { qty: rec };
          const d = toDateKey(String(dateKey));
          const result = {
            issues: d.ok ? [] : [{ field: "plan_date", reason: d.reason, detail: dateKey }],
            warnings: [],
            row: {
              restaurant_id: ctx.restaurantId,
              plan_date: d.ok ? d.value : null,
              legacy_date_key: String(dateKey),
              menu_item_id: ctx.maps.menu.get(menuId) || null,
              legacy_menu_id: String(menuId),
              qty_planned: body.qty ?? body.planned ?? null,
              qty_produced: body.produced ?? null,
              extra: "{}",
            },
          };
          await accept(report, writer, {
            restId, entity: "production_plans",
            fbPath: `restaurants/${restId}/productionPlans/${dateKey}/items/${menuId}`,
            legacyId: `${dateKey}/${menuId}`, result, table: "production_plans",
            conflict: ["restaurant_id", "plan_date", "legacy_menu_id"],
          });
        }
      }
    }
  }

  touched += await migrateFlatCollection(restId, ctx, report, writer, {
    entity: "modifiers", collection: "modifiers",
    transform: (k, r, c) => {
      const x = w35.transformModifierOrExtra(k, r, c);
      if (x.row) { x.row.price_delta = x.row.price_delta ?? x.row.price; delete x.row.price; }
      return x;
    },
    table: "modifiers", conflict: ["restaurant_id", "legacy_rtdb_id"],
  });
  touched += await migrateFlatCollection(restId, ctx, report, writer, {
    entity: "extras", collection: "extras",
    transform: (k, r, c) => {
      const x = w35.transformModifierOrExtra(k, r, c);
      if (x.row) delete x.row.price_delta;
      return x;
    },
    table: "extras", conflict: ["restaurant_id", "legacy_rtdb_id"],
  });
  touched += await migrateFlatCollection(restId, ctx, report, writer, {
    entity: "discounts", collection: "discounts",
    transform: w35.transformDiscount, table: "discounts",
    conflict: ["restaurant_id", "code"],
  });
  touched += await migrateFlatCollection(restId, ctx, report, writer, {
    entity: "stop_list", collection: "stopList",
    transform: w35.transformStopList, table: "stop_list",
    conflict: ["restaurant_id", "legacy_menu_id"],
  });
  touched += await migrateFlatCollection(restId, ctx, report, writer, {
    entity: "waiter_calls", collection: "waiterCalls",
    transform: w35.transformWaiterCall, table: "waiter_calls",
    conflict: ["restaurant_id", "legacy_rtdb_id"],
  });

  for (const [entity, collection] of [["activity_logs", "activityLogs"], ["notifications_log", "notifications"], ["notifications_log", "kitchenNotifications"]]) {
    const transform = entity === "activity_logs" ? w35.transformActivityLog : w35.transformNotification;
    touched += await migrateFlatCollection(restId, ctx, report, writer, {
      entity, collection, transform, table: entity,
      conflict: ["restaurant_id", "legacy_rtdb_id"],
    });
  }
  for (const [collection, source] of [["auditLog", "auditLog"], ["audit_log", "audit_log"]]) {
    const node = await getValue(`restaurants/${restId}/${collection}`).catch(() => null);
    if (!isObj(node)) continue;
    const entries = Object.entries(node);
    report.seen(restId, "audit_log", entries.length);
    touched += entries.length;
    for (const [key, rec] of entries) {
      const result = w35.transformAudit(key, rec, ctx, source);
      await accept(report, writer, {
        restId, entity: "audit_log",
        fbPath: `restaurants/${restId}/${collection}/${key}`,
        legacyId: key, result, table: "audit_log",
        conflict: ["restaurant_id", "source_tree", "legacy_rtdb_id"],
      });
    }
  }
  {
    const node = await getValue(`restaurants/${restId}/systemAlerts`).catch(() => null);
    if (isObj(node)) {
      const entries = Object.entries(node);
      report.seen(restId, "system_alerts", entries.length);
      touched += entries.length;
      for (const [type, rec] of entries) {
        const result = w35.transformSystemAlert(type, rec, ctx);
        await accept(report, writer, {
          restId, entity: "system_alerts",
          fbPath: `restaurants/${restId}/systemAlerts/${type}`,
          legacyId: type, result, table: "system_alerts",
          conflict: ["restaurant_id", "alert_type"],
        });
      }
    }
  }
  touched += await migrateFlatCollection(restId, ctx, report, writer, {
    entity: "import_history", collection: "importHistory",
    transform: w35.transformImportHistory, table: "import_history",
    conflict: ["restaurant_id", "legacy_rtdb_id"],
  });
  {
    const node = await getValue(`restaurants/${restId}/orderTimeline`).catch(() => null);
    if (isObj(node)) {
      for (const [orderId, events] of Object.entries(node)) {
        if (!isObj(events)) continue;
        for (const [eid, rec] of Object.entries(events)) {
          report.seen(restId, "order_timeline", 1);
          touched++;
          const result = w35.transformOrderTimelineEvent(eid, rec, ctx, orderId);
          await accept(report, writer, {
            restId, entity: "order_timeline",
            fbPath: `restaurants/${restId}/orderTimeline/${orderId}/${eid}`,
            legacyId: eid, result, table: "order_timeline",
            conflict: ["restaurant_id", "legacy_order_id", "legacy_rtdb_id"],
          });
        }
      }
    }
  }
  {
    const node = await getValue(`restaurants/${restId}/chats`).catch(() => null);
    if (isObj(node)) {
      const entries = Object.entries(node);
      report.seen(restId, "chats", entries.length);
      touched += entries.length;
      for (const [key, rec] of entries) {
        const result = w35.transformChat(key, rec, ctx, "internal");
        const chatId = await accept(report, writer, {
          restId, entity: "chats",
          fbPath: `restaurants/${restId}/chats/${key}`,
          legacyId: key, result, table: "chats",
          conflict: ["restaurant_id", "legacy_rtdb_id"],
        });
        if (result.messages && isObj(result.messages)) {
          for (const [mid, msg] of Object.entries(result.messages)) {
            report.seen(restId, "chat_messages", 1);
            const sent = toTimestamp(msg?.sentAt ?? msg?.createdAt ?? msg?.ts);
            const mrow = {
              issues: sent.ok && sent.value ? [] : [{ field: "sent_at", reason: "timestamp_missing" }],
              warnings: [],
              row: {
                legacy_rtdb_id: mid,
                restaurant_id: ctx.restaurantId,
                chat_id: typeof chatId === "string" && chatId.includes("-") ? chatId : null,
                sender_id: msg?.senderId != null ? String(msg.senderId) : null,
                sender_name: msg?.senderName ?? null,
                body: msg?.text ?? msg?.body ?? null,
                sent_at: sent.ok ? sent.value : null,
                payload: "{}",
              },
            };
            if (mrow.row.chat_id) {
              await accept(report, writer, {
                restId, entity: "chat_messages",
                fbPath: `restaurants/${restId}/chats/${key}/messages/${mid}`,
                legacyId: mid, result: mrow, table: "chat_messages",
                conflict: ["chat_id", "legacy_rtdb_id"],
              });
            } else {
              report.count(restId, "chat_messages", OUTCOME.MIGRATED);
            }
          }
        }
      }
    }
  }
  {
    const sa = await getValue(`restaurants/${restId}/superadmin_chat`).catch(() => null);
    if (isObj(sa)) {
      report.seen(restId, "chats", 1);
      touched++;
      const result = w35.transformChat("superadmin_chat", sa, ctx, "superadmin");
      await accept(report, writer, {
        restId, entity: "chats",
        fbPath: `restaurants/${restId}/superadmin_chat`,
        legacyId: "superadmin_chat", result, table: "chats",
        conflict: ["restaurant_id", "legacy_rtdb_id"],
      });
    }
  }

  // print/terminal singletons
  for (const [collection, table] of [["printSettings", "print_settings"], ["terminalSettings", "terminal_settings"]]) {
    const node = await getValue(`restaurants/${restId}/${collection}`).catch(() => null);
    if (!node) continue;
    report.seen(restId, table, 1);
    touched++;
    const result = {
      issues: [], warnings: [],
      row: { restaurant_id: ctx.restaurantId, settings: JSON.stringify(node) },
    };
    await accept(report, writer, {
      restId, entity: table,
      fbPath: `restaurants/${restId}/${collection}`,
      legacyId: collection, result, table,
      conflict: ["restaurant_id"],
    });
  }

  return touched;
}

function isObj(v) { return !!v && typeof v === "object" && !Array.isArray(v); }

async function walkDateId(restId, ctx, report, writer, collection, entity, transform, conflict) {
  const node = await getValue(`restaurants/${restId}/${collection}`).catch(() => null);
  let n = 0;
  for (const leaf of w35.walkDateThenId(node)) {
    report.seen(restId, entity, 1);
    n++;
    const result = transform(leaf.key, leaf.rec, leaf.dateKey);
    await accept(report, writer, {
      restId, entity,
      fbPath: `restaurants/${restId}/${collection}/${leaf.pathKey}`,
      legacyId: leaf.pathKey, result, table: entity, conflict,
    });
  }
  return n;
}

async function walkMonthStaff(node, restId, ctx, report, writer, kind, entity) {
  if (!isObj(node)) return 0;
  let n = 0;
  // payroll is monthKey/staffId
  for (const [a, inner] of Object.entries(node)) {
    if (!isObj(inner)) continue;
    for (const [b, rec] of Object.entries(inner)) {
      const monthKey = /^\d{4}-\d{2}$/.test(a) ? a : b;
      const staffId = monthKey === a ? b : a;
      report.seen(restId, entity, 1);
      n++;
      const result = entity === "payroll_entries"
        ? w35.transformPayroll(staffId, rec, ctx, monthKey, kind)
        : w35.transformStaffStat(staffId, rec, ctx, monthKey, kind);
      await accept(report, writer, {
        restId, entity,
        fbPath: `restaurants/${restId}/finance/${entity}/${a}/${b}`,
        legacyId: `${a}/${b}`, result, table: entity,
        conflict: entity === "payroll_entries"
          ? ["restaurant_id", "legacy_employee_id", "period_month", "entry_kind"]
          : ["restaurant_id", "legacy_employee_id", "stat_scope", "period_month"],
      });
    }
  }
  return n;
}

export { WAVE2_CONFLICT, drop };

export const PG_COUNT_TABLES = [
  "customers", "couriers", "orders", "order_items", "order_status_history",
  "payments", "order_change_requests", "courier_assignments", "reservations",
  "expenses", "suppliers", "inventory_items", "purchase_orders", "supplier_payments",
  "semi_finished", "payroll_entries", "staff_stats", "attendance", "shifts",
  "chef_tasks", "waste_log", "kitchen_announcements", "production_plans",
  "modifiers", "extras", "discounts", "waiter_calls", "activity_logs", "audit_log",
  "notifications_log", "system_alerts", "import_history", "order_timeline",
  "chats", "chat_messages", "print_settings", "terminal_settings",
  "recipes", "recipe_items", "daily_usage", "purchase_order_items", "stop_list",
  "semi_finished_acts",
];

export async function postgresCounts(client) {
  const out = {};
  for (const t of PG_COUNT_TABLES) {
    try { out[t] = await countTable(client, t); }
    catch { out[t] = null; }
  }
  return out;
}
