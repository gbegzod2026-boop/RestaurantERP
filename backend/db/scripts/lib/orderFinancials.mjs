// Per-order historical money identity. Header total is authoritative.
// The header-vs-line gap is matched against explicit source fields; leftover
// remainder is tagged LEGACY_INCONSISTENCY and never used to rewrite totals.

export function numMoney(v) {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}

export function sourceItemLineSum(rec) {
  let sum = 0;
  let fromSource = 0;
  let computed = 0;
  const items = rec?.items && typeof rec.items === "object" ? Object.values(rec.items) : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.total != null && item.total !== "") {
      sum += numMoney(item.total);
      fromSource++;
    } else {
      sum += numMoney(item.price) * numMoney(item.qty == null ? 1 : item.qty);
      computed++;
    }
  }
  return { sum: round2(sum), fromSource, computed, itemCount: items.length };
}

function closeEnough(a, b) {
  return Math.abs(round2(a - b)) <= 0.02;
}

export function classifyFromParts({
  header,
  lineSum,
  discount,
  delivery,
  service,
  fast,
  original,
  subtotal,
  fromSource = 0,
  computed = 0,
  itemCount = 0,
}) {
  const gap = round2(header - lineSum);
  const fees = round2(delivery + service + fast);
  const origVsTotalPlusDiscount = round2(original - (header + discount));
  const origMinusHeader = round2(original - header);

  const candidates = [
    { identity: "HEADER_EQUALS_LINES", explained: 0 },
    { identity: "DELIVERY_FEE", explained: delivery },
    { identity: "SERVICE_FEE", explained: service },
    { identity: "FAST_FEE", explained: fast },
    { identity: "FEES_SUM", explained: fees },
    { identity: "FEES_MINUS_DISCOUNT", explained: round2(fees - discount) },
    { identity: "ORDER_LEVEL_DISCOUNT", explained: round2(-discount) },
    { identity: "ORIGINAL_EQUALS_LINES", explained: round2(header - original) },
    { identity: "DELIVERY_MINUS_ORIGINAL_DELTA", explained: round2(delivery - origMinusHeader) },
    { identity: "FEES_MINUS_ORIGINAL_DELTA", explained: round2(fees - origMinusHeader) },
    { identity: "DELIVERY_PLUS_SERVICE", explained: round2(delivery + service) },
  ];

  let best = candidates[0];
  let bestAbs = Math.abs(round2(gap - best.explained));
  for (const c of candidates) {
    const a = Math.abs(round2(gap - c.explained));
    if (a < bestAbs - 0.001) {
      best = c;
      bestAbs = a;
    }
  }

  const remaining = round2(gap - best.explained);
  let remainderKind = "NONE";
  if (closeEnough(remaining, 0)) remainderKind = Math.abs(remaining) > 0 ? "ROUNDING" : "NONE";
  else remainderKind = "LEGACY_INCONSISTENCY";

  const inIdentity = new Set();
  if (best.identity.includes("DELIVERY") || best.identity === "FEES_SUM" || best.identity === "FEES_MINUS_DISCOUNT" || best.identity === "FEES_MINUS_ORIGINAL_DELTA" || best.identity === "DELIVERY_PLUS_SERVICE") {
    if (delivery) inIdentity.add("DELIVERY_FEE");
  }
  if (best.identity.includes("SERVICE") || best.identity === "FEES_SUM" || best.identity === "FEES_MINUS_DISCOUNT" || best.identity === "FEES_MINUS_ORIGINAL_DELTA" || best.identity === "DELIVERY_PLUS_SERVICE") {
    if (service) inIdentity.add("SERVICE_FEE");
  }
  if (best.identity.includes("FAST") || best.identity === "FEES_SUM" || best.identity === "FEES_MINUS_DISCOUNT" || best.identity === "FEES_MINUS_ORIGINAL_DELTA") {
    if (fast) inIdentity.add("FAST_FEE");
  }
  if (best.identity === "ORDER_LEVEL_DISCOUNT" || best.identity === "FEES_MINUS_DISCOUNT") {
    if (discount) inIdentity.add("ORDER_LEVEL_DISCOUNT");
  }

  const categories = [];
  const pushField = (kind, amount) => {
    if (!amount) return;
    categories.push({
      kind,
      amount,
      in_header_identity: inIdentity.has(kind),
    });
  };
  pushField("DELIVERY_FEE", delivery);
  pushField("SERVICE_FEE", service);
  pushField("FAST_FEE", fast);
  pushField("ORDER_LEVEL_DISCOUNT", discount);
  if (best.identity === "ORIGINAL_EQUALS_LINES" && !closeEnough(origMinusHeader, 0)) {
    categories.push({
      kind: closeEnough(origMinusHeader, discount) ? "ORDER_LEVEL_DISCOUNT" : "ITEM_LEVEL_DISCOUNT",
      amount: origMinusHeader,
      in_header_identity: true,
      note: "header_plus_this_equals_original_and_line_sum",
    });
  }
  if (remainderKind !== "NONE") {
    categories.push({ kind: remainderKind, amount: remaining, in_header_identity: true });
  }

  return {
    header_total: header,
    item_line_sum: lineSum,
    item_totals_from_source: fromSource,
    item_totals_computed: computed,
    item_count: itemCount,
    discount,
    delivery_fee: delivery,
    service_fee: service,
    fast_fee: fast,
    original_total: original,
    subtotal,
    gap_header_minus_lines: gap,
    explained_fees_minus_discount: round2(fees - discount),
    identity: best.identity,
    explained_by_identity: best.explained,
    remaining,
    remainder_kind: remainderKind,
    categories,
    original_vs_total_plus_discount: origVsTotalPlusDiscount,
    header_authoritative: true,
  };
}

export function classifyOrderFinancials(rec) {
  const lines = sourceItemLineSum(rec);
  return classifyFromParts({
    header: numMoney(rec.total),
    lineSum: lines.sum,
    discount: numMoney(rec.discountAmount ?? rec.discount),
    delivery: numMoney(rec.deliveryFee),
    service: numMoney(rec.serviceFeeAmount ?? rec.payment?.serviceFeeAmount),
    fast: numMoney(rec.fastFeeAmount),
    original: numMoney(rec.originalTotal),
    subtotal: numMoney(rec.subtotal),
    fromSource: lines.fromSource,
    computed: lines.computed,
    itemCount: lines.itemCount,
  });
}

export function classifyFromStoredExtra(fr) {
  if (!fr || typeof fr !== "object") return null;
  return classifyFromParts({
    header: numMoney(fr.header_total),
    lineSum: numMoney(fr.item_line_sum),
    discount: numMoney(fr.discount),
    delivery: numMoney(fr.delivery_fee),
    service: numMoney(fr.service_fee),
    fast: numMoney(fr.fast_fee),
    original: numMoney(fr.original_total),
    subtotal: numMoney(fr.subtotal),
    fromSource: Number(fr.item_totals_from_source || 0),
    computed: Number(fr.item_totals_computed || 0),
    itemCount: Number(fr.item_count || 0),
  });
}
