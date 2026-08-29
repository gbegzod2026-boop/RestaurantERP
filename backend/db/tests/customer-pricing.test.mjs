import test from "node:test";
import assert from "node:assert/strict";
import {
  priceCustomerLineFromCatalog,
  resolveAllowedModifierRelationships,
  CUSTOMER_PROTECTED_ITEM_FIELDS,
} from "../../pg/customerPricing.js";

const PRODUCT = {
  id: "11111111-1111-1111-1111-111111111111",
  legacy_rtdb_id: "dish_1",
  name: { uz: "Osh" },
  price: 10000,
  active: true,
  is_weight_based: false,
  variants: { large: { id: "large", price: 15000, name: "Large" } },
  extra: { modifierIds: ["mod_group"] },
};

function catalog(overrides = {}) {
  const product = { ...PRODUCT, ...(overrides.product || {}) };
  const modifier = {
    id: "22222222-2222-2222-2222-222222222222",
    legacy_rtdb_id: "mod_group",
    name: { uz: "Cheese" },
    price_delta: 2000,
    active: true,
    extra: { options: { cheese: { name: "Cheese", price: 2000 } } },
    ...(overrides.modifier || {}),
  };
  const other = {
    id: "33333333-3333-3333-3333-333333333333",
    legacy_rtdb_id: "mod_other",
    name: { uz: "Pepper" },
    price_delta: -9000,
    active: true,
    extra: { options: { pepper: { name: "Pepper", price: -9000 } } },
    ...(overrides.otherModifier || {}),
  };
  const modifiersByGroupId = new Map([
    [modifier.legacy_rtdb_id, modifier],
    [String(modifier.id), modifier],
    [other.legacy_rtdb_id, other],
    [String(other.id), other],
  ]);
  const extrasByLegacy = new Map(overrides.extras || []);
  return {
    menuByLegacy: new Map([[product.legacy_rtdb_id, product]]),
    menuByUuid: new Map([[product.id, product]]),
    modifiersByGroupId,
    modifiersByLegacy: modifiersByGroupId,
    extrasByLegacy,
    stop: new Set(overrides.stop || []),
  };
}

test("client prices and operational item fields are discarded; catalog price persists", () => {
  const priced = priceCustomerLineFromCatalog(catalog(), {
    productId: "dish_1",
    qty: 2,
    price: 0,
    unitPrice: 1,
    total: 1,
    discount: 999999,
    status: "ready",
    kitchenStatus: "cooking",
    chefStatus: "done",
    paid: true,
  }, "line_1");
  assert.equal(priced.ok, true);
  assert.equal(priced.item.price, 10000);
  assert.equal(priced.item.qty, 2);
  assert.equal(priced.lineTotal, 20000);
  assert.equal(priced.item.status, "pending");
  assert.equal(priced.item.kitchenStatus, null);
  for (const field of ["price", "status", "kitchenStatus"]) {
    assert.ok(CUSTOMER_PROTECTED_ITEM_FIELDS.includes(field));
  }
});

test("negative, zero, and excessive quantities are rejected", () => {
  assert.equal(priceCustomerLineFromCatalog(catalog(), { productId: "dish_1", qty: 0 }, "x").code, "qty_invalid");
  assert.equal(priceCustomerLineFromCatalog(catalog(), { productId: "dish_1", qty: -2 }, "x").code, "qty_invalid");
  assert.equal(priceCustomerLineFromCatalog(catalog(), { productId: "dish_1", qty: 100 }, "x").code, "qty_excessive");
});

test("unavailable, hidden, and unknown products are rejected", () => {
  assert.equal(priceCustomerLineFromCatalog(catalog(), { productId: "missing" }, "x").code, "product_unknown");
  const inactive = catalog({ product: { active: false } });
  assert.equal(priceCustomerLineFromCatalog(inactive, { productId: "dish_1", qty: 1 }, "x").code, "product_unavailable");
  const hidden = catalog({ product: { extra: { adminOnly: true } } });
  assert.equal(priceCustomerLineFromCatalog(hidden, { productId: "dish_1", qty: 1 }, "x").code, "product_hidden");
  const stopped = catalog({ stop: ["dish_1"] });
  assert.equal(priceCustomerLineFromCatalog(stopped, { productId: "dish_1", qty: 1 }, "x").code, "product_unavailable");
});

test("foreign or duplicate modifiers are rejected; catalog modifier price is used", () => {
  const ok = priceCustomerLineFromCatalog(catalog(), {
    productId: "dish_1",
    qty: 1,
    modifiers: [{ groupId: "mod_group", optId: "cheese", price: -50 }],
  }, "x");
  assert.equal(ok.ok, true);
  assert.equal(ok.item.price, 12000);
  assert.equal(ok.item.modifiers[0].price, 2000);
  const dup = priceCustomerLineFromCatalog(catalog(), {
    productId: "dish_1",
    qty: 1,
    modifiers: [
      { groupId: "mod_group", optId: "cheese" },
      { groupId: "mod_group", optId: "cheese" },
    ],
  }, "x");
  assert.equal(dup.code, "modifier_duplicate");
  const foreignGroup = priceCustomerLineFromCatalog(catalog(), {
    productId: "dish_1",
    qty: 1,
    modifiers: [{ groupId: "other_product_group", optId: "cheese" }],
  }, "x");
  assert.equal(foreignGroup.code, "modifier_foreign");
});

test("missing or empty product↔modifier metadata is deny, not allow-all", () => {
  for (const extra of [{}, { modifierIds: null }, { modifierIds: [] }, { modifierGroupIds: undefined }]) {
    const allowed = resolveAllowedModifierRelationships({ extra });
    assert.equal(allowed.groupIds.size, 0);
    assert.equal(allowed.extraIds.size, 0);
    const priced = priceCustomerLineFromCatalog(catalog({ product: { extra } }), {
      productId: "dish_1",
      qty: 1,
      modifiers: [{ groupId: "mod_group", optId: "cheese" }],
    }, "x");
    assert.equal(priced.ok, false);
    assert.equal(priced.code, "modifier_not_associated");
    assert.equal(priced.status, 403);
  }
});

test("Codex exploit: same-tenant unrelated modifier cannot change persisted price", () => {
  const attack = priceCustomerLineFromCatalog(catalog({ product: { extra: {} } }), {
    productId: "dish_1",
    qty: 1,
    price: 10000,
    modifiers: [{ id: "mod_other", price: -9000 }],
  }, "x");
  assert.equal(attack.ok, false);
  assert.equal(attack.code, "modifier_not_associated");
  assert.notEqual(attack.item?.price, 1000);
});

test("same-tenant modifier belonging to another product is denied", () => {
  const denied = priceCustomerLineFromCatalog(catalog(), {
    productId: "dish_1",
    qty: 1,
    modifiers: [{ groupId: "mod_other", optId: "pepper" }],
  }, "x");
  assert.equal(denied.code, "modifier_foreign");
});

test("option from another group is denied even when the product has an allowed group", () => {
  const wrongOption = priceCustomerLineFromCatalog(catalog(), {
    productId: "dish_1",
    qty: 1,
    modifiers: [{ groupId: "mod_group", optId: "pepper" }],
  }, "x");
  assert.equal(wrongOption.ok, false);
  assert.ok(["modifier_unknown", "modifier_foreign"].includes(wrongOption.code));
});

test("inactive or hidden modifiers are denied; client modifier price is ignored", () => {
  const inactive = priceCustomerLineFromCatalog(catalog({ modifier: { active: false } }), {
    productId: "dish_1",
    qty: 1,
    modifiers: [{ groupId: "mod_group", optId: "cheese" }],
  }, "x");
  assert.equal(inactive.ok, false);
  const hidden = priceCustomerLineFromCatalog(catalog({
    modifier: { extra: { options: { cheese: { name: "Cheese", price: 2000, hidden: true } } } },
  }), {
    productId: "dish_1",
    qty: 1,
    modifiers: [{ groupId: "mod_group", optId: "cheese" }],
  }, "x");
  assert.equal(hidden.ok, false);
  const ignoredClient = priceCustomerLineFromCatalog(catalog(), {
    productId: "dish_1",
    qty: 1,
    modifiers: [{ groupId: "mod_group", optId: "cheese", price: -9000 }],
  }, "x");
  assert.equal(ignoredClient.ok, true);
  assert.equal(ignoredClient.item.price, 12000);
  assert.equal(ignoredClient.item.modifiers[0].price, 2000);
  assert.equal(ignoredClient.lineTotal, 12000);
  const repriced = priceCustomerLineFromCatalog(catalog(), {
    productId: "dish_1",
    qty: 1,
    modifiers: [{ id: "cheese", name: "Cheese", price: -9000 }],
  }, "x");
  assert.equal(repriced.ok, true);
  assert.equal(repriced.item.price, 12000);
  assert.equal(repriced.item.modifiers[0].price, 2000);
});
