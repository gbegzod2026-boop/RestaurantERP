// receiptEngine.js — Nesta ERP Unified Receipt Engine
//
// One thermal-receipt template used by kassa.js, waiter.js, client.js and
// admin.js's order-history receipt viewer, replacing four previously
// divergent implementations (buildReceiptHtml in waiter.js, buildHistoryReceiptHtml
// in kassa.js, buildOrderReceiptHtml in admin.js, showReceipt in client.js).
//
// ⚠️ i18n-agnostic, same reasoning as paymentEngine.js: `t` is always passed
// in by the caller, never imported from js/i18n.js directly (kassa.html runs
// its own local i18n micro-system — see paymentEngine.js header comment).
//
// Supports 58mm/80mm thermal widths via the `width` option. Printing uses
// window.print() (either via an existing on-page hidden print container, or
// via a popup window — both patterns already used across the codebase, kept
// exactly as each caller already does it so no page's print mechanism
// changes). PNG/PDF export is only wired up where html2canvas/html2pdf are
// already loaded (client.html, admin.html) — it is NOT introduced as a new
// dependency for waiter.html/kassa.html, which don't load those libraries.

let _stylesInjected = false;

const RECEIPT_CSS = `
  .rcpt-paper { width: 80mm; margin: 0 auto; padding: 8px 10px; font-family: 'Courier New', monospace; font-size: 13px; color: #000; background: #fff; box-sizing: border-box; }
  .rcpt-paper[data-rcpt-width="58mm"] { width: 58mm; font-size: 11.5px; padding: 6px 6px; }
  .rcpt-stars { font-weight: 700; letter-spacing: 0; white-space: pre; overflow: hidden; text-align: center; }
  .rcpt-center { text-align: center; }
  .rcpt-logo { max-width: 120px; max-height: 60px; object-fit: contain; margin: 0 auto 6px; display: block; }
  .rcpt-shopname { margin: 3px 0; font-size: 15px; font-weight: 800; }
  .rcpt-subline { font-size: 11px; color: #333; }
  .rcpt-doctitle { font-size: 13px; font-weight: 700; margin: 8px 0 6px; letter-spacing: 1px; }
  .rcpt-info-line { font-size: 12px; margin: 1px 0; display: flex; justify-content: space-between; gap: 6px; }
  .rcpt-divider { border-top: 1px dashed #000; margin: 6px 0; }
  .rcpt-row { display: flex; justify-content: space-between; gap: 4px; font-size: 12px; padding: 1px 0; }
  .rcpt-headrow { font-weight: 700; }
  .rcpt-item-name { flex: 1; text-align: left; word-break: break-word; }
  .rcpt-item-qty { width: 44px; text-align: center; flex-shrink: 0; }
  .rcpt-item-sum { width: 76px; text-align: right; flex-shrink: 0; }
  .rcpt-total-row { font-size: 13px; font-weight: 700; padding-top: 6px; }
  .rcpt-qr { width: 100px; height: 100px; margin: 4px auto 2px; display: block; }
  .rcpt-qr-caption { font-size: 10.5px; margin-bottom: 4px; text-align: center; }
  .rcpt-barcode { max-width: 100%; height: 40px; margin: 4px auto; display: block; }
  .rcpt-foot { text-align: center; font-size: 12px; font-weight: 600; margin-top: 12px; }
  .rcpt-status-badge { display: inline-block; font-weight: 700; padding: 1px 8px; border: 1px solid #000; border-radius: 4px; font-size: 11px; }
  @media print { .rcpt-paper { padding: 4px 4px; } }
`;

export function injectReceiptStyles() {
  if (_stylesInjected || document.getElementById("receiptEngineStyles")) return;
  const s = document.createElement("style");
  s.id = "receiptEngineStyles";
  s.textContent = RECEIPT_CSS;
  document.head.appendChild(s);
  _stylesInjected = true;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * data: {
 *   restaurantName, filial, phone, address, website, logoUrl,
 *   date, time, receiptId, orderId, orderNumber, table, waiterName,
 *   customerName, guestCount,
 *   items: [{name, qty, price, total, unit}],
 *   subtotal, discount, serviceFee, tax, deliveryFee, total,
 *   extraFeeRows: [{label, value, negative}],  // e.g. "TEZKOR USTAMA", "CABIN FEE" — anything beyond the fixed fields above
 *   visitCount,                                // e.g. client.js's "N-chi tashrif" loyalty line
 *   methodLabel, transactionId, status,
 *   qrText, qrCaption, barcodeText, footerText, docTitle
 * }
 */
export function buildReceiptBodyHtml(data = {}, { t, width = "80mm" } = {}) {
  injectReceiptStyles();
  const tr = typeof t === "function" ? t : (k, d) => (d !== undefined ? d : k);
  const money = (n) => Number(n || 0).toLocaleString();
  const paperWidth = width === "58mm" ? "58mm" : "80mm";
  const STAR_LINE = "*".repeat(paperWidth === "58mm" ? 32 : 42);

  const items = Array.isArray(data.items) ? data.items : Object.values(data.items || {});
  const itemRows = items.map(it => {
    const qty = Number(it.qty ?? it.quantity ?? 1);
    const price = Number(it.price ?? 0);
    const total = it.total != null ? Number(it.total) : price * qty;
    return `<div class="rcpt-row"><span class="rcpt-item-name">${escapeHtml(it.name)}</span><span class="rcpt-item-qty">${qty}${it.unit || ""}</span><span class="rcpt-item-sum">${money(total)}</span></div>`;
  }).join("");

  const infoLine = (label, value) =>
    (value !== undefined && value !== null && value !== "")
      ? `<div class="rcpt-info-line"><span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`
      : "";

  // Kassa/waiter cheklarida hozirgacha qator ichida valyuta belgisi
  // takrorlanmagan (bitta chekda "so'm" faqat bir joyda emas, umuman
  // ko'rsatilmagan) — shu ko'rinishni saqlab qolish uchun bu yerda ham
  // valyuta qo'shilmaydi.
  const totalRow = (label, value, negative) =>
    value ? `<div class="rcpt-row"><span>${escapeHtml(label)}</span><span>${negative ? "−" : ""}${money(value)}</span></div>` : "";

  const logoHtml = data.logoUrl ? `<img src="${escapeHtml(data.logoUrl)}" class="rcpt-logo" alt="">` : "";

  const qrHtml = data.qrText ? `
    <div class="rcpt-divider"></div>
    <div class="rcpt-center">
      <img src="https://api.qrserver.com/v1/create-qr-code/?size=140x140&margin=0&data=${encodeURIComponent(data.qrText)}" class="rcpt-qr" alt="QR">
      ${data.qrCaption ? `<div class="rcpt-qr-caption">${escapeHtml(data.qrCaption)}</div>` : ""}
    </div>` : "";

  // ⚠️ Faqat aynan shu maydon — data.orderNumber/data.receiptId'ga qaytish
  // (implicit fallback) YO'Q. Sozlamalar → "Shtrix-kodni ko'rsatish" OFF
  // bo'lganda chaqiruvchi shunchaki barcodeText yubormaydi, va bu yerda
  // orderNumber doim mavjud bo'lgani uchun shtrix-kod baribir chiqib qolmasligi
  // kerak — avvalgi fallback aynan shu sababli OFF holatini imkonsiz qilardi.
  const barcodeText = data.barcodeText || "";
  const barcodeHtml = barcodeText ? `
    <div class="rcpt-center">
      <img src="https://barcodeapi.org/api/128/${encodeURIComponent(String(barcodeText))}" class="rcpt-barcode" alt="Barcode">
    </div>` : "";

  return `
    <div class="rcpt-paper" data-rcpt-width="${paperWidth}">
      <div class="rcpt-stars">${STAR_LINE}</div>
      <div class="rcpt-center">
        ${logoHtml}
        <div class="rcpt-shopname">${escapeHtml(data.restaurantName || "Nesta ERP")}</div>
        ${data.filial ? `<div class="rcpt-subline">${escapeHtml(data.filial)}</div>` : ""}
        ${data.phone ? `<div class="rcpt-subline">☎ ${escapeHtml(data.phone)}</div>` : ""}
        ${data.address ? `<div class="rcpt-subline">${escapeHtml(data.address)}</div>` : ""}
        ${data.website ? `<div class="rcpt-subline">${escapeHtml(data.website)}</div>` : ""}
      </div>
      <div class="rcpt-stars">${STAR_LINE}</div>
      <div class="rcpt-center rcpt-doctitle">${escapeHtml(data.docTitle || tr("receipt_doctitle", "GOSTEVOY SCHYOT"))}</div>

      ${infoLine(tr("receipt_date", "Sana"), data.date)}
      ${infoLine(tr("receipt_time_label", "Vaqt"), data.time)}
      ${infoLine(tr("receipt_number_label", "Chek") + " #", data.receiptId)}
      ${infoLine(tr("receipt_order_num", "Buyurtma") + " #", data.orderNumber || data.orderId)}
      ${infoLine(tr("receipt_table", "Stol"), data.table)}
      ${infoLine(tr("waiter_label", "Ofitsiant"), data.waiterName)}
      ${infoLine(tr("client_label", "Mijoz"), data.customerName)}
      ${infoLine(tr("receipt_guest_count", "Odam soni"), data.guestCount)}

      <div class="rcpt-divider"></div>
      <div class="rcpt-row rcpt-headrow"><span class="rcpt-item-name">${tr("receipt_item_name", "Nomlanish")}</span><span class="rcpt-item-qty">${tr("receipt_item_qty", "Kol-vo")}</span><span class="rcpt-item-sum">${tr("receipt_item_sum", "Summa")}</span></div>
      <div class="rcpt-divider"></div>
      ${itemRows || `<div class="rcpt-row"><span>${tr("receipt_no_items", "Taomlar yo'q")}</span></div>`}
      <div class="rcpt-divider"></div>

      ${totalRow(tr("receipt_subtotal", "Podytog"), data.subtotal)}
      ${totalRow(tr("discount_label", "Chegirma"), data.discount, true)}
      ${totalRow(tr("service_fee_label", "Xizmat haqi"), data.serviceFee)}
      ${(Array.isArray(data.extraFeeRows) ? data.extraFeeRows : []).map(r => totalRow(r.label, r.value, r.negative)).join("")}
      ${totalRow(tr("receipt_tax", "Soliq"), data.tax)}
      ${totalRow(tr("receipt_delivery_fee", "Yetkazish narxi"), data.deliveryFee)}
      <div class="rcpt-row rcpt-total-row"><span>${tr("receipt_total_due", "ITOGO K OPLATE:")}</span><span>${money(data.total)}</span></div>

      <div class="rcpt-divider"></div>
      ${infoLine(tr("payment_method_label", "To'lov turi"), data.methodLabel)}
      ${infoLine(tr("receipt_transaction_id", "Tranzaksiya ID"), data.transactionId)}
      ${data.status ? `<div class="rcpt-row"><span>${tr("receipt_status_label", "Holat")}</span><span class="rcpt-status-badge">${escapeHtml(data.status)}</span></div>` : ""}

      ${qrHtml}
      ${barcodeHtml}

      ${data.visitCount ? `<div class="rcpt-center" style="font-size:10.5px;margin-top:4px;">✦ ${escapeHtml(data.visitCount)}${tr("receipt_visit_suffix", "-chi tashrif")} ✦</div>` : ""}
      <div class="rcpt-center rcpt-foot">${escapeHtml(data.footerText || tr("receipt_footer", "RAHMAT! KUTAMIZ SIZNI YANA!"))}</div>
    </div>`;
}

// Sozlamalar → Chop etish → "Chek nusxalari" (printSettings.receiptCopies).
// N > 1 bo'lsa, bitta print-dialog ichida N ta bir xil chek ketma-ket
// chiqishi uchun bodyni N marta takrorlaydi (har biri orasida sahifa
// uzilishi) — brauzer print-dialogini N marta ochish o'rniga, real
// printerlarda ham ishlaydigan yagona-print-job usuli.
function _repeatForCopies(bodyHtml, copies) {
  const n = Math.max(1, Number(copies) || 1);
  if (n <= 1) return bodyHtml;
  return Array.from({ length: n }, () => bodyHtml).join('<div style="page-break-after:always;"></div>');
}

export function buildStandaloneReceiptDocument(data, opts = {}) {
  const body = _repeatForCopies(buildReceiptBodyHtml(data, opts), opts.copies);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(opts.title || "Receipt")}</title><style>${RECEIPT_CSS}</style></head><body>${body}</body></html>`;
}

// 🩹 Root cause of "QR/logo/barcode chekda chiqmayapti" (this print path
// specifically — printReceiptInPopup below was always correct): every <img>
// this template emits (QR — api.qrserver.com, barcode — barcodeapi.org,
// admin's own logoUrl) loads over the network ASYNCHRONOUSLY. innerHTML=
// only *starts* those loads — it doesn't wait for them. window.print() used
// to be called on the very next line, so the browser's print snapshot was
// taken before a first-time (uncached) external image had any chance to
// arrive — the printed/previewed receipt showed a blank/broken spot instead
// of the QR, every time, not intermittently. printReceiptInPopup() never had
// this bug (it already waits for the popup's own `window.onload`, which
// fires only after every external resource finishes). Bounded by a timeout
// so one unreachable image (network down, ad-blocker) can never hang a real
// payment's receipt print indefinitely — the rest of the receipt still prints.
const IMG_LOAD_TIMEOUT_MS = 3000;
function _waitForImages(containerEl) {
  const imgs = Array.from(containerEl.querySelectorAll("img"));
  if (!imgs.length) return Promise.resolve();
  return Promise.all(imgs.map(img => new Promise(resolve => {
    if (img.complete) { resolve(); return; } // already loaded (e.g. cached logo) — nothing to wait for
    const done = () => { clearTimeout(timer); img.removeEventListener("load", done); img.removeEventListener("error", done); resolve(); };
    const timer = setTimeout(done, IMG_LOAD_TIMEOUT_MS);
    img.addEventListener("load", done);
    img.addEventListener("error", done); // never reject — a broken image must not block printing the rest of the receipt
  })));
}

/** window.print() via a hidden on-page container (mirrors waiter.js's existing
 *  #printReceiptRoot pattern) — used where the host page already has the
 *  matching @media print CSS wired up (only waiter.html today). */
export async function printReceiptInto(containerEl, data, opts = {}) {
  if (!containerEl) return;
  containerEl.innerHTML = _repeatForCopies(buildReceiptBodyHtml(data, opts), opts.copies);
  await _waitForImages(containerEl);
  window.print();
}

/** window.print() via a popup window — used by kassa.js/admin.js/client.js,
 *  which never had an in-page print container. */
export function printReceiptInPopup(data, opts = {}) {
  const win = window.open("", "_blank", "width=420,height=650");
  if (!win) { opts.onPopupBlocked?.(); return null; }
  // Production Security Fix Pass, Phase 3 — sever window.opener so this
  // popup's document.write-based content can never reach back into the
  // page that opened it. Not passed as "noopener" in the features string
  // above because per spec that makes window.open() return null instead of
  // the window reference this function needs to write into and return.
  win.opener = null;
  win.document.write(buildStandaloneReceiptDocument(data, opts) + `<script>window.onload=function(){window.print();};<\/script>`);
  win.document.close();
  return win;
}

/** Standalone-HTML-file download — used where no PDF/PNG library is loaded. */
export function downloadReceiptHtmlFile(data, opts = {}) {
  const html = buildStandaloneReceiptDocument(data, opts);
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = opts.filename || `receipt-${data.orderNumber || data.orderId || Date.now()}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Only callable where window.html2canvas is already loaded (client.html/admin.html). */
export async function downloadReceiptPNG(containerEl, opts = {}) {
  if (typeof window.html2canvas !== "function") throw new Error("html2canvas is not loaded on this page");
  const canvas = await window.html2canvas(containerEl, { scale: 3, useCORS: true, backgroundColor: "#ffffff" });
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = opts.filename || "receipt.png";
  a.click();
}

/** Only callable where window.html2pdf is already loaded (client.html/admin.html). */
export async function downloadReceiptPDF(containerEl, opts = {}) {
  if (typeof window.html2pdf !== "function") throw new Error("html2pdf is not loaded on this page");
  const widthMm = opts.width === "58mm" ? 58 : 80;
  await window.html2pdf().set({
    margin: 0,
    filename: opts.filename || "receipt.pdf",
    jsPDF: { unit: "mm", format: [widthMm, 200], orientation: "portrait" },
    html2canvas: { scale: 3, useCORS: true },
  }).from(containerEl).save();
}
