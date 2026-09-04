/**
 * =====================================================
 * INTEGRATION GUIDE — Qanday ulash kerak
 * =====================================================
 *
 * IKKITA FAYL qo'shildi:
 *   📁 plan_features.js        — admin / chef / waiter sahifalari uchun
 *   📁 superadmin_features.js  — superadmin paneli uchun
 *
 * ─────────────────────────────────────────────────────
 * A) admin.js ga ulash (MINIMAL O'ZGARISH)
 * ─────────────────────────────────────────────────────
 *
 * 1. admin.js yuqorisiga import qo'shing:
 *
 *    import { listenPlanFeatures } from "./plan_features.js";
 *
 * 2. Firebase db tayyor bo'lgandan keyin chaqiring (DOMContentLoaded yoki onAuthStateChanged ichida):
 *
 *    // admin.js ichida db tayyor bo'lgandan keyin:
 *    listenPlanFeatures(db);
 *
 * 3. Eski applyPlanFeaturesToUI / listenPlanFeatures funksiyalarini
 *    admin.js dan O'CHIRISHINGIZ SHART EMAS — yangi modul ustunlik qiladi.
 *    Lekin mavjud listenPlanFeatures() ni chaqirilmasligiga ishonch hosil qiling.
 *
 * 4. Eski checkFeatureAccess() avtomatik override qilinadi.
 *
 * ─────────────────────────────────────────────────────
 * B) superadmin.js ga ulash
 * ─────────────────────────────────────────────────────
 *
 * 1. superadmin.js yuqorisiga:
 *
 *    import "./superadmin_features.js";
 *
 *    (default eksport yo'q, faqat window.* funksiyalar qo'shiladi)
 *
 * 2. Restoran jadvalidagi har bir qator uchun <tr data-rest-id="rest_123"> atributi
 *    mavjud bo'lishi kerak. Agar yo'q bo'lsa, renderRestaurantsTable() ichida:
 *
 *    const tr = document.createElement("tr");
 *    tr.setAttribute("data-rest-id", restId);   // ← shu qatorni qo'shing
 *    ...
 *
 * 3. "Features" tugmasi avtomatik qo'shiladi. Qo'lda ham chaqirish mumkin:
 *
 *    window.openRestaurantFeaturesModal("rest_123456");
 *
 * ─────────────────────────────────────────────────────
 * C) chef.js (KDS) ga ulash
 * ─────────────────────────────────────────────────────
 *
 *    import { listenPlanFeatures } from "./plan_features.js";
 *
 *    // db tayyor bo'lgandan keyin:
 *    listenPlanFeatures(db);
 *
 *    // KDS sahifasida data-feature="kds" atributi bo'lgan elementlar bloklanadi
 *
 * ─────────────────────────────────────────────────────
 * D) waiter.js ga ulash
 * ─────────────────────────────────────────────────────
 *
 *    import { listenPlanFeatures } from "./plan_features.js";
 *    listenPlanFeatures(db);
 *
 * ─────────────────────────────────────────────────────
 * E) HTML sahifalarda data-feature atributi qo'shish
 * ─────────────────────────────────────────────────────
 *
 * Har qanday HTML elementga data-feature qo'shing — avtomatik gate qilinadi:
 *
 *   <a href="#finance" data-feature="finance">Moliya</a>
 *   <button data-feature="qr_menu">QR Menyu</button>
 *   <div data-feature="inventory">Ombor bo'limi</div>
 *
 * ─────────────────────────────────────────────────────
 * F) FIREBASE STRUKTURASI
 * ─────────────────────────────────────────────────────
 *
 *   systemData/
 *     settings/
 *       tariffs/
 *         start:    { name:"START",   price:150000, features:[] }
 *         pro:      { name:"PRO",     price:350000, features:["qr_menu","kds","promo","reservations","inventory"] }
 *         premium:  { name:"PREMIUM", price:700000, features:["qr_menu","kds","promo","finance","reservations","inventory"] }
 *
 *   restaurants/{restId}/
 *     info/
 *       tariff: "pro"                          ← joriy tarif kaliti
 *     subscription/
 *       features: ["qr_menu","kds","promo"]   ← HISOBLANGAN yakuniy (avtomatik)
 *       customFeatures: ["+finance","-kds"]   ← superadmin override
 *         (+feature → qo'shilgan)
 *         (-feature → ayirilgan)
 *
 * ─────────────────────────────────────────────────────
 * G) MANTIQ
 * ─────────────────────────────────────────────────────
 *
 *   yakuniy_features = tarif.features
 *                      + customFeatures dagi "+feature" lar
 *                      - customFeatures dagi "-feature" lar
 *
 *   Misol:
 *     Tarif "pro" → features: ["qr_menu","kds","promo","reservations","inventory"]
 *     customFeatures: ["+finance", "-kds"]
 *     Yakuniy: ["qr_menu", "promo", "reservations", "inventory", "finance"]
 *               (kds olib tashlandi, finance qo'shildi)
 *
 *   O'zgarish darhol (real-time) ishlaydi — admin, chef, waiter
 *   sahifalaridagi listenPlanFeatures onValue triggerlaydi.
 *
 * ─────────────────────────────────────────────────────
 * H) TARIFLAR YANGILANGANDA (saveGlobalSettings)
 * ─────────────────────────────────────────────────────
 *
 *   saveGlobalSettings() → systemData/settings/tariffs ga yozadi
 *   plan_features.js → onValue trigger → barcha ulangan restoran
 *   sahifalarida AVTOMATIK yangilanadi
 *
 * =====================================================
 */