// db/tests/migration.test.mjs — tests the migration TRANSFORM layer: the
// functions in db/scripts/migrate-firebase.mjs that turn a raw Firebase
// record into a PostgreSQL row.
//
// normalize.test.mjs proves the individual converters. This file proves the
// record-level decisions built on top of them: what makes a record fatal vs.
// merely warned, that snapshots survive a deleted menu item, that unmapped
// fields land in `extra`, and that the same input always produces the same
// output (the precondition for idempotency).
//
// No PostgreSQL and no Firebase needed — the transforms are pure functions of
// (key, record, ctx), which is exactly why they were made importable.
//
// Run: node --test db/tests/
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  transformCustomer, transformOrder, transformOrderItem, transformReservation,
  transformCourier, transformCourierAssignment, transformChangeRequest,
  transformPayment, emptyMaps, ENTITIES,
} from "../scripts/migrate-firebase.mjs";
import { MigrationReport, OUTCOME, SEVERITY } from "../scripts/lib/report.mjs";

const REST = "rest_1784740340104";

/** Builds a transform context, merging any supplied reference maps over the
 *  empty set so a test only has to declare the lookups it cares about. */
function ctx({ maps: partialMaps = {}, ...rest } = {}) {
  const maps = Object.assign(emptyMaps(), partialMaps);
  return { restaurantId: REST, maps, ...rest };
}

/** A minimally valid live-shaped order. */
function anOrder(extra = {}) {
  return {
    orderNumber: 31,
    statusV2: "completed",
    createdAt: 1785423219027,
    total: 44131.5,
    table: "5",
    ...extra,
  };
}

describe("determinism — the precondition for idempotency", () => {
  test("the same record transforms to an identical row every time", () => {
    const rec = anOrder({ notes: "no onions", waiterId: "u1" });
    const a = transformOrder("-OyOwWcj0dboNzX_ROxz", rec, ctx());
    const b = transformOrder("-OyOwWcj0dboNzX_ROxz", rec, ctx());
    assert.deepEqual(a.row, b.row);
    assert.deepEqual(a.warnings, b.warnings);
  });

  test("no transform injects a wall-clock value", () => {
    // If any column were filled with now(), two runs a moment apart would
    // differ and re-running the migration would rewrite unchanged rows.
    const rec = anOrder();
    const first = transformOrder("k", rec, ctx()).row;
    const second = transformOrder("k", rec, ctx()).row;
    assert.deepEqual(first, second);
    assert.equal(first.updated_at, null, "updated_at must stay null when Firebase has none");
  });

  test("every entity's transform carries the key into legacy_rtdb_id", () => {
    // legacy_rtdb_id is the conflict target that makes apply idempotent, so
    // a transform that dropped it would silently break re-runs.
    const c = ctx();
    assert.equal(transformCustomer("+998902651475", { name: "A" }, c).row.legacy_rtdb_id, "+998902651475");
    assert.equal(transformOrder("-Oab", anOrder(), c).row.legacy_rtdb_id, "-Oab");
    assert.equal(transformCourier("-Ocr", { name: "C" }, c).row.legacy_rtdb_id, "-Ocr");
    assert.equal(transformReservation("-Ors", { date: "2026-04-07" }, c).row.legacy_rtdb_id, "-Ors");
    assert.equal(
      transformOrderItem("mid__1785423219027", { name: "Osh", price: 30000 }, c, "-Oab").row.legacy_rtdb_id,
      "mid__1785423219027"
    );
  });

  test("every entity in the pipeline is tenant-stamped", () => {
    const c = ctx();
    const rows = [
      transformCustomer("+998902651475", { name: "A" }, c).row,
      transformOrder("-Oab", anOrder(), c).row,
      transformCourier("-Ocr", { name: "C" }, c).row,
      transformCourierAssignment("-Oca", { orderId: "-Oab", courierId: "-Ocr" }, c).row,
      transformReservation("-Ors", { date: "2026-04-07" }, c).row,
      transformPayment("-Oab", { method: "cash", paid: true }, c).row,
    ];
    for (const r of rows) assert.equal(r.restaurant_id, REST);
  });
});

describe("order snapshots stay immutable (requirement #5)", () => {
  test("a deleted menu item still keeps its name and price on the order", () => {
    // 10 live order items reference a menu item that no longer exists.
    const r = transformOrderItem(
      "deleted_menu_id__1785423219027",
      { name: { uz: "Lag'mon" }, price: 35000, qty: 2 },
      ctx(),   // empty menu map = the dish was deleted
      "-Oab"
    );
    assert.equal(r.row.menu_item_id, null, "FK must be null, not fabricated");
    assert.equal(r.row.legacy_menu_id, "deleted_menu_id");
    assert.equal(JSON.parse(r.row.name_snapshot).uz, "Lag'mon");
    assert.equal(r.row.price_snapshot, "35000.00");
    assert.ok(r.warnings.some((w) => w.reason === "menu_item_reference_unresolved"));
    assert.equal(r.issues.length, 0, "an unresolved menu reference must not be fatal");
  });

  test("the snapshot price is the order's price, not the menu's current price", () => {
    const maps = { menu: new Map([["mid", "uuid-of-menu-item"]]) };
    const r = transformOrderItem("mid__1", { name: "Osh", price: 25000, qty: 1 }, ctx({ maps }), "-Oab");
    assert.equal(r.row.menu_item_id, "uuid-of-menu-item", "FK resolves when the dish exists");
    assert.equal(r.row.price_snapshot, "25000.00", "price is still the historical one");
  });

  test("modifiers and extras are preserved verbatim", () => {
    const mods = [{ name: "extra cheese", price: 5000 }];
    const r = transformOrderItem("mid__1", { name: "Pizza", price: 50000, modifiers: mods, extras: ["sauce"] }, ctx(), "-Oab");
    assert.deepEqual(JSON.parse(r.row.modifiers), mods);
    assert.deepEqual(JSON.parse(r.row.extras), ["sauce"]);
  });

  test("a missing line total is computed and the computation is disclosed", () => {
    // No live order item stores `total`; all 147 take this path.
    const r = transformOrderItem("mid__1", { name: "Osh", price: 30000, qty: 3 }, ctx(), "-Oab");
    assert.equal(r.row.line_total, "90000.00");
    assert.ok(r.warnings.some((w) => w.reason === "line_total_computed_from_price_x_qty"),
      "a derived value must be reported, never presented as source data");
  });

  test("an item with no name or price is fatal, not silently zero-filled", () => {
    const noName = transformOrderItem("mid__1", { price: 1000 }, ctx(), "-Oab");
    assert.ok(noName.issues.some((i) => i.reason === "item_name_missing"));
    const noPrice = transformOrderItem("mid__1", { name: "Osh" }, ctx(), "-Oab");
    assert.ok(noPrice.issues.some((i) => i.reason === "item_price_missing"));
  });
});

describe("malformed records fail loudly (requirement #15)", () => {
  test("a non-object record is fatal for every transform", () => {
    const c = ctx();
    for (const [label, fn] of [
      ["customer", () => transformCustomer("k", "a string", c)],
      ["order", () => transformOrder("k", 42, c)],
      ["courier", () => transformCourier("k", null, c)],
      ["reservation", () => transformReservation("k", [], c)],
    ]) {
      const r = fn();
      assert.equal(r.row, null, `${label} produced a row from a non-object`);
      assert.ok(r.issues.some((i) => i.reason === "record_not_an_object"), label);
    }
  });

  test("an order with an unmappable status is fatal", () => {
    const r = transformOrder("k", anOrder({ statusV2: "brand_new_status" }), ctx());
    assert.ok(r.issues.some((i) => i.reason === "order_status_unknown_value"));
  });

  test("an order with no createdAt is fatal — the timestamp is never invented", () => {
    const rec = anOrder();
    delete rec.createdAt;
    const r = transformOrder("k", rec, ctx());
    assert.ok(r.issues.some((i) => i.reason === "createdAt_missing"));
    assert.equal(r.row.created_at, null);
  });

  test("an order with a garbage createdAt is fatal, not silently 1970", () => {
    const r = transformOrder("k", anOrder({ createdAt: 0 }), ctx());
    assert.ok(r.issues.some((i) => i.field === "createdAt"));
    assert.equal(r.row.created_at, null);
  });

  test("a change request with no requestType is fatal", () => {
    const r = transformChangeRequest("k", { orderId: "-Oab", status: "pending" }, ctx());
    assert.ok(r.issues.some((i) => i.reason === "change_request_type_missing"));
  });

  test("a bad reservation date is warned, not fatal — the row still migrates", () => {
    const r = transformReservation("k", { date: "not-a-date", time: "19:00" }, ctx());
    assert.equal(r.issues.length, 0);
    assert.equal(r.row.reserved_date, null);
    assert.ok(r.warnings.some((w) => w.field === "date"));
  });
});

describe("order type is inferred only from evidence (rule #20)", () => {
  test("an explicit orderType is used as-is", () => {
    const r = transformOrder("k", anOrder({ orderType: "delivery" }), ctx());
    assert.equal(r.row.order_type, "delivery");
    assert.equal(r.warnings.filter((w) => w.field === "orderType").length, 0);
  });

  test("a table implies dine_in, and the inference is disclosed", () => {
    const r = transformOrder("k", anOrder({ table: "7" }), ctx());
    assert.equal(r.row.order_type, "dine_in");
    assert.ok(r.warnings.some((w) => w.reason === "order_type_inferred_dine_in_from_table_present"));
  });

  test("delivery evidence implies delivery", () => {
    const rec = anOrder({ isDelivery: true });
    delete rec.table;
    assert.equal(transformOrder("k", rec, ctx()).row.order_type, "delivery");

    const rec2 = anOrder({ deliveryAddress: { street: "x" } });
    delete rec2.table;
    assert.equal(transformOrder("k", rec2, ctx()).row.order_type, "delivery");
  });

  test("no evidence yields 'unknown' rather than a convenient default", () => {
    const rec = anOrder();
    delete rec.table;
    const r = transformOrder("k", rec, ctx());
    assert.equal(r.row.order_type, "unknown");
    assert.ok(r.warnings.some((w) => w.reason === "order_type_unknown_no_evidence"));
  });
});

describe("foreign keys resolve or go null — never fabricated", () => {
  test("an unresolved waiter nulls the FK, keeps the row, and warns", () => {
    // 29 live orders reference an employee who has since been deleted.
    const r = transformOrder("k", anOrder({ waiterId: "deleted_user" }), ctx());
    assert.equal(r.row.waiter_id, null);
    assert.equal(r.issues.length, 0);
    assert.ok(r.warnings.some((w) => w.reason === "employee_reference_unresolved"));
  });

  test("an unresolved table nulls the FK but preserves the label", () => {
    const r = transformOrder("k", anOrder({ table: "99" }), ctx());
    assert.equal(r.row.table_id, null);
    assert.equal(r.row.table_label, "99", "the order still records which table it claimed");
    assert.ok(r.warnings.some((w) => w.reason === "table_reference_unresolved"));
  });

  test("a table resolves by number as well as by key", () => {
    const maps = { tablesByNumber: new Map([["5", "table-uuid"]]) };
    assert.equal(transformOrder("k", anOrder({ table: "5" }), ctx({ maps })).row.table_id, "table-uuid");
  });

  test("a customer is matched by NORMALIZED phone, across key formats", () => {
    const maps = { customersByPhone: new Map([["+998902651475", "cust-uuid"]]) };
    // The order stores the bare local form; the customer key is E.164.
    const r = transformOrder("k", anOrder({ customerPhone: "902651475" }), ctx({ maps }));
    assert.equal(r.row.customer_id, "cust-uuid");
    assert.equal(r.row.customer_phone_snapshot, "902651475", "the raw form is still preserved");
  });
});

describe("customers (requirement #7)", () => {
  test("the phone key becomes legacy id + original key + normalized phone", () => {
    const r = transformCustomer("%2B998902651475", { name: "Ali" }, ctx());
    assert.equal(r.row.legacy_rtdb_id, "%2B998902651475", "the exact RTDB key is retained");
    assert.equal(r.row.original_phone_key, "+998902651475");
    assert.equal(r.row.normalized_phone, "+998902651475");
  });

  test("an unparseable phone key still migrates, with a null normalized phone", () => {
    const r = transformCustomer("walkin", { name: "Guest" }, ctx());
    assert.equal(r.issues.length, 0);
    assert.equal(r.row.normalized_phone, null);
    assert.ok(r.warnings.some((w) => w.reason === "phone_unparseable"));
  });

  test("two different phone formats of one person normalize identically", () => {
    // This is what makes the duplicate DETECTABLE. It is reported, not merged.
    const a = transformCustomer("902651475", {}, ctx()).row.normalized_phone;
    const b = transformCustomer("%2B998902651475", {}, ctx()).row.normalized_phone;
    assert.equal(a, b);
  });

  test("counters default to zero but the phone is never invented", () => {
    const r = transformCustomer("+998901112233", {}, ctx());
    assert.equal(r.row.total_spent, "0.00");
    assert.equal(r.row.orders_count, 0);
    assert.equal(r.row.name, null, "a missing name stays null");
    assert.equal(r.row.last_visit, null);
  });
});

describe("nothing is silently dropped", () => {
  test("an unmapped order field survives in extra", () => {
    const r = transformOrder("k", anOrder({ someFutureField: "important" }), ctx());
    assert.equal(JSON.parse(r.row.extra).someFutureField, "important");
  });

  test("mapped fields are NOT duplicated into extra", () => {
    const r = transformOrder("k", anOrder(), ctx());
    const extra = JSON.parse(r.row.extra);
    for (const k of ["total", "statusV2", "createdAt", "orderNumber", "table"]) {
      assert.equal(k in extra, false, `${k} was mapped and must not be duplicated into extra`);
    }
  });

  test("all four raw status fields are retained alongside the canonical one", () => {
    const r = transformOrder("k", anOrder({
      status: "to'landi", statusKey: "completed", statusV2: "completed", statusLabel: "To'landi",
    }), ctx());
    assert.equal(r.row.status, "completed");
    assert.equal(r.row.status_raw, "to'landi");
    assert.equal(r.row.status_key_raw, "completed");
    assert.equal(r.row.status_v2_raw, "completed");
    assert.equal(r.row.status_label_raw, "To'landi");
  });

  test("payments keep the raw method next to the canonical one", () => {
    const r = transformPayment("-Oab", { method: "Naqd", paid: true, finalTotal: 44131.5 }, ctx());
    assert.equal(r.row.method, "cash");
    assert.equal(r.row.method_raw, "Naqd");
    assert.equal(r.row.final_total, "44131.50");
  });
});

describe("migration ordering respects dependencies (requirement #13)", () => {
  test("customers and couriers are transformed before orders reference them", () => {
    const names = ENTITIES.map((e) => e.name);
    assert.ok(names.indexOf("customers") < names.indexOf("orders"));
    assert.ok(names.indexOf("couriers") < names.indexOf("orders"));
  });

  test("order children come after orders", () => {
    const names = ENTITIES.map((e) => e.name);
    for (const child of ["order_change_requests", "courier_assignments"]) {
      assert.ok(names.indexOf("orders") < names.indexOf(child), `${child} runs before orders`);
    }
  });
});

describe("the report accounts for every record (requirement #14)", () => {
  test("counts balance across all six outcomes", () => {
    const r = new MigrationReport({ mode: "dry-run" });
    r.seen(REST, "orders", 5);
    r.count(REST, "orders", OUTCOME.MIGRATED);
    r.count(REST, "orders", OUTCOME.MIGRATED);
    r.count(REST, "orders", OUTCOME.SKIPPED);
    r.count(REST, "orders", OUTCOME.FAILED);
    r.count(REST, "orders", OUTCOME.MALFORMED);
    const t = r.perEntityTotals().orders;
    assert.equal(t.firebaseRecords, 5);
    assert.equal(t.migrated + t.skipped + t.failed + t.duplicate + t.malformed, 5);
  });

  test("an imbalance is detectable — a lost record cannot hide", () => {
    const r = new MigrationReport({ mode: "dry-run" });
    r.seen(REST, "orders", 3);
    r.count(REST, "orders", OUTCOME.MIGRATED);
    const t = r.perEntityTotals().orders;
    const accounted = t.migrated + t.skipped + t.failed + t.duplicate + t.malformed;
    assert.notEqual(t.firebaseRecords, accounted, "2 unaccounted records must show as an imbalance");
  });

  test("every data-loss entry carries path, legacy id, reason and severity", () => {
    const r = new MigrationReport({ mode: "dry-run" });
    r.lose({
      restId: REST,
      entity: "orders",
      firebasePath: `restaurants/${REST}/orders/-Oab`,
      legacyId: "-Oab",
      reason: "order_status_unknown_value",
      severity: SEVERITY.ERROR,
      outcome: OUTCOME.SKIPPED,
    });
    const [entry] = r.dataLoss;
    for (const field of ["firebasePath", "legacyId", "reason", "severity"]) {
      assert.ok(entry[field], `data-loss entry is missing ${field}`);
    }
    assert.equal(r.perEntityTotals().orders.skipped, 1,
      "lose() must also increment the outcome counter, so a loss can never be uncounted");
  });

  test("losses are grouped by reason with examples, not dumped flat", () => {
    const r = new MigrationReport({ mode: "dry-run" });
    for (let i = 0; i < 3; i++) {
      r.lose({
        restId: REST, entity: "orders",
        firebasePath: `restaurants/${REST}/orders/-Oab${i}`,
        legacyId: `-Oab${i}`, reason: "order_status_absent", severity: SEVERITY.ERROR,
      });
    }
    const byReason = r.lossByReason();
    assert.equal(byReason.order_status_absent.count, 3);
    assert.ok(byReason.order_status_absent.examples.length > 0);
  });
});
