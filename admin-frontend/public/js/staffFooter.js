// ═══════════════════════════════════════════════════════════════════════
// staffFooter.js — Yagona (unified) xodim/mijoz paneli footer komponenti.
// Har bir panel (Waiter/Chef/Kassa/Courier/Client) shu modulni chaqirib,
// faqat FIREBASE'ni o'zi boshqaradi (header.js bilan bir xil naqsh —
// bu modul ATAYLAB Firebase bilan bog'liq emas) — panel o'zining mavjud
// restaurants/{restId}/settings real-time listeneriga bitta qo'shimcha
// qator sifatida updateStaffFooter() ni chaqiradi.
//
// Manba (source of truth) — YANGI schema YARATILMAGAN:
//   settings.workingHours   — mavjud "Ish vaqti" maydoni (Admin → Sozlamalar → Umumiy)
//   settings.contactPhone   — mavjud "Aloqa raqami" maydoni (xuddi shu joyda)
//   settings.footerSettings — YANGI, faqat on/off + ixtiyoriy matn uchun:
//     { showWorkingHours: bool, showPhone: bool, customText: string }
//
// Ishlatilishi:
//   import { mountStaffFooter, updateStaffFooter } from "./staffFooter.js";
//   const footerEl = mountStaffFooter({ fixed: true });
//   onValue(ref(db, `restaurants/${restId}/settings`), snap => {
//     updateStaffFooter(footerEl, snap.val() || {}, t);
//   });
// ═══════════════════════════════════════════════════════════════════════

function _escHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * settings obyektidan footer ichki HTML'ini quradi. Hech narsa
 * ko'rsatilmasa (barcha toggle'lar off, yoki qiymatlar bo'sh) — bo'sh
 * string qaytaradi, chaqiruvchi buni "footerni yashirish" belgisi
 * sifatida ishlatadi.
 * @param {object} settings - restaurants/{restId}/settings qiymati
 * @param {(key:string, fallback?:string)=>string} t - panelning o'z i18n funksiyasi
 */
export function buildStaffFooterHtml(settings, t) {
  const tt = typeof t === "function" ? t : (k, f) => f || k;
  const footerCfg = (settings && settings.footerSettings) || {};
  const showHours = footerCfg.showWorkingHours !== false; // default: yoqilgan
  const showPhone = footerCfg.showPhone !== false; // default: yoqilgan
  const hours = (settings && settings.workingHours) || "";
  const phone = (settings && settings.contactPhone) || "";
  const customText = (footerCfg.customText || "").trim();

  const parts = [];
  if (showHours && hours) {
    parts.push(
      `<span class="nesta-staff-footer-item"><span class="nesta-staff-footer-icon">◷</span><b>${_escHtml(hours)}</b></span>`
    );
  }
  // Talab: telefon bo'sh bo'lsa footerda telefon blokini ko'rsatma.
  if (showPhone && phone) {
    parts.push(
      `<span class="nesta-staff-footer-item"><span class="nesta-staff-footer-icon">📞</span><b>${_escHtml(phone)}</b></span>`
    );
  }
  if (customText) {
    parts.push(
      `<span class="nesta-staff-footer-item nesta-staff-footer-custom">${_escHtml(customText)}</span>`
    );
  }
  return parts.join("");
}

/**
 * Footer DOM elementini yaratadi (agar hali yo'q bo'lsa) va sahifaga
 * qo'shadi. Boshlang'ich holatda yashirin (display:none) — birinchi
 * updateStaffFooter() chaqiruvi haqiqiy ma'lumot bilan ko'rsatadi.
 * @param {{fixed?: boolean, insertBefore?: string|HTMLElement}} opts
 *   fixed: true (standart) — viewport pastiga yopishgan panel (Waiter/
 *     Chef/Kassa — bottom-nav'i yo'q panellar uchun xavfsiz).
 *   fixed: false — oddiy oqim ichida (normal-flow), Courier/Client kabi
 *     allaqachon o'z fixed bottom-nav'iga ega panellar uchun — ikkita
 *     fixed element bir-biriga ustma-ust chiqib qolmasligi uchun.
 *   insertBefore: berilsa, shu element oldiga (normal-flow tartibida)
 *     joylashtiriladi (masalan Courier/Client'ning ".bottom-nav"i oldiga
 *     — shunda u har doim sahifa oxirida, bottom-nav tepasida ko'rinadi).
 *     Berilmasa — document.body oxiriga qo'shiladi.
 */
export function mountStaffFooter(opts) {
  const options = opts || {};
  const fixed = options.fixed !== false;
  let el = document.getElementById("nestaStaffFooter");
  if (el) return el;

  el = document.createElement("div");
  el.id = "nestaStaffFooter";
  el.className = "nesta-staff-footer" + (fixed ? " nesta-staff-footer-fixed" : " nesta-staff-footer-static");
  el.style.display = "none";

  const beforeEl = typeof options.insertBefore === "string"
    ? document.querySelector(options.insertBefore)
    : options.insertBefore;

  if (beforeEl && beforeEl.parentNode) {
    beforeEl.parentNode.insertBefore(el, beforeEl);
  } else {
    document.body.appendChild(el);
  }
  return el;
}

/**
 * Footer elementini joriy settings'ga mos yangilaydi. Hech qanday
 * ko'rsatiladigan narsa bo'lmasa (hammasi off/bo'sh) — footer butunlay
 * yashiriladi (bo'sh chiziq qolmaydi).
 */
export function updateStaffFooter(el, settings, t) {
  if (!el) return;
  const html = buildStaffFooterHtml(settings, t);
  el.innerHTML = html;
  el.style.display = html ? "" : "none";
}
