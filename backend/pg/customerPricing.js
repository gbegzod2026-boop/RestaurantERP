// Server-authoritative customer order pricing.
// Client supplies product intent only. Prices, totals, and item operational
// fields never come from the request.
import { money } from "./shape.js";

export const CUSTOMER_MAX_QTY = 99;
export const CUSTOMER_MAX_WEIGHT_QTY = 100;
export const CUSTOMER_PROTECTED_ITEM_FIELDS = [
  "price", "unitPrice", "total", "subtotal", "lineTotal", "line_total",
  "discount", "discountAmount", "discountPercent", "cost", "costPrice",
  "paid", "paidAmount", "payment", "paymentStatus", "paymentMethod",
  "status", "statusKey", "kitchenStatus", "chefStatus", "chefId",
  "waiterId", "paidAt", "readyAt", "servedAt", "createdAt", "updatedAt",
];

export function customerPricingDenied(code, status = 400, details = null) {
  return {
    ok: false,
    error: status === 403 ? "Access Denied" : "Invalid order",
    status,
    code,
    details,
  };
}

export function roundMoney(value) {
  const n = money(value);
  return Math.round(n * 100) / 100;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function extraOf(row) {
  return asObject(row?.extra);
}

function productIdFromItem(item, fallbackKey) {
  const src = asObject(item);
  const raw = src.productId ?? src.menuId ?? src.itemId ?? src.id ?? fallbackKey;
  const id = String(raw || "").trim();
  if (!id || id === "undefined" || id === "null") return "";
  return id.split("::")[0].split("__")[0];
}

function variantIdFromItem(item, fallbackKey) {
  const src = asObject(item);
  if (src.variantId != null && String(src.variantId) !== "") return String(src.variantId);
  const key = String(fallbackKey || src.id || "");
  const base = key.split("::")[0];
  if (base.includes("__")) return base.split("__")[1] || "";
  return "";
}

function parseQuantity(item, isWeightBased) {
  const src = asObject(item);
  const raw = src.qty ?? src.quantity ?? src.count;
  const qty = Number(raw);
  if (!Number.isFinite(qty)) return { ok: false, code: "qty_invalid" };
  if (qty <= 0) return { ok: false, code: "qty_invalid" };
  if (isWeightBased) {
    if (qty > CUSTOMER_MAX_WEIGHT_QTY) return { ok: false, code: "qty_excessive" };
    return { ok: true, qty: roundMoney(qty) };
  }
  if (!Number.isInteger(qty)) return { ok: false, code: "qty_invalid" };
  if (qty > CUSTOMER_MAX_QTY) return { ok: false, code: "qty_excessive" };
  return { ok: true, qty };
}

function isCustomerHidden(row) {
  const extra = extraOf(row);
  if (row.active === false) return "product_unavailable";
  if (extra.hidden === true || extra.adminOnly === true || extra.staffOnly === true) return "product_hidden";
  if (extra.customerVisible === false || extra.visible === false) return "product_hidden";
  if (extra.visibility === "staff" || extra.visibility === "admin") return "product_hidden";
  return null;
}

function findVariant(row, variantId) {
  if (!variantId) return null;
  const variants = row.variants;
  if (!variants) return { missing: true };
  if (Array.isArray(variants)) {
    const found = variants.find((item) => String(item?.id || item?.variantId || "") === String(variantId));
    return found ? { variant: found } : { missing: true };
  }
  if (typeof variants === "object") {
    if (Object.prototype.hasOwnProperty.call(variants, variantId)) return { variant: variants[variantId] };
    const found = Object.values(variants).find((item) => item && String(item.id || "") === String(variantId));
    return found ? { variant: found } : { missing: true };
  }
  return { missing: true };
}

function modifierIdsFromItem(item) {
  const src = asObject(item);
  const raw = src.modifierIds || src.modifiers || src.options || [];
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === "object" ? Object.values(raw) : []);
  return list.map((entry) => {
    if (entry == null) return null;
    if (typeof entry === "string" || typeof entry === "number") {
      return { id: String(entry), groupId: "" };
    }
    const id = String(entry.optId || entry.id || entry.modifierId || entry.legacy_rtdb_id || "").trim();
    const groupId = String(entry.groupId || entry.group || entry.modifierGroupId || "").trim();
    if (!id && !groupId) return null;
    return { id: id || groupId, groupId };
  }).filter(Boolean);
}

function collectRelationshipIds(...values) {
  const ids = [];
  const walk = (value) => {
    if (value == null || value === "") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value === "object") {
      const nested = value.id || value.groupId || value.modifierId || value.modifierGroupId
        || value.extraId || value.legacy_rtdb_id;
      if (nested != null && nested !== "") {
        walk(nested);
        return;
      }
      for (const [key, item] of Object.entries(value)) {
        if (item === false || item == null) continue;
        if (item === true) ids.push(String(key));
        else walk(item);
      }
      return;
    }
    const id = String(value).trim();
    if (id && id !== "undefined" && id !== "null") ids.push(id);
  };
  for (const value of values) walk(value);
  return ids;
}

function isUnavailableFlag(row) {
  if (!row || row.active === false) return true;
  const extra = extraOf(row);
  if (extra.active === false) return true;
  if (extra.hidden === true || extra.adminOnly === true || extra.staffOnly === true) return true;
  if (extra.customerVisible === false || extra.visible === false) return true;
  if (extra.visibility === "staff" || extra.visibility === "admin") return true;
  return false;
}

/** Explicit product↔modifier associations only. Missing/empty metadata = deny. */
export function resolveAllowedModifierRelationships(product, { variantId } = {}) {
  const extra = extraOf(product);
  const groupIds = new Set(collectRelationshipIds(
    extra.modifierIds,
    extra.modifierGroupIds,
    extra.allowedModifierIds,
    extra.allowedModifierGroupIds,
    extra.modifierGroups,
    extra.groups,
    extra.modifiers,
    product.modifierIds,
    product.modifierGroupIds,
  ));
  const extraIds = new Set(collectRelationshipIds(
    extra.extraIds,
    extra.extras,
    extra.allowedExtras,
    product.extraIds,
  ));
  if (variantId) {
    const found = findVariant(product, variantId);
    const variant = found?.variant;
    if (variant && typeof variant === "object") {
      for (const id of collectRelationshipIds(variant.modifierIds, variant.modifierGroupIds, variant.modifiers, variant.groups)) {
        groupIds.add(id);
      }
      for (const id of collectRelationshipIds(variant.extraIds, variant.extras, variant.allowedExtras)) {
        extraIds.add(id);
      }
    }
  }
  return { groupIds, extraIds };
}

function groupOptionIds(modRow) {
  const options = extraOf(modRow).options;
  if (!options || typeof options !== "object" || Array.isArray(options)) return null;
  const keys = Object.keys(options);
  return keys.length ? new Set(keys.map(String)) : null;
}

function priceFromAllowedGroup(modRow, optionId) {
  if (!modRow || isUnavailableFlag(modRow)) return null;
  const extra = extraOf(modRow);
  const optionKeys = groupOptionIds(modRow);
  if (optionKeys) {
    if (!optionId || !optionKeys.has(String(optionId))) return null;
    const option = asObject(extra.options[optionId]);
    if (option.active === false || option.hidden === true) return null;
    return {
      id: String(optionId),
      name: option.name || modRow.name,
      price: roundMoney(option.price ?? option.priceDelta ?? extra.price_delta ?? modRow.price_delta),
    };
  }
  const groupId = String(modRow.legacy_rtdb_id || modRow.id);
  if (optionId && String(optionId) !== groupId) return null;
  return {
    id: groupId,
    name: modRow.name,
    price: roundMoney(modRow.price_delta ?? extra.price ?? 0),
  };
}

function priceRequestedModifier(catalog, allowed, mod) {
  if (mod.groupId) {
    if (!allowed.groupIds.has(mod.groupId)) return { deny: "modifier_foreign" };
    const priced = priceFromAllowedGroup(catalog.modifiersByGroupId?.get(mod.groupId), mod.id);
    return priced ? { priced, groupId: mod.groupId } : { deny: "modifier_unknown" };
  }
  if (allowed.groupIds.has(mod.id)) {
    const priced = priceFromAllowedGroup(catalog.modifiersByGroupId?.get(mod.id), mod.id);
    return priced ? { priced, groupId: mod.id } : { deny: "modifier_unknown" };
  }
  const optionHits = [];
  for (const groupId of allowed.groupIds) {
    const priced = priceFromAllowedGroup(catalog.modifiersByGroupId?.get(groupId), mod.id);
    if (priced) optionHits.push({ priced, groupId });
  }
  if (optionHits.length === 1) return optionHits[0];
  if (optionHits.length > 1) return { deny: "modifier_foreign" };
  if (allowed.extraIds.has(mod.id)) {
    const extraRow = catalog.extrasByLegacy.get(mod.id);
    if (extraRow && !isUnavailableFlag(extraRow)) {
      return {
        priced: {
          id: extraRow.legacy_rtdb_id || String(extraRow.id),
          name: extraRow.name,
          price: roundMoney(extraRow.price),
        },
        groupId: "",
      };
    }
    return { deny: "modifier_unknown" };
  }
  return { deny: "modifier_foreign" };
}

export async function loadCustomerCatalog(client, restaurantUuid) {
  const menu = await client.query(
    `SELECT id, legacy_rtdb_id, name, price, active, is_weight_based, variants, extra
       FROM menu_items WHERE restaurant_id = $1`,
    [restaurantUuid]
  );
  const modifiers = await client.query(
    `SELECT id, legacy_rtdb_id, name, price_delta, active, extra
       FROM modifiers WHERE restaurant_id = $1`,
    [restaurantUuid]
  );
  const extras = await client.query(
    `SELECT id, legacy_rtdb_id, name, price, active, extra
       FROM extras WHERE restaurant_id = $1`,
    [restaurantUuid]
  );
  const stopped = await client.query(
    `SELECT legacy_menu_id, menu_item_id FROM stop_list WHERE restaurant_id = $1`,
    [restaurantUuid]
  );
  const menuByLegacy = new Map();
  const menuByUuid = new Map();
  for (const row of menu.rows) {
    if (row.legacy_rtdb_id) menuByLegacy.set(String(row.legacy_rtdb_id), row);
    menuByUuid.set(String(row.id), row);
  }
  const modifiersByGroupId = new Map();
  for (const row of modifiers.rows) {
    if (row.legacy_rtdb_id) modifiersByGroupId.set(String(row.legacy_rtdb_id), row);
    modifiersByGroupId.set(String(row.id), row);
  }
  const extrasByLegacy = new Map();
  for (const row of extras.rows) {
    if (row.legacy_rtdb_id) extrasByLegacy.set(String(row.legacy_rtdb_id), row);
    extrasByLegacy.set(String(row.id), row);
  }
  const stop = new Set();
  for (const row of stopped.rows) {
    if (row.legacy_menu_id) stop.add(String(row.legacy_menu_id));
    if (row.menu_item_id) stop.add(String(row.menu_item_id));
  }
  return { menuByLegacy, menuByUuid, modifiersByGroupId, modifiersByLegacy: modifiersByGroupId, extrasByLegacy, stop };
}

function resolveProduct(catalog, productId) {
  return catalog.menuByLegacy.get(String(productId)) || catalog.menuByUuid.get(String(productId)) || null;
}

export function priceCustomerLineFromCatalog(catalog, item, fallbackKey) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return customerPricingDenied("item_invalid");
  }
  const productId = productIdFromItem(item, fallbackKey);
  if (!productId) return customerPricingDenied("product_required");
  const row = resolveProduct(catalog, productId);
  if (!row) return customerPricingDenied("product_unknown", 403);
  const hidden = isCustomerHidden(row);
  if (hidden) return customerPricingDenied(hidden, 403);
  if (catalog.stop.has(String(row.legacy_rtdb_id)) || catalog.stop.has(String(row.id))) {
    return customerPricingDenied("product_unavailable", 403);
  }
  const qtyInfo = parseQuantity(item, row.is_weight_based === true);
  if (!qtyInfo.ok) return customerPricingDenied(qtyInfo.code);
  let unit = roundMoney(row.price);
  const variantId = variantIdFromItem(item, fallbackKey);
  let variantSnapshot = null;
  if (variantId) {
    const found = findVariant(row, variantId);
    if (!found || found.missing || !found.variant) return customerPricingDenied("variant_unknown", 403);
    unit = roundMoney(found.variant.price ?? found.variant.unitPrice ?? unit);
    variantSnapshot = found.variant;
  }
  const requestedMods = modifierIdsFromItem(item);
  const seen = new Set();
  const pricedMods = [];
  const allowed = resolveAllowedModifierRelationships(row, { variantId });
  for (const mod of requestedMods) {
    const dupKey = `${mod.groupId}:${mod.id}`;
    if (seen.has(dupKey) || seen.has(mod.id)) return customerPricingDenied("modifier_duplicate");
    seen.add(dupKey);
    seen.add(mod.id);
    if (allowed.groupIds.size === 0 && allowed.extraIds.size === 0) {
      return customerPricingDenied("modifier_not_associated", 403);
    }
    const resolved = priceRequestedModifier(catalog, allowed, mod);
    if (resolved.deny) return customerPricingDenied(resolved.deny, 403);
    const priced = resolved.priced;
    if (!priced) return customerPricingDenied("modifier_unknown", 403);
    unit = roundMoney(unit + priced.price);
    pricedMods.push({
      id: priced.id,
      name: priced.name,
      price: priced.price,
      ...(resolved.groupId ? { groupId: resolved.groupId } : {}),
    });
  }
  const lineTotal = roundMoney(unit * qtyInfo.qty);
  const note = item.customerNote || item.notes || item.comment || null;
  return {
    ok: true,
    item: {
      id: row.legacy_rtdb_id || productId,
      menuId: row.legacy_rtdb_id || productId,
      productId: row.legacy_rtdb_id || productId,
      name: row.name,
      price: unit,
      qty: qtyInfo.qty,
      status: "pending",
      kitchenStatus: null,
      ...(variantId ? { variantId, variant: variantSnapshot } : {}),
      ...(pricedMods.length ? { modifiers: pricedMods } : {}),
      ...(note ? { notes: String(note).slice(0, 500) } : {}),
    },
    unitPrice: unit,
    lineTotal,
  };
}

export async function priceCustomerOrderItems(client, ctx, itemsObj) {
  if (itemsObj == null) return { ok: true, items: {}, total: 0 };
  if (typeof itemsObj !== "object") return customerPricingDenied("items_invalid");
  const catalog = await loadCustomerCatalog(client, ctx.restaurantUuid);
  const entries = Array.isArray(itemsObj)
    ? itemsObj.map((item, index) => [item?.id || item?.key || `item_${index}`, item])
    : Object.entries(itemsObj);
  const priced = {};
  let total = 0;
  for (const [key, item] of entries) {
    if (item == null) continue;
    const result = priceCustomerLineFromCatalog(catalog, item, key);
    if (!result.ok) return result;
    priced[key] = result.item;
    total = roundMoney(total + result.lineTotal);
  }
  return { ok: true, items: priced, total, subtotal: total, originalTotal: total, discountAmount: 0 };
}
