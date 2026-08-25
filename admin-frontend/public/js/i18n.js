/**
 * i18n.js — Nesta ERP tarjima moduli
 *
 * Barcha tarjima matnlari endi langs.js faylida saqlanadi (yagona manba).
 * i18n.js faqat t()/applyLang()/setLang() kabi funksiyalarni taqdim etadi.
 */

import { langData } from './langs.js';

// Admin panel (admin.js) va mijozlar/QR sahifasi (client.js) bir xil i18n.js
// faylini import qiladi va bir xil domenda ishlaydi. Ular bir xil localStorage
// kalitidan foydalansa, biri ikkinchisining tanlagan tilini ustidan yozib
// qo'yadi (masalan: admin o'zbekchani tanlaydi, keyin mijoz QR sahifada
// inglizchani tanlaydi — bu ikkalasi uchun ham 'en'ga o'zgartirib qo'yadi).
// Shu sababli har bir sahifa turi uchun ALOHIDA kalit ishlatiladi.
const IS_ADMIN_PAGE = typeof window !== 'undefined' && /\/admin(\.html)?(\?|$)/.test(window.location.pathname);
const LANG_KEY = IS_ADMIN_PAGE ? 'admin_app_lang' : 'app_lang';
const LANG_KEY_LEGACY = IS_ADMIN_PAGE ? 'admin_lang' : 'lang';

let currentLang = (() => {
  try {
    const saved = localStorage.getItem(LANG_KEY) || localStorage.getItem(LANG_KEY_LEGACY) || 'uz';
    return langData[saved.toLowerCase()] ? saved.toLowerCase() : 'uz';
  } catch { return 'uz'; }
})();

let langListeners = [];

export function getLang() {
  return currentLang;
}

// ══════════════════════════════════════════════════════
// 🩺 Missing-translation diagnostic (dev-only).
// t()'s fallback (the 2nd argument, or `key` itself if the caller omitted
// it) exists so a missing translation NEVER shows a raw key or breaks the
// UI in production — that behavior stays exactly as-is. But a silent
// fallback also means a genuinely missing RU/EN translation is invisible:
// the page still "works", it just quietly shows the fallback text (usually
// Uzbek) to a Russian/English-speaking user forever, with nothing in the
// console to catch it. This logs each missing key ONCE (deduped) to the
// console, and ONLY when running on localhost or with
// localStorage["nesta_i18n_debug"] === "1" explicitly set — never in a
// normal production session, so it can't spam real users' consoles or leak
// internal key names into anything they'd see.
// ══════════════════════════════════════════════════════
const IS_I18N_DEBUG = (() => {
  try {
    if (typeof window === 'undefined' || !window.location) return false;
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '') return true;
    return localStorage.getItem('nesta_i18n_debug') === '1';
  } catch { return false; }
})();
const _warnedMissingKeys = new Set();
function _warnMissingKey(key) {
  if (!IS_I18N_DEBUG) return;
  const dedupeId = `${currentLang}:${key}`;
  if (_warnedMissingKeys.has(dedupeId)) return;
  _warnedMissingKeys.add(dedupeId);
  console.warn(`[i18n] Missing "${currentLang}" translation for key "${key}" — showing fallback text instead.`);
}

export function t(key, defaultText = key) {
  if (
    langData &&
    langData[currentLang] &&
    Object.prototype.hasOwnProperty.call(langData[currentLang], key)
  ) {
    return langData[currentLang][key];
  }
  _warnMissingKey(key);
  return defaultText;
}

export function applyLang() {
  document.documentElement.lang = currentLang;

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.innerHTML = t(key, key);
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    el.placeholder = t(key, key);
  });

  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    el.title = t(key, key);
  });

  document.querySelectorAll('[data-i18n-alt]').forEach(el => {
    const key = el.getAttribute('data-i18n-alt');
    el.alt = t(key, key);
  });

  // Additive — same pattern as data-i18n-placeholder/-title/-alt above, for
  // an <input>'s value (e.g. a pre-filled/default text input, a submit
  // button whose label is its value attribute) and for aria-label (screen
  // reader text, invisible on screen but must still switch language with
  // everything else).
  document.querySelectorAll('[data-i18n-value]').forEach(el => {
    const key = el.getAttribute('data-i18n-value');
    el.value = t(key, key);
  });

  document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
    const key = el.getAttribute('data-i18n-aria-label');
    el.setAttribute('aria-label', t(key, key));
  });

  document.querySelectorAll('#langSelect, [data-lang-select]').forEach(el => {
    if ('value' in el) el.value = currentLang;
  });
}

export function setLang(lang) {
  const nextLang = String(lang || '').toLowerCase();
  currentLang = langData?.[nextLang] ? nextLang : 'uz';
  localStorage.setItem(LANG_KEY, currentLang);
  localStorage.setItem(LANG_KEY_LEGACY, currentLang);

  applyLang();
  // ══════════════════════════════════════════════════════
  // 🐛 ROOT CAUSE FIX — "til almashtirish faqat refresh'dan keyin ishlaydi"
  //
  // admin.js/superadmin.js each register a large onLangChange() dispatcher
  // that re-renders many independent modules in sequence (menu, orders,
  // finance, staff, AI Import, audit log, restaurants table, dashboard
  // stats, ...). superadmin.js registers THREE separate listeners.
  // langListeners.forEach used to call every listener with no isolation —
  // in plain JS, an uncaught exception thrown by listener N propagates out
  // of forEach and aborts the loop entirely, so listener N+1..end (e.g.
  // superadmin.js's 2nd/3rd onLangChange() block) never ran at all. The
  // exact same problem existed *inside* each dispatcher too: one module's
  // re-render throwing (e.g. a chart/canvas not present on the currently
  // active tab) silently skipped every module listed after it in that same
  // callback. Because the static data-i18n elements (sidebar/header — the
  // FIRST things each dispatcher touches) still updated correctly before
  // hitting the failure point, this looked exactly like "only some things
  // translate live, the rest needs a refresh" — a full page reload starts
  // every module's render function fresh in the new language, masking the
  // issue instead of fixing it.
  //
  // Fix: isolate each listener so one's failure can never block another's,
  // and log the failure instead of losing it silently.
  // ══════════════════════════════════════════════════════
  langListeners.forEach(callback => {
    try {
      callback(currentLang);
    } catch (err) {
      console.error('[i18n] onLangChange listener threw — other listeners still ran normally:', err);
    }
  });
}

export function onLangChange(callback) {
  langListeners.push(callback);
}

// ══════════════════════════════════════════════════════
// 🔄 Avtomatik tarjima kuzatuvchisi (MutationObserver)
// Muammo: admin.js dagi ko'p funksiyalar (renderStaff, buyurtmalar
// ro'yxati va h.k.) sahifaning bir qismini innerHTML orqali qayta
// chizadi. applyLang() esa faqat sahifa birinchi yuklanganda avtomatik
// chaqirilardi — shu sababli innerHTML orqali keyinroq qo'shilgan
// data-i18n elementlari tarjimasiz (xom standart matn bilan) qolib
// ketardi. Bu kuzatuvchi DOM'ga har qanday yangi element qo'shilganda
// (masalan innerHTML = "..." orqali) avtomatik ishga tushib, faqat
// o'sha yangi qismdagi data-i18n/-placeholder/-title/-alt atributlarini
// tarjima qiladi — bu har bir funksiyaga qo'lda applyLang() qo'shishni
// shart qilmaydi va kelajakdagi yangi kodni ham avtomatik qamrab oladi.
// ══════════════════════════════════════════════════════
function _translateNode(root) {
  if (root.nodeType !== 1) return; // faqat element tugunlari

  const applyOne = (el, attr, key, setter) => {
    if (el.hasAttribute(attr)) setter(el, t(el.getAttribute(attr), el.getAttribute(attr)));
  };

  // Root elementning o'zi ham data-i18n ga ega bo'lishi mumkin
  applyOne(root, 'data-i18n', null, (el, val) => { el.innerHTML = val; });
  applyOne(root, 'data-i18n-placeholder', null, (el, val) => { el.placeholder = val; });
  applyOne(root, 'data-i18n-title', null, (el, val) => { el.title = val; });
  applyOne(root, 'data-i18n-alt', null, (el, val) => { el.alt = val; });
  applyOne(root, 'data-i18n-value', null, (el, val) => { el.value = val; });
  applyOne(root, 'data-i18n-aria-label', null, (el, val) => { el.setAttribute('aria-label', val); });

  if (typeof root.querySelectorAll !== 'function') return;

  root.querySelectorAll('[data-i18n]').forEach(el => {
    el.innerHTML = t(el.getAttribute('data-i18n'), el.getAttribute('data-i18n'));
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'), el.getAttribute('data-i18n-placeholder'));
  });
  root.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.getAttribute('data-i18n-title'), el.getAttribute('data-i18n-title'));
  });
  root.querySelectorAll('[data-i18n-alt]').forEach(el => {
    el.alt = t(el.getAttribute('data-i18n-alt'), el.getAttribute('data-i18n-alt'));
  });
  root.querySelectorAll('[data-i18n-value]').forEach(el => {
    el.value = t(el.getAttribute('data-i18n-value'), el.getAttribute('data-i18n-value'));
  });
  root.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label'), el.getAttribute('data-i18n-aria-label')));
  });
}

function _startAutoTranslateObserver() {
  if (!window.MutationObserver || !document.body) return;

  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach(node => _translateNode(node));
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  window._i18nAutoObserver = observer;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', applyLang);
  document.addEventListener('DOMContentLoaded', _startAutoTranslateObserver);
} else {
  applyLang();
  _startAutoTranslateObserver();
}

window.t = t;
window.getLang = getLang;
window.setLang = setLang;
window.applyLang = applyLang;
window.onLangChange = onLangChange;