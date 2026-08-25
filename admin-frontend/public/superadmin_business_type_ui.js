/**
 * superadmin_business_type_ui.js
 * ─────────────────────────────────────────────────────────────────
 * SuperAdmin — Yangi/tahrir restoran modalida Business Type vizual widget.
 *
 * MUHIM:
 *   superadmin.js ensureBusinessTypeField() ni chaqiradi va o'zining
 *   oddiy <select> ni inject qiladi. Bu fayl:
 *     1. ensureBusinessTypeField → noop qilib qo'yadi (eski select chiqmasin)
 *     2. openAddRestaurantModal / editRestaurant ga hook — vizual kartalar inject
 *     3. Kartalar tanlanganda modullar preview ko'rsatadi
 *
 * Ulash:
 *   <script type="module" src="superadmin.js"></script>
 *   <script type="module" src="superadmin_business_type_ui.js"></script>
 * ─────────────────────────────────────────────────────────────────
 */

(function () {
  "use strict";

  // ── Biznes turi ikonkalari ────────────────────────────────────────
  const BT_ICONS = {
    restaurant: "🍽️",
    cafe:       "☕",
    teahouse:   "🫖",
    fastfood:   "🍔",
    coffeeshop: "🧋",
    bar:        "🍺",
    pizzeria:   "🍕",
    bakery:     "🥐",
    canteen:    "🥗",
    other:      "🏪"
  };

  // ── Modul ikonkalari ─────────────────────────────────────────────
  const MOD_ICONS = {
    pos:"🖥️", qr_menu:"📱", kitchen:"👨‍🍳", waiter:"🛎️", tables:"🪑",
    inventory:"📦", crm:"👥", reservations:"📅", purchase:"🛒",
    suppliers:"🚚", reports:"📊", finance:"💰", loyalty:"⭐",
    delivery:"🚴", accounting:"📒", take_away:"🥡",
    split_bill:"✂️", production:"🏭"
  };

  const tr = (key, def) => (typeof t === "function" ? t(key, def) : def);

  // ── CSS ───────────────────────────────────────────────────────────
  function _injectStyles() {
    if (document.getElementById("__bt_styles")) return;
    const s = document.createElement("style");
    s.id = "__bt_styles";
    s.textContent = `
      .bt-step { animation: btFadeIn .22s ease; }
      @keyframes btFadeIn {
        from { opacity:0; transform:translateY(8px); }
        to   { opacity:1; transform:translateY(0); }
      }
      .bt-step__label {
        display:block; font-size:13px; font-weight:700;
        color:#374151; margin-bottom:10px;
      }
      .bt-grid {
        display:grid;
        grid-template-columns:repeat(auto-fill, minmax(100px, 1fr));
        gap:7px; margin-bottom:14px;
      }
      .bt-card {
        display:flex; flex-direction:column; align-items:center;
        gap:5px; padding:11px 6px 9px;
        border:1.5px solid #e5e7eb; border-radius:12px;
        background:#fff; cursor:pointer;
        transition:all .18s; user-select:none;
      }
      .bt-card:hover {
        border-color:#6ee7b7; background:#f0fdf4;
        transform:translateY(-2px);
        box-shadow:0 4px 14px rgba(16,185,129,.12);
      }
      .bt-card.selected {
        border-color:#10b981; background:#ecfdf5;
        box-shadow:0 0 0 3px rgba(16,185,129,.2);
      }
      .bt-card__icon { font-size:26px; line-height:1; }
      .bt-card__name {
        font-size:11px; font-weight:600; color:#374151;
        text-align:center; line-height:1.3;
      }
      .bt-mod-preview {
        background:#f8fafc; border:1px solid #e2e8f0;
        border-radius:12px; padding:12px 14px 10px;
        margin-bottom:14px; min-height:52px;
      }
      .bt-mod-preview__title {
        font-size:11px; font-weight:700; color:#64748b;
        text-transform:uppercase; letter-spacing:.5px; margin-bottom:9px;
      }
      .bt-mod-chips { display:flex; flex-wrap:wrap; gap:5px; }
      .bt-chip {
        display:inline-flex; align-items:center; gap:3px;
        padding:3px 8px; border-radius:20px;
        font-size:11.5px; font-weight:600;
        animation:chipIn .18s ease both;
      }
      @keyframes chipIn {
        from { opacity:0; transform:scale(.85); }
        to   { opacity:1; transform:scale(1); }
      }
      .bt-chip--on  { background:#d1fae5; color:#065f46; border:1.5px solid #6ee7b7; }
      .bt-chip--off {
        background:#f1f5f9; color:#94a3b8;
        border:1.5px dashed #cbd5e1;
        text-decoration:line-through; opacity:.65;
      }
      .bt-no-selection { font-size:13px; color:#94a3b8; text-align:center; padding:6px 0; }
    `;
    document.head.appendChild(s);
  }

  // ── WIDGET ────────────────────────────────────────────────────────
  function buildWidget(container, selectId, defaultVal) {
    _injectStyles();

    const btm  = window.BUSINESS_TYPE_MODULES || {};
    const mcat = window.MODULE_CATALOG || {};
    const cats = Object.entries(btm);

    // Hidden select — saveNewRestaurant / saveEditedRestaurant tarafidan o'qiladi
    let hiddenSel = document.getElementById(selectId);
    if (!hiddenSel) {
      hiddenSel = document.createElement("select");
      hiddenSel.id = selectId;
      hiddenSel.name = selectId;
      hiddenSel.style.display = "none";
      cats.forEach(([key, data]) => {
        const opt = document.createElement("option");
        opt.value = key;
        opt.textContent = typeof data.label === "function" ? data.label() : (data.label || key);
        hiddenSel.appendChild(opt);
      });
      container.appendChild(hiddenSel);
    }

    const step = document.createElement("div");
    step.className = "bt-step";

    // Label
    const lbl = document.createElement("span");
    lbl.className = "bt-step__label";
    lbl.textContent = `🏪 ${tr("biz_type_label", "Biznes turi")}`;
    step.appendChild(lbl);

    // Cards grid
    const grid = document.createElement("div");
    grid.className = "bt-grid";
    const preview = document.createElement("div");
    preview.className = "bt-mod-preview";

    cats.forEach(([key, data]) => {
      const card = document.createElement("div");
      card.className = "bt-card";
      card.dataset.btKey = key;
      card.innerHTML = `
        <span class="bt-card__icon">${BT_ICONS[key] || "🏪"}</span>
        <span class="bt-card__name">${typeof data.label === "function" ? data.label() : (data.label || key)}</span>
      `;
      card.addEventListener("click", () => {
        grid.querySelectorAll(".bt-card").forEach(c => c.classList.remove("selected"));
        card.classList.add("selected");
        hiddenSel.value = key;
        _renderPreview(preview, key, mcat, btm);
      });
      grid.appendChild(card);
    });

    step.appendChild(grid);
    step.appendChild(preview);
    container.appendChild(step);

    // Default value
    if (defaultVal && btm[defaultVal]) {
      const defCard = grid.querySelector(`[data-bt-key="${defaultVal}"]`);
      if (defCard) defCard.classList.add("selected");
      hiddenSel.value = defaultVal;
      _renderPreview(preview, defaultVal, mcat, btm);
    } else {
      preview.innerHTML = `<div class="bt-no-selection">${tr("biz_type_hint_select", "Biznes turini tanlang — modullar ko'rinadi")}</div>`;
    }

    return { step, hiddenSel, grid, preview };
  }

  function _renderPreview(previewEl, btKey, mcat, btm) {
    const recommended = btm[btKey]?.modules || [];
    previewEl.innerHTML = "";

    const title = document.createElement("div");
    title.className = "bt-mod-preview__title";
    title.textContent = tr("modules_auto_enabled", "Avtomatik yoqiladigan modullar");
    previewEl.appendChild(title);

    const chips = document.createElement("div");
    chips.className = "bt-mod-chips";

    Object.keys(mcat).forEach((modId, idx) => {
      const isOn = recommended.includes(modId);
      const modData = mcat[modId] || {};
      const label = typeof modData.n === "function" ? modData.n() : (modData.n || modId);
      const chip = document.createElement("span");
      chip.className = `bt-chip ${isOn ? "bt-chip--on" : "bt-chip--off"}`;
      chip.style.animationDelay = `${idx * 22}ms`;
      chip.textContent = `${isOn ? "✅" : "❌"} ${MOD_ICONS[modId] || ""} ${label}`;
      chips.appendChild(chip);
    });

    previewEl.appendChild(chips);
  }

  // ── HOOK: ensureBusinessTypeField → NOOP ─────────────────────────
  // superadmin.js bu funksiyani chaqiradi va o'zining label+select inject qiladi.
  // Biz uni bo'shatamiz — faqat mavjud hiddenSel ni qaytaradi, DOM o'zgarmaydi.
  function _neutralizeEnsure() {
    window.ensureBusinessTypeField = function (selectId /*, modalEl */) {
      // Agar bizning hidden select allaqachon yaratilgan bo'lsa — qaytaramiz
      const existing = document.getElementById(selectId);
      return existing || null;
    };
  }


  // ── Widget ni modaldagi to'g'ri joyga qo'yish ────────────────────
  function _injectWidgetIntoModal(modal, selectId, defaultVal) {
    // Anchor: Tarif yoki Davr selectidan OLDIN qo'yamiz,
    // Agar topilmasa — Admin Login inputidan keyin
    const tariffSel   = modal.querySelector("[id*='Tariff'], [id*='tariff'], [id*='tarif']");
    const tariffGroup = tariffSel
      ? (tariffSel.closest(".form-group") || tariffSel.parentElement)
      : null;

    const passInput   = !tariffGroup && modal.querySelector("[id*='Pass']");
    const passGroup   = passInput
      ? (passInput.closest(".form-group") || passInput.parentElement)
      : null;

    const anchorGroup = tariffGroup || passGroup;

    const host = document.createElement("div");
    host.className = "form-group";
    host.style.cssText = "margin-bottom:14px;";
    host.setAttribute("data-bt-host", "1"); // _hookEditModal qayta ochilganda topib olib tashlashi uchun

    if (anchorGroup && anchorGroup.parentElement) {
      anchorGroup.parentElement.insertBefore(host, anchorGroup);
    } else {
      const body = modal.querySelector(".modal-body, .modal-content") || modal;
      body.appendChild(host);
    }

    buildWidget(host, selectId, defaultVal);
  }

  // ── HOOK: editRestaurant modalida vizual widget'ni ko'rsatish ────
  // window.editRestaurant (superadmin.js) faqat forma maydonlarini
  // to'ldirib #editRestaurantModal'ni ochadi — biznes turi widget'ini
  // o'zi inject qilmaydi. Shu yerda funksiyani "wrap" qilamiz: avval
  // asl editRestaurant ishlaydi (hech narsa o'zgarmaydi), so'ng biz
  // modal ichiga vizual kartalar widget'ini qo'shamiz (joriy
  // restoranning businessType qiymati bilan oldindan tanlangan holda).
  function _hookEditModal() {
    const originalEdit = window.editRestaurant;
    if (typeof originalEdit !== "function") return;

    window.editRestaurant = function (restId) {
      originalEdit.apply(this, arguments);

      const modal = document.getElementById("editRestaurantModal");
      if (!modal) return;

      // Oldingi ochilishdan qolgan widget bo'lsa olib tashlaymiz — har safar
      // boshqa restoran uchun ochilishi mumkin, shuning uchun eskisi qolmasin.
      const prevHost = modal.querySelector("[data-bt-host]");
      if (prevHost) prevHost.remove();

      const rest = window.allRestaurants && window.allRestaurants[restId];
      const defaultVal = rest?.info?.businessType || "restaurant";

      _injectWidgetIntoModal(modal, "editRestBusinessType", defaultVal);
    };
  }

  // ── INIT ──────────────────────────────────────────────────────────
  function init() {
    // 1. ensureBusinessTypeField ni oldin noop qilamiz — modal ochilganda
    //    superadmin.js uni chaqiradi lekin hech narsa render bo'lmaydi
    _neutralizeEnsure();

    // 2. Modal hooklari (faqat tahrirlash modalida — tizim faqat restoranlar
    //    uchun mo'ljallangan, shu sabab yangi restoran qo'shishda biznes turi tanlanmaydi)
    _hookEditModal();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    setTimeout(init, 80);
  }

  window._btWidget = { buildWidget };

})();