// ═══════════════════════════════════════════════════════════════════════
// header.js — Yagona (unified) header brend-blokini render qiluvchi umumiy
// komponent. Har bir panel (SuperAdmin/Admin/Waiter/Kitchen/Courier/Client/
// Head Office/POS) shu modulni chaqirib, faqat o'zining productType va
// role qiymatini beradi — qolgan hamma narsa (logo, tipografiya, i18n)
// bitta joydan boshqariladi.
//
// Ishlatilishi (har bir sahifada header ichida):
//   <div id="nestaHeaderBrand" class="nesta-header-brand"></div>
//   ...
//   <script type="module">
//     import { renderHeader } from "./js/header.js";
//     renderHeader("nestaHeaderBrand", { product: "erp", role: "superadmin" });
//   </script>
//
// RBAC / Firebase / business logic bilan hech qanday bog'liqligi yo'q —
// faqat header'ning chap tomonidagi "logo + mahsulot nomi + rol" blokini
// chizadi va til almashtirilganda (data-i18n orqali) avtomatik yangilanadi.
// ═══════════════════════════════════════════════════════════════════════

import { onLangChange } from "./i18n.js";

// Standart logo — barcha panellarda BITTA umumiy Nesta logosi.
const LOGO_SRC = "img/logo (2).svg";

// productType → langs.js dagi i18n kaliti
const PRODUCT_I18N_KEYS = {
  erp: "product_erp",
  pos: "product_pos",
  waiter: "product_waiter",
  kitchen: "product_kitchen",
  client: "product_client",
  courier: "product_courier",
  head_office: "product_head_office",
};

// role → langs.js dagi i18n kaliti
//
// NOTE: admin/client/cashier/courier uchun "role_admin" kabi "yalang'och"
// kalitlar ATAYLAB ishlatilmaydi — bu kalitlar allaqachon Roles & Permissions
// moduli (admin.js: t("role_"+role)) tomonidan boshqa (badge uchun qisqaroq)
// matnlar bilan band qilingan. Xuddi shu nomni bu yerda ham ishlatish
// langs.js'da kalitni jim ravishda ustidan yozib qo'yar edi va ikkala
// joyning matnini ham buzardi. Shuning uchun header uchun alohida
// header_role_* kalitlari ishlatiladi (langs.js'da izohlangan).
const ROLE_I18N_KEYS = {
  superadmin: "role_superadmin",
  admin: "header_role_admin",
  waiter: "role_waiter",
  kitchen: "role_kitchen",
  client: "header_role_client",
  courier: "header_role_courier",
  cashier: "header_role_cashier",
  head_office: "role_head_office",
};

// 🆕 showLogo (default true — every existing caller keeps its logo,
// zero behavior change) — Admin panel is the one caller that now passes
// showLogo:false (the sidebar already shows the restaurant's logo; the
// header repeated it right next to "Nesta ERP / ADMINISTRATOR", which read
// as a duplicate). Nothing else about paint()/renderHeader() changes, and
// every other panel (waiter/kassa/chef/courier/client/head_office/
// superadmin) is unaffected since they never pass this option.
function paint(el, product, role, showLogo = true) {
  const productKey = PRODUCT_I18N_KEYS[product];
  const roleKey = ROLE_I18N_KEYS[role];
  el.innerHTML =
    (showLogo ? '<img class="nesta-header-logo" src="' + LOGO_SRC + '" alt="Nesta">' : '') +
    '<div class="nesta-header-titles">' +
    '<span class="nesta-header-product" data-i18n="' + productKey + '"></span>' +
    '<span class="nesta-header-role" data-i18n="' + roleKey + '"></span>' +
    '</div>';
  if (typeof window !== "undefined" && typeof window.applyLang === "function") {
    window.applyLang();
  }
}

/**
 * Header brend blokini (logo + mahsulot nomi + rol) render qiladi.
 * @param {string|HTMLElement} target - konteyner elementi yoki uning id'si
 * @param {{product: keyof PRODUCT_I18N_KEYS, role: keyof ROLE_I18N_KEYS}} options
 */
export function renderHeader(target, options) {
  const el = typeof target === "string" ? document.getElementById(target) : target;
  const product = options && options.product;
  const role = options && options.role;
  const showLogo = !(options && options.showLogo === false);

  if (!el) {
    console.warn("[header.js] renderHeader: konteyner topilmadi:", target);
    return;
  }
  if (!PRODUCT_I18N_KEYS[product]) {
    console.warn("[header.js] renderHeader: noma'lum product turi:", product);
    return;
  }
  if (!ROLE_I18N_KEYS[role]) {
    console.warn("[header.js] renderHeader: noma'lum role turi:", role);
    return;
  }

  el.classList.add("nesta-header-brand");
  paint(el, product, role, showLogo);

  // Til almashtirilganda blok qayta chiziladi (i18n.js MutationObserver'i
  // ham bor, lekin bu yerda aniqlik uchun onLangChange'ga ham obuna bo'lamiz).
  if (typeof onLangChange === "function") {
    onLangChange(() => paint(el, product, role, showLogo));
  }
}

/**
 * Header logotipini Admin → Sozlamalar orqali yuklangan (canonical manba:
 * restaurants/{restId}/settings/restaurantLogoUrl) custom logo bilan
 * almashtiradi, yoki `url` bo'sh/berilmagan bo'lsa standart Nesta logosiga
 * qaytaradi ("YO'Q → mavjud loyiha default logo" qoidasi).
 *
 * header.js ATAYLAB Firebase bilan bog'liq emas (yuqoridagi fayl izohiga
 * qarang) — shuning uchun Firebase o'qish/real-time listener har bir
 * panelning o'zida (restId/db allaqachon mavjud) qoladi; bu funksiya
 * faqat DOM'ni yangilaydi. Har bir panel o'zining mavjud settings
 * listeneriga (masalan waiter.js'dagi listenRestaurantSettings(),
 * kassa.js'dagi applyHeaderBranding(), chef.js'dagi real-time IIFE,
 * admin.js'dagi applyRestaurantLogo()) bitta qo'shimcha qator sifatida
 * chaqiradi — yangi listener/schema yaratilmaydi.
 * @param {string|HTMLElement} target - renderHeader() bilan bir xil konteyner
 * @param {string} [url] - restaurants/{restId}/settings/restaurantLogoUrl qiymati
 */
export function setHeaderLogo(target, url) {
  const el = typeof target === "string" ? document.getElementById(target) : target;
  if (!el) return;
  const img = el.querySelector(".nesta-header-logo");
  if (img) img.src = url || LOGO_SRC;
}

// Modul bo'lmagan inline onclick va h.k. uchun global qulaylik.
if (typeof window !== "undefined") {
  window.renderNestaHeader = renderHeader;
  window.setNestaHeaderLogo = setHeaderLogo;
}
