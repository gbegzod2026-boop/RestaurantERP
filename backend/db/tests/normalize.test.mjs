// db/tests/normalize.test.mjs — unit tests for the migration normalization
// core (db/scripts/lib/normalize.mjs).
//
// These need NO PostgreSQL and NO Firebase: normalize.mjs is deliberately
// pure, so the rules that decide whether a production record is migrated,
// skipped or reported can be proven in isolation. Every case below is either
// a real value observed in the live database (cited in the test name) or an
// explicit boundary of the documented policy.
//
// Run: node --test db/tests/
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  toMoney, toDecimal, toPercent, toTimestamp, toDateKey, toMonthKey,
  toTimeOfDay, normalizePhone, decodePhoneKey, mapEnum, resolveOrderStatus,
  resolvePaymentStatus, toBool, toInt, toI18nJson, leftoverExtra,
  ORDER_STATUS_MAP, ORDER_ITEM_STATUS_MAP, PAYMENT_METHOD_MAP,
  TABLE_STATUS_MAP, ORDER_TYPE_MAP,
} from "../scripts/lib/normalize.mjs";

describe("money", () => {
  test("passes through the real 1-decimal values found in production", () => {
    // orders.total on 11 of 59 live orders has exactly 1dp.
    assert.equal(toMoney(44131.5).value, "44131.50");
    assert.equal(toMoney(314966.5).value, "314966.50");
    assert.equal(toMoney(1364581.5).value, "1364581.50");
  });

  test("passes through whole numbers and the largest observed value", () => {
    assert.equal(toMoney(216165).value, "216165.00");
    assert.equal(toMoney(10000000).value, "10000000.00"); // expenses.amount max
  });

  test("absent stays absent — never invented as zero", () => {
    assert.equal(toMoney(null).value, null);
    assert.equal(toMoney(undefined).value, null);
    assert.equal(toMoney("").value, null);
  });

  test("no production value loses precision", () => {
    for (const v of [44131.5, 314966.5, 216165, 89000, 30, 0, 1364581.5, 10000000]) {
      const r = toMoney(v);
      assert.equal(r.ok, true);
      assert.equal(r.warnings.length, 0, `${v} unexpectedly warned`);
    }
  });

  test(">2dp rounds half-up AND reports the loss", () => {
    const r = toMoney(10.005);
    assert.equal(r.ok, true);
    assert.equal(r.value, "10.01");
    const w = r.warnings.find((x) => x.code === "money_precision_loss");
    assert.ok(w, "precision loss must be reported, not silent");
    assert.equal(w.original, 10.005);
    assert.equal(w.rounded, 10.01);
  });

  test("classic float artifact is rounded and reported", () => {
    const r = toMoney(0.1 + 0.2); // 0.30000000000000004
    assert.equal(r.value, "0.30");
    assert.ok(r.warnings.some((w) => w.code === "money_precision_loss"));
  });

  test("NaN and Infinity are rejected, never coerced to 0", () => {
    assert.equal(toMoney(NaN).ok, false);
    assert.equal(toMoney(Infinity).ok, false);
    assert.equal(toMoney(NaN).reason, "money_non_finite");
  });

  test("ambiguous comma is rejected rather than guessed", () => {
    assert.equal(toMoney("1,500").ok, false);
    assert.equal(toMoney("1,500").reason, "money_ambiguous_comma");
  });

  test("numeric strings parse", () => {
    assert.equal(toMoney("1500").value, "1500.00");
    assert.equal(toMoney("1500.50").value, "1500.50");
  });

  test("out-of-range is rejected, not truncated", () => {
    assert.equal(toMoney(1e15).ok, false);
    assert.equal(toMoney(1e15).reason, "money_out_of_range");
  });

  test("negative migrates but is flagged", () => {
    const r = toMoney(-50);
    assert.equal(r.ok, true);
    assert.equal(r.value, "-50.00");
    assert.ok(r.warnings.some((w) => w.code === "money_negative"));
  });
});

describe("decimals and percents", () => {
  test("weight-based quantities keep 3dp", () => {
    assert.equal(toDecimal(1.5).value, "1.500");
    assert.equal(toDecimal(0.25).value, "0.250");
  });

  test("percent accepts the app's '%5' string form", () => {
    // users.serviceBonus is stored as "%5" while serviceFeePercent is 5.
    assert.equal(toPercent("%5").value, "5.00");
    assert.equal(toPercent(10).value, "10.00");
  });

  test("percent outside 0..100 is rejected", () => {
    assert.equal(toPercent(101).ok, false);
    assert.equal(toPercent(-1).ok, false);
  });
});

describe("timestamps", () => {
  test("real epoch-ms values from live orders convert", () => {
    const r = toTimestamp(1785423219027);
    assert.equal(r.ok, true);
    assert.ok(r.value.startsWith("2026-"));
  });

  test("epoch seconds are detected rather than read as 1970", () => {
    const secs = Math.floor(Date.UTC(2026, 3, 1) / 1000);
    const r = toTimestamp(secs);
    assert.equal(r.ok, true);
    assert.ok(r.value.startsWith("2026-"));
  });

  test("0 and nonsense are rejected, not turned into 1970", () => {
    assert.equal(toTimestamp(0).ok, false);
    assert.equal(toTimestamp(-1).ok, false);
    assert.equal(toTimestamp("not a date").ok, false);
  });

  test("absent stays absent", () => {
    assert.equal(toTimestamp(null).value, null);
    assert.equal(toTimestamp("").value, null);
  });

  test("ISO strings parse", () => {
    assert.equal(toTimestamp("2026-04-07T10:00:00Z").ok, true);
  });
});

describe("date-keyed trees (requirement #8)", () => {
  test("YYYY-MM-DD becomes a real date", () => {
    assert.equal(toDateKey("2026-04-07").value, "2026-04-07");
  });

  test("impossible dates are rejected", () => {
    assert.equal(toDateKey("2026-02-30").ok, false);
    assert.equal(toDateKey("2026-13-01").ok, false);
  });

  test("a push id is not silently accepted as a date", () => {
    assert.equal(toDateKey("-OyOwWcj0dboNzX_ROxz").ok, false);
  });

  test("YYYY-MM month keys become the first of the month", () => {
    assert.equal(toMonthKey("2026-04").value, "2026-04-01");
    assert.equal(toMonthKey("2026-00").ok, false);
  });

  test("reservation times normalize", () => {
    assert.equal(toTimeOfDay("9:05").value, "09:05:00");
    assert.equal(toTimeOfDay("19:30:15").value, "19:30:15");
    assert.equal(toTimeOfDay("25:00").ok, false);
  });
});

describe("phone normalization (requirement #7)", () => {
  test("real customer keys from production normalize", () => {
    assert.equal(normalizePhone("+998902651475"), "+998902651475");
    assert.equal(normalizePhone("+9989025651475"), "+9989025651475");
  });

  test("percent-encoded keys are decoded", () => {
    assert.equal(decodePhoneKey("%2B998902651475"), "+998902651475");
    assert.equal(normalizePhone("%2B998902651475"), "+998902651475");
  });

  test("bare 9-digit Uzbek local numbers expand to E.164", () => {
    // tables.customerPhone holds "902651475" while customers holds
    // "+998902651475" — the same person.
    assert.equal(normalizePhone("902651475"), "+998902651475");
  });

  test("formatting characters are stripped", () => {
    assert.equal(normalizePhone("+998 (90) 265-14-75"), "+998902651475");
  });

  test("malformed percent-encoding does not throw", () => {
    assert.doesNotThrow(() => normalizePhone("%"));
    assert.doesNotThrow(() => decodePhoneKey("100%"));
  });

  test("non-phone junk yields null so the row still migrates unmatched", () => {
    assert.equal(normalizePhone("unknown"), null);
    assert.equal(normalizePhone(""), null);
    assert.equal(normalizePhone(null), null);
  });

  test("12-digit 998 numbers without a plus are recognized", () => {
    assert.equal(normalizePhone("998902651475"), "+998902651475");
  });
});

describe("status normalization (requirement #9)", () => {
  test("every live orders.status value maps", () => {
    // Complete set from firebase-discover-enums.mjs across all 46 restaurants.
    for (const v of ["to'landi", "order_created", "served", "tayyorlanmoqda", "completed", "ready"]) {
      assert.equal(mapEnum(v, ORDER_STATUS_MAP, "s").ok, true, `unmapped: ${v}`);
    }
  });

  test("every live statusKey and statusV2 value maps", () => {
    for (const v of ["completed", "order_created", "served", "cooking", "ready"]) {
      assert.equal(mapEnum(v, ORDER_STATUS_MAP, "s").ok, true, `unmapped: ${v}`);
    }
  });

  test("statusHistory-only keys map", () => {
    // payment / picked_up / preparing appear in no status field.
    assert.equal(mapEnum("payment", ORDER_STATUS_MAP, "s").value, "payment_requested");
    assert.equal(mapEnum("picked_up", ORDER_STATUS_MAP, "s").value, "picked_up");
    assert.equal(mapEnum("preparing", ORDER_STATUS_MAP, "s").value, "cooking");
  });

  test("Uzbek statuses map to the documented targets", () => {
    assert.equal(mapEnum("tayyorlanmoqda", ORDER_STATUS_MAP, "s").value, "cooking");
    assert.equal(mapEnum("to'landi", ORDER_STATUS_MAP, "s").value, "completed");
  });

  test("both apostrophe variants of to'landi map identically", () => {
    assert.equal(mapEnum("to\u2018landi", ORDER_STATUS_MAP, "s").value, "completed");
  });

  test("unknown statuses are REPORTED, never coerced to 'unknown'", () => {
    const r = mapEnum("some_new_status", ORDER_STATUS_MAP, "order_status");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "order_status_unknown_value");
    assert.notEqual(r.value, "unknown");
  });

  test("precedence is statusV2 → statusKey → status", () => {
    const r = resolveOrderStatus({ statusV2: "completed", statusKey: "served", status: "to'landi" });
    assert.equal(r.value, "completed");
    assert.equal(r.sourceField, "statusV2");
  });

  test("falls back to statusKey when statusV2 is absent", () => {
    // 7 of 59 live orders have no statusV2.
    const r = resolveOrderStatus({ statusKey: "cooking", status: "tayyorlanmoqda" });
    assert.equal(r.value, "cooking");
    assert.equal(r.sourceField, "statusKey");
  });

  test("falls back to status when only it exists", () => {
    const r = resolveOrderStatus({ status: "ready" });
    assert.equal(r.value, "ready");
    assert.equal(r.sourceField, "status");
  });

  test("an order with no status at all fails loudly", () => {
    const r = resolveOrderStatus({});
    assert.equal(r.ok, false);
    assert.equal(r.reason, "order_status_absent");
  });

  test("all live item statuses map", () => {
    for (const v of ["pending", "delivered", "ready"]) {
      assert.equal(mapEnum(v, ORDER_ITEM_STATUS_MAP, "s").ok, true);
    }
  });
});

describe("payment normalization", () => {
  test("Naqd and cash collapse to the same method", () => {
    assert.equal(mapEnum("Naqd", PAYMENT_METHOD_MAP, "m").value, "cash");
    assert.equal(mapEnum("cash", PAYMENT_METHOD_MAP, "m").value, "cash");
  });

  test("provider names are case-normalized", () => {
    assert.equal(mapEnum("Payme", PAYMENT_METHOD_MAP, "m").value, "payme");
    assert.equal(mapEnum("Click", PAYMENT_METHOD_MAP, "m").value, "click");
  });

  test("cash_on_delivery is cash", () => {
    assert.equal(mapEnum("cash_on_delivery", PAYMENT_METHOD_MAP, "m").value, "cash");
  });

  test("payment_status is a separate axis from order status", () => {
    assert.equal(resolvePaymentStatus({ payment: { paid: true } }).value, "paid");
    assert.equal(resolvePaymentStatus({ payment: { requested: true } }).value, "pending");
    assert.equal(resolvePaymentStatus({ paymentMethod: "pending" }).value, "pending");
    assert.equal(resolvePaymentStatus({ payment: { paid: false } }).value, "unpaid");
    assert.equal(resolvePaymentStatus({}).value, "unpaid");
  });
});

describe("table and order type normalization", () => {
  test("all three occupied spellings collapse", () => {
    assert.equal(mapEnum("occupied", TABLE_STATUS_MAP, "s").value, "occupied");
    assert.equal(mapEnum("eating", TABLE_STATUS_MAP, "s").value, "occupied");
    assert.equal(mapEnum("busy", TABLE_STATUS_MAP, "s").value, "occupied");
  });

  test("live table statuses all map", () => {
    for (const v of ["free", "cleaning", "occupied", "eating", "busy"]) {
      assert.equal(mapEnum(v, TABLE_STATUS_MAP, "s").ok, true, `unmapped: ${v}`);
    }
  });

  test("order types map", () => {
    assert.equal(mapEnum("delivery", ORDER_TYPE_MAP, "t").value, "delivery");
    assert.equal(mapEnum("dine_in", ORDER_TYPE_MAP, "t").value, "dine_in");
  });
});

describe("scalars and lossless capture", () => {
  test("booleans", () => {
    assert.equal(toBool(true).value, true);
    assert.equal(toBool("true").value, true);
    assert.equal(toBool(undefined, false).value, false);
    assert.equal(toBool("maybe").ok, false);
  });

  test("integers", () => {
    assert.equal(toInt(31).value, 31);
    assert.equal(toInt("31").value, 31);
    assert.equal(toInt(null).value, null);
  });

  test("i18n names keep both object and string shapes", () => {
    assert.equal(toI18nJson({ uz: "Osh", ru: "Плов", en: "Pilaf" }).value,
      '{"uz":"Osh","ru":"Плов","en":"Pilaf"}');
    assert.equal(toI18nJson("Osh").value, '"Osh"');
  });

  test("unmapped fields survive in `extra` — the no-silent-loss guarantee", () => {
    const rec = { name: "x", price: 10, someUnknownField: "keepme", nested: { a: 1 } };
    const extra = JSON.parse(leftoverExtra(rec, new Set(["name", "price"])));
    assert.equal(extra.someUnknownField, "keepme");
    assert.deepEqual(extra.nested, { a: 1 });
    assert.equal(extra.name, undefined);
  });

  test("null-valued unmapped fields are not carried into extra", () => {
    const extra = JSON.parse(leftoverExtra({ a: null, b: 1 }, new Set()));
    assert.equal("a" in extra, false);
    assert.equal(extra.b, 1);
  });
});
