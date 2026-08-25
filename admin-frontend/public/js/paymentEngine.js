// paymentEngine.js — Nesta ERP Unified Payment Engine
//
// Single source of truth for: which payment methods exist, which of them are
// enabled for a given restaurant (admin Settings → Payment Methods), how a
// payment gets written to Firebase, and the (visual-only) processing/success
// state machine used by every panel that lets someone select a method.
//
// ⚠️ i18n-agnostic on purpose: kassa.html does NOT load the real js/i18n.js —
// kassa.js runs its own self-contained i18n micro-system (local t()/
// onLangChange()). This module therefore never imports t()/onLangChange
// itself; every function that needs translated text receives `t` as a plain
// parameter from whichever caller invokes it (the real i18n.js's t() in
// waiter.js/client.js/admin.js, or kassa.js's local t()). This is what keeps
// there from being two disconnected i18n systems on the same page.
//
// ⚠️ No Firebase app initialization here — every panel already does its own
// getApps().length ? getApps()[0] : initializeApp(...), so this module only
// ever receives an already-initialized `db` plus the `ref`/`update` functions
// from whichever firebase-database build the caller imported.

// ── Canonical payment-method registry ───────────────────────────────────────
// `firebaseKey` is the exact raw string written to orders/{id}/payment.method
// today by kassa.js/waiter.js (PAY_LABELS/KTO_PAY_LABELS/WAITER_PAY_METHODS) —
// preserved unchanged so every existing reader (admin.js order lists/filters,
// courier.js, Kassa history) keeps matching it. `id` is the new lowercase key
// used only for the admin settings.paymentMethods map and for this engine's
// own lookups. Click/Payme are brand names — never translated. Cash is the
// only alwaysOn:true entry (admin can never disable it, per spec).
export const PAYMENT_METHOD_REGISTRY = [
  { id: "cash",            firebaseKey: "Naqd",       icon: "💵", labelKey: "kassa_pay_label_cash", needsCard: false, alwaysOn: true  },
  { id: "click",           firebaseKey: "Click",      icon: "📱", labelKey: null,                    needsCard: true,  alwaysOn: false },
  { id: "payme",           firebaseKey: "Payme",      icon: "🅿️", labelKey: null,                    needsCard: true,  alwaysOn: false },
  { id: "uzum",            firebaseKey: "Uzum Bank",  icon: "🟣", labelKey: null,                    needsCard: true,  alwaysOn: false },
  { id: "visa_mastercard", firebaseKey: "Bank karta", icon: "💳", labelKey: "kassa_pay_label_card",  needsCard: true,  alwaysOn: false },
  { id: "humo",            firebaseKey: "Humo",       icon: "💳", labelKey: "payment_method_humo",   needsCard: true,  alwaysOn: false },
  { id: "uzcard",          firebaseKey: "UzCard",     icon: "💳", labelKey: "payment_method_uzcard", needsCard: true,  alwaysOn: false },
];

export function findMethodByFirebaseKey(key) {
  return PAYMENT_METHOD_REGISTRY.find(m => m.firebaseKey === key) || null;
}
export function findMethodById(id) {
  return PAYMENT_METHOD_REGISTRY.find(m => m.id === id) || null;
}

// Reads restaurants/{id}/settings.paymentMethods — cash is always included
// regardless of what's stored (admin can never disable it); every other
// method defaults OFF until the admin explicitly turns it on (opt-in, since
// these toggles — especially Humo/UzCard/Visa-Mastercard — are brand new and
// nothing should silently appear as selectable before an admin configures it).
export function getEnabledPaymentMethods(settings = {}) {
  const pm = (settings && settings.paymentMethods) || {};
  return PAYMENT_METHOD_REGISTRY.filter(m => m.alwaysOn || pm[m.id] === true);
}

export const PAYMENT_METHODS_NEEDING_CARD = new Set(
  PAYMENT_METHOD_REGISTRY.filter(m => m.needsCard).map(m => m.firebaseKey)
);

// Single source of truth for the on-screen label of a stored payment method —
// accepts either the raw firebaseKey ("Naqd"/"Bank karta"/...) as stored on
// orders/{id}/payment.method, or the new lowercase id. `t` is required and
// must be the caller's own translate function (see file header).
export function paymentMethodLabel(firebaseKeyOrId, t) {
  const tr = typeof t === "function" ? t : (k, d) => (d !== undefined ? d : k);
  if (!firebaseKeyOrId) return "";
  const method = findMethodByFirebaseKey(firebaseKeyOrId) || findMethodById(String(firebaseKeyOrId).toLowerCase());
  if (!method) return String(firebaseKeyOrId);
  return method.labelKey ? tr(method.labelKey, method.firebaseKey) : method.firebaseKey;
}

// Visual-only "processing" text + duration for a given method — no real
// gateway calls happen here, this purely drives the spinner/progress step.
export function paymentSimInfo(firebaseKey, t) {
  const tr = typeof t === "function" ? t : (k, d) => (d !== undefined ? d : k);
  const method = findMethodByFirebaseKey(firebaseKey);
  const isCash = !method || method.id === "cash";
  const ms = isCash ? 900 : 1700;
  const textKey = `pay_modal_processing_${method ? method.id : "cash"}`;
  const fallback = isCash
    ? "Naqd pul qabul qilinmoqda..."
    : `${firebaseKey} ${tr("pay_modal_processing_generic_suffix", "orqali to'lov tekshirilmoqda...")}`;
  return { text: tr(textKey, fallback), ms };
}

// ── Universal Firebase payment write ────────────────────────────────────────
// Strict superset of the old, independently-duplicated writePaymentToFirebase()
// (kassa.js) / selectWaiterPaymentMethod() (waiter.js) Firebase writes —
// nothing is renamed, so shared.js's isPaymentValid() and every existing
// order.payment.* reader elsewhere in admin.js/courier.js keeps working
// unchanged. This is the ONE place in the codebase that marks an order paid.
export async function writeUnifiedPayment({
  db, update, ref, runTransaction, basePath, orderId, orderData = {},
  method, cardNumber = "", actor = {}, extra = {},
  resolveTableKey, writeOrderAuditLog, ORDER_STATUS_V2,
}) {
  if (!orderId) throw new Error("writeUnifiedPayment: orderId required");
  const now = Date.now();
  const updates = {};

  // Production Security Fix Pass, Phase 2 (High: payment idempotency).
  // This is the ONE place in the codebase that marks an order paid, called
  // from both kassa.js and waiter.js — the UI-level "already paid, disable
  // the pay button" check each caller does is only a client-rendered guard,
  // not re-verified at write time, so two near-simultaneous payment
  // attempts on the same order (two devices, a double-tap) could both pass
  // it and the second write would silently overwrite the first payment's
  // method/cashier/card/timestamp with no record two attempts happened.
  // runTransaction on payment.paid makes the claim atomic: only the caller
  // that flips it false→true proceeds; a losing concurrent caller throws
  // here instead of silently double-writing. `runTransaction` is optional
  // only for backward compatibility with a caller that hasn't been updated
  // to pass it yet — every current caller (kassa.js, waiter.js) does.
  if (typeof runTransaction === "function") {
    const paidRef = ref(db, `${basePath}/orders/${orderId}/payment/paid`);
    const claim = await runTransaction(paidRef, (current) => {
      if (current === true) return; // abort — already paid (by us or a racing caller)
      return true;
    });
    if (!claim.committed || claim.snapshot.val() !== true) {
      const err = new Error("Order is already paid");
      err.code = "ALREADY_PAID";
      throw err;
    }
  }

  updates[`${basePath}/orders/${orderId}/status`] = "to'landi";
  updates[`${basePath}/orders/${orderId}/paidAt`] = now;
  updates[`${basePath}/orders/${orderId}/payment/paid`] = true;
  updates[`${basePath}/orders/${orderId}/payment/approved`] = true;
  updates[`${basePath}/orders/${orderId}/payment/method`] = method;
  updates[`${basePath}/orders/${orderId}/payment/paidAt`] = now;
  if (actor.name) updates[`${basePath}/orders/${orderId}/payment/kassir`] = actor.name;
  if (cardNumber) updates[`${basePath}/orders/${orderId}/payment/cardNumber`] = cardNumber;
  if (actor.role === "waiter") {
    updates[`${basePath}/orders/${orderId}/payment/paidByWaiter`] = true;
    if (actor.id) updates[`${basePath}/orders/${orderId}/payment/paidByWaiterId`] = actor.id;
  }
  if (extra.serviceFeeAmount != null) updates[`${basePath}/orders/${orderId}/payment/serviceFeeAmount`] = extra.serviceFeeAmount;
  if (extra.finalTotal != null) updates[`${basePath}/orders/${orderId}/payment/finalTotal`] = extra.finalTotal;

  if (ORDER_STATUS_V2) {
    updates[`${basePath}/orders/${orderId}/statusKey`]     = ORDER_STATUS_V2.COMPLETED.key;
    updates[`${basePath}/orders/${orderId}/statusLabel`]   = ORDER_STATUS_V2.COMPLETED.labelUz;
    updates[`${basePath}/orders/${orderId}/statusV2`]      = ORDER_STATUS_V2.COMPLETED.key;
    updates[`${basePath}/orders/${orderId}/statusV2Label`] = ORDER_STATUS_V2.COMPLETED.labelUz;
    updates[`${basePath}/orders/${orderId}/statusHistory/${ORDER_STATUS_V2.PAYMENT.key}`]   = now;
    updates[`${basePath}/orders/${orderId}/statusHistory/${ORDER_STATUS_V2.COMPLETED.key}`] = now;
  }

  // Table cleanup (dine-in only) — resolveTableKey is page-local logic
  // (tablesRaw lookup-by-orderId in kassa.js, getTableKey() in waiter.js), so
  // it's passed in rather than owned by this engine.
  const tableKey = typeof resolveTableKey === "function" ? resolveTableKey(orderData) : null;
  if (tableKey) {
    updates[`${basePath}/tables/${tableKey}/status`]  = "cleaning";
    updates[`${basePath}/tables/${tableKey}/busy`]    = false;
    updates[`${basePath}/tables/${tableKey}/orderId`] = null;
  }

  // Caller-supplied extra Firebase writes (e.g. waiter.js's receipt-QR loyalty
  // discount write to customers/{phone}) — kept as a passthrough so this
  // engine doesn't need to know about every panel's side effects.
  if (extra.extraUpdates && typeof extra.extraUpdates === "object") {
    Object.assign(updates, extra.extraUpdates);
  }

  await update(ref(db), updates);

  // Customer visit/order/spend sync (this pass) — root-caused live: a
  // customer's own profile (client.js's renderProfileView(), reads
  // customers/{phone}.visits/ordersCount/totalSpent directly) showed 1
  // visit while Admin's Customers module — which recomputes live from the
  // orders/ collection every render — showed 15 for the exact same phone.
  // Cause: admin.js already HAS a function that keeps these stored fields
  // in sync (syncCustomerProfileFromOrder()), but it's only ever called
  // from two admin.js-only action handlers (closeTable / an admin-side
  // "mark order paid" flow) — never from here, the ONE place that ACTUALLY
  // marks an order paid for both kassa.js and waiter.js (via
  // createPaymentModal), which is how the overwhelming majority of real
  // dine-in payments actually complete. Every payment that never happened
  // to also go through one of those two admin.js-only code paths left
  // customers/{phone}'s stats frozen at whatever they were, drifting
  // further from reality with every cashier/waiter-processed payment.
  // Incremental + transactional (not a full orders/ re-scan like
  // syncCustomerProfileFromOrder() does) — this already knows exactly one
  // order's worth of delta, and runTransaction (already used above for the
  // payment.paid claim) makes the increment safe against two
  // near-simultaneous payments for the same customer racing each other
  // into a lost update. Never blocks the payment itself on failure —
  // logged only, same as every other best-effort side effect in this
  // function (discount claim issuance, audit log).
  // Key precedence fix (found auditing this exact case): Admin's Customers
  // module (buildCustomerMapFromOrders()) groups every order by
  // `order.customerId || phone || table_${table}` — customerId FIRST. Some
  // orders only ever get a correct customerId (e.g. via admin.js's "link
  // table to phone" action, orders/{id}/customerId = normalizedPhone) with
  // no customerPhone field at all, or with a customerPhone that was later
  // found to be mistyped and corrected only at the customerId level. A
  // phone-only lookup here would silently under-count exactly those
  // orders — live-confirmed: 2 of this one customer's 24 real orders had
  // no/wrong customerPhone but a correct customerId. isSafePhoneLike guards
  // against treating a non-phone customerId (e.g. "table_5", used for
  // walk-ins with no phone at all) as if it were one.
  const isSafePhoneLike = (v) => typeof v === "string" && /^\+?\d{9,15}$/.test(v.replace(/[\s-]/g, ""));
  const custPhone =
    (isSafePhoneLike(orderData.customerId) ? orderData.customerId : null) ||
    orderData.customerPhone || orderData.phone || orderData.clientPhone || null;
  if (custPhone && typeof runTransaction === "function") {
    const custKey = encodeURIComponent(custPhone);
    const custRef = ref(db, `${basePath}/customers/${custKey}`);
    const orderTotal = extra.finalTotal != null ? Number(extra.finalTotal) : Number(orderData.finalTotal || orderData.total || 0);
    try {
      await runTransaction(custRef, (current) => {
        const c = current || {};
        return {
          ...c,
          id: custPhone,
          phone: custPhone,
          name: c.name || orderData.customerName || orderData.clientName || orderData.name || "",
          visits: Number(c.visits || 0) + 1,
          ordersCount: Number(c.ordersCount || 0) + 1,
          totalSpent: Number(c.totalSpent || 0) + orderTotal,
          lastVisit: now,
          updatedAt: now,
          orderIds: { ...(c.orderIds || {}), [orderId]: true },
        };
      });
    } catch (e) {
      console.error("writeUnifiedPayment: customer stats sync failed:", e?.code || e?.message);
    }
  }

  if (typeof writeOrderAuditLog === "function") {
    await writeOrderAuditLog(db, basePath, {
      actorId: actor.id || "",
      actorName: actor.name || "",
      actorRole: actor.role || "",
      action: "payment_finish",
      fromStatus: orderData.status || orderData.statusKey || "",
      toStatus: ORDER_STATUS_V2 ? ORDER_STATUS_V2.COMPLETED.key : "to'landi",
      orderId,
      table: orderData.table,
      description: extra.auditDescription || `payment_finish: ${method}`,
    });
  }

  return { orderId, method, paidAt: now };
}

// ── Universal payment-modal state machine ───────────────────────────────────
// Operates purely on caller-supplied DOM element ids (defaults match the
// existing waiter.html markup: #paymentModalBackdrop/#pmMethods/#pmCardStep/
// #pmProcessing/#pmSuccessStep/#pmCancelBtn/#pmProcessingText) — this module
// never injects its own DOM, so no host page's HTML needs to change to adopt
// it; it just needs those container elements to already exist (or be passed
// via `ids`). This is what lets waiter.js delete its own hand-rolled step
// machine and delegate to one shared implementation.
//
// mode: "capture" (default) — full select → [card] → processing → success
//       flow; on success this calls writeUnifiedPayment itself.
// mode: "select" — resolves the chosen method immediately with no
//       processing/success screens (used where settlement happens later,
//       e.g. client.js cash-on-delivery).
export function createPaymentModal(config) {
  const {
    t,
    ids = {},
    allowedMethods = () => getEnabledPaymentMethods({}),
    mode = "capture",
    escapeHtml: escapeHtmlFn = (s) => String(s ?? ""),
    onSuccess,
    onCancel,
    write, // { db, update, ref, basePath, resolveTableKey, writeOrderAuditLog, ORDER_STATUS_V2 }
  } = config;

  const ID = {
    backdrop: ids.backdrop || "paymentModalBackdrop",
    methods: ids.methods || "pmMethods",
    cardStep: ids.cardStep || "pmCardStep",
    cardMethodLabel: ids.cardMethodLabel || "pmCardMethodLabel",
    cardNumber: ids.cardNumber || "pmCardNumber",
    cardExpiry: ids.cardExpiry || "pmCardExpiry",
    cardCode: ids.cardCode || "pmCardCode",
    cardNumberErr: ids.cardNumberErr || "pmCardNumberErr",
    cardExpiryErr: ids.cardExpiryErr || "pmCardExpiryErr",
    cardCodeErr: ids.cardCodeErr || "pmCardCodeErr",
    confirmBtn: ids.confirmBtn || "pmConfirmBtn",
    cancelBtn: ids.cancelBtn || "pmCancelBtn",
    processing: ids.processing || "pmProcessing",
    processingText: ids.processingText || "pmProcessingText",
    success: ids.success || "pmSuccessStep",
  };

  let selectedMethod = null;
  let simTimer = null;
  let currentOrder = null; // { orderId, orderData, cardNumber... } captured at open()

  function el(id) { return document.getElementById(id); }

  function showStep(step) {
    const methodsBox = el(ID.methods);
    const cardStep = el(ID.cardStep);
    const processing = el(ID.processing);
    const success = el(ID.success);
    const cancelBtn = el(ID.cancelBtn);
    if (methodsBox) methodsBox.classList.toggle("pm-hidden", step !== "methods");
    if (cardStep) cardStep.style.display = step === "card" ? "flex" : "none";
    if (processing) processing.style.display = step === "processing" ? "flex" : "none";
    if (success) success.style.display = step === "success" ? "flex" : "none";
    // Per spec: during processing/success, cancel/close is not offered.
    if (cancelBtn) cancelBtn.style.display = (step === "processing" || step === "success") ? "none" : "block";
  }

  function renderMethods() {
    const box = el(ID.methods);
    if (!box) return;
    const methods = typeof allowedMethods === "function" ? allowedMethods() : allowedMethods;
    box.innerHTML = methods.map(m => `
      <button class="pm-method" onclick="window.__paymentEngineChooseMethod('${m.firebaseKey.replace(/'/g, "\\'")}')">
        <span class="pm-icon">${m.icon}</span>
        <span>${escapeHtmlFn(paymentMethodLabel(m.firebaseKey, t))}</span>
      </button>`).join("");
    box.querySelectorAll(".pm-method").forEach(b => b.disabled = false);
  }

  function validateCardStep() {
    let ok = true;
    const numEl = el(ID.cardNumber), expEl = el(ID.cardExpiry), codeEl = el(ID.cardCode);
    const numErr = el(ID.cardNumberErr), expErr = el(ID.cardExpiryErr), codeErr = el(ID.cardCodeErr);

    const digits = (numEl?.value || "").replace(/\D/g, "");
    if (digits.length !== 16) {
      ok = false;
      numEl?.classList.add("pm-input-error");
      if (numErr) numErr.textContent = t("pay_modal_card_number_err", "16 xonali karta raqamini kiriting");
    } else {
      numEl?.classList.remove("pm-input-error");
      if (numErr) numErr.textContent = "";
    }

    const expMatch = /^(\d{2})\/(\d{2})$/.exec(expEl?.value || "");
    const expValid = !!expMatch && Number(expMatch[1]) >= 1 && Number(expMatch[1]) <= 12;
    if (!expValid) {
      ok = false;
      expEl?.classList.add("pm-input-error");
      if (expErr) expErr.textContent = t("pay_modal_card_expiry_err", "OO/YY");
    } else {
      expEl?.classList.remove("pm-input-error");
      if (expErr) expErr.textContent = "";
    }

    const codeDigits = (codeEl?.value || "").replace(/\D/g, "");
    if (codeDigits.length < 4) {
      ok = false;
      codeEl?.classList.add("pm-input-error");
      if (codeErr) codeErr.textContent = t("pay_modal_card_code_err", "Kodni kiriting");
    } else {
      codeEl?.classList.remove("pm-input-error");
      if (codeErr) codeErr.textContent = "";
    }
    return ok;
  }

  function runSimulation(firebaseKey) {
    return new Promise(resolve => {
      const box = el(ID.methods);
      box?.querySelectorAll(".pm-method").forEach(b => b.disabled = true);
      const sim = paymentSimInfo(firebaseKey, t);
      const textEl = el(ID.processingText);
      if (textEl) textEl.textContent = sim.text;
      showStep("processing");
      simTimer = setTimeout(() => {
        showStep("success");
        simTimer = setTimeout(resolve, 700);
      }, sim.ms);
    });
  }

  async function chooseMethod(firebaseKey) {
    if (mode === "select") {
      close();
      onSuccess?.({ method: firebaseKey, selectOnly: true });
      return;
    }
    if (PAYMENT_METHODS_NEEDING_CARD.has(firebaseKey)) {
      selectedMethod = firebaseKey;
      const labelBox = el(ID.cardMethodLabel);
      const methodDef = findMethodByFirebaseKey(firebaseKey);
      if (labelBox && methodDef) {
        labelBox.innerHTML = `<span class="pm-icon">${methodDef.icon}</span><span>${escapeHtmlFn(paymentMethodLabel(firebaseKey, t))}</span>`;
      }
      showStep("card");
      el(ID.cardNumber)?.focus();
      return;
    }
    await confirm(firebaseKey, "");
  }

  async function confirmCard() {
    if (!validateCardStep()) return;
    const btn = el(ID.confirmBtn);
    if (btn) btn.disabled = true;
    const cardNumber = (el(ID.cardNumber)?.value || "").replace(/\D/g, "");
    await confirm(selectedMethod, cardNumber);
  }

  async function confirm(firebaseKey, cardNumber) {
    if (!currentOrder) return;
    selectedMethod = firebaseKey;
    await runSimulation(firebaseKey);
    el(ID.methods)?.querySelectorAll(".pm-method").forEach(b => b.disabled = true);

    try {
      const result = await writeUnifiedPayment({
        ...write,
        orderId: currentOrder.orderId,
        orderData: currentOrder.orderData,
        method: firebaseKey,
        cardNumber,
        actor: currentOrder.actor,
        extra: currentOrder.extra,
      });
      close();
      onSuccess?.({ ...result, cardNumber });
    } catch (err) {
      console.error("paymentEngine confirm error:", err);
      selectedMethod = null;
      clearTimeout(simTimer);
      showStep("methods");
      el(ID.methods)?.querySelectorAll(".pm-method").forEach(b => b.disabled = false);
      const confirmBtn = el(ID.confirmBtn);
      if (confirmBtn) confirmBtn.disabled = false;
      onCancel?.(err);
    }
  }

  function open({ orderId, orderData = {}, actor = {}, extra = {} }) {
    currentOrder = { orderId, orderData, actor, extra };
    selectedMethod = null;
    clearTimeout(simTimer);
    renderMethods();

    [ID.cardNumber, ID.cardExpiry, ID.cardCode].forEach(id => { const e = el(id); if (e) e.value = ""; });
    [ID.cardNumberErr, ID.cardExpiryErr, ID.cardCodeErr].forEach(id => { const e = el(id); if (e) e.textContent = ""; });
    [ID.cardNumber, ID.cardExpiry, ID.cardCode].forEach(id => el(id)?.classList.remove("pm-input-error"));

    showStep("methods");
    const backdrop = el(ID.backdrop);
    if (backdrop) backdrop.style.display = "flex";
  }

  function close() {
    const backdrop = el(ID.backdrop);
    if (backdrop) backdrop.style.display = "none";
    selectedMethod = null;
    clearTimeout(simTimer);
    const confirmBtn = el(ID.confirmBtn);
    if (confirmBtn) confirmBtn.disabled = false;
    currentOrder = null;
  }

  // Bridge for the onclick="..." markup generated by renderMethods() — one
  // global per page is fine since only one payment modal is ever open at once.
  window.__paymentEngineChooseMethod = chooseMethod;

  return {
    open,
    close,
    backToMethods() { selectedMethod = null; showStep("methods"); },
    confirmCard,
    formatCardNumber(inputEl) {
      const digits = inputEl.value.replace(/\D/g, "").slice(0, 16);
      inputEl.value = digits.replace(/(.{4})/g, "$1 ").trim();
    },
    formatCardExpiry(inputEl) {
      let digits = inputEl.value.replace(/\D/g, "").slice(0, 4);
      if (digits.length >= 3) digits = digits.slice(0, 2) + "/" + digits.slice(2);
      inputEl.value = digits;
    },
    formatCardCode(inputEl) {
      inputEl.value = inputEl.value.replace(/\D/g, "").slice(0, 6);
    },
    // Relabels already-rendered method buttons / card-step label in place —
    // for panels that need to react to a language change without resetting
    // the in-progress payment flow (see waiter.js's central onLangChange).
    relabelOnLangChange() {
      const backdrop = el(ID.backdrop);
      if (!backdrop || backdrop.style.display === "none") return;
      const box = el(ID.methods);
      box?.querySelectorAll(".pm-method").forEach(btn => {
        const span = btn.querySelector("span:last-child");
        if (!span) return;
        const m = PAYMENT_METHOD_REGISTRY.find(mm => btn.getAttribute("onclick")?.includes(`'${mm.firebaseKey}'`));
        if (m) span.textContent = paymentMethodLabel(m.firebaseKey, t);
      });
      if (selectedMethod) {
        const labelBox = el(ID.cardMethodLabel);
        const methodDef = findMethodByFirebaseKey(selectedMethod);
        if (labelBox && methodDef) {
          labelBox.innerHTML = `<span class="pm-icon">${methodDef.icon}</span><span>${escapeHtmlFn(paymentMethodLabel(selectedMethod, t))}</span>`;
        }
      }
    },
  };
}
