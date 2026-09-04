// ══════════════════════════════════════════════════════════════════
// 🔧 resizeManager.js — UNIVERSAL Admin panel "Moslashtirish" (Customization mode)
//
// v3 — TRULY UNIVERSAL. v2 required each table's wrapper to be hand-tagged
// with data-resizable="table" in the static HTML. Root cause of "faqat
// Bronlar ishlaydi": ko'pgina admin jadvallar (Xodimlar/Ombor/Audit-log/
// Hisobotlar) o'zlarining TASHQI konteyneri ham, <table>'ning o'zi ham —
// sahifa birinchi ochilganda static HTML'da mavjud bo'lsa-da — ayrim
// bo'limlar birinchi marta ochilganda admin.js ularni QAYTA (butunlay yangi
// innerHTML bilan) chizadi, va bu jarayon HTML'ga qo'lda qo'yilgan
// data-resizable atributini yo'qotib yuborishi mumkin edi. Bronlar esa
// #reservationList — har doim DOMda bo'lgan barqaror konteyner — ustiga
// osilgan edi, shu sabab u ISHLAB TURDI, boshqalari esa yo'q.
//
// Bu versiya HECH QANDAY qo'lda HTML belgilashga tayanmaydi: sahifadagi
// (va keyinroq DOM'ga qo'shiladigan) BARCHA <table> elementlarini o'zi
// avtomatik topadi va ularga resize ulaydi — "table created → resize
// engine automatically attaches" (item 3).
//
// ── ARXITEKTURA ──
// 1) Boshlang'ich skanerlash: document.querySelectorAll("table") — sahifa
//    yuklanganda mavjud barcha jadvallar.
// 2) MutationObserver (document.body, {childList:true, subtree:true}) —
//    keyinroq paydo bo'ladigan (tab ochilganda, Firebase real-time render
//    qilganda) YANGI <table> tugunlarini ushlaydi. Faqat qo'shilgan
//    tugunlar ICHIDA <table> bor-yo'qligi tekshiriladi (item 21 —
//    performance: har bir node emas, faqat table qidiriladi).
// 3) Har bir <table> data-resize-initialized="true" bilan belgilanadi —
//    takroriy ulashning oldi olinadi (item 22).
// 4) Har bir jadval uchun BARQAROR kalit: <tbody id="..."> (bu ID
//    allaqachon har bir admin.js render funksiyasi tomonidan
//    getElementById bilan ishlatiladi — mavjud, tasodifiy bo'lmagan
//    manba, item 10), keyin <table id>, keyin eng yaqin ota-elementning
//    id'si, oxirgi chora sifatida barqaror pozitsion indeks.
// 5) Ustun kengligi/qator balandligi/header balandligi — event DELEGATSIYA
//    orqali (jadvalning o'ziga ulangan, ichidagi <tr>/<td> qayta
//    chizilsa ham ishlashda davom etadi) va bitta <style> qoidasi
//    ([data-table-key="x"] th:nth-child(n){...}) orqali qo'llaniladi —
//    bu qoida HAR QANDAY (hozirgi yoki keyin paydo bo'ladigan) qator/
//    ustunga avtomatik tegadi.
//
// ── Faqat presentation/layout — hech qanday order/payment/inventory/
//    customer/reservation business logic bilan ishlamaydi. ──
// ── Saqlash: localStorage, "nesta_table_layout_<key>" — table+column
//    bo'yicha alohida (item 11/24), mavjud "app_theme" kabi konvensiya
//    reuse qilindi, yangi Firebase schema yaratilmadi. ──
// ── Drag paytida HECH QANDAY Firebase/localStorage yozuvi yo'q — faqat
//    pointerup'da bitta marta (item 21). ──
// ══════════════════════════════════════════════════════════════════

(function () {
  "use strict";

  const EDGE = 7;
  const COL_MIN = 80, COL_MAX = 500;
  const ROW_MIN = 32, ROW_MAX = 180;
  const HEAD_MIN = 32, HEAD_MAX = 140;
  const CONTAINER_MIN_W = 320, CONTAINER_MAX_W = 2400;
  const CONTAINER_MIN_H = 200, CONTAINER_MAX_H = 1400;

  let customizationMode = false;
  let tableCounter = 0;

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function lsGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
  function lsSet(key, val) { try { localStorage.setItem(key, val); } catch { /* quota — jim */ } }
  function lsDel(key) { try { localStorage.removeItem(key); } catch { /* jim */ } }

  function baseKey(tableKey) {
    const restId = (typeof localStorage !== "undefined" && localStorage.getItem("restaurantId")) || "shared";
    const userId = (typeof sessionStorage !== "undefined" && (sessionStorage.getItem("userId") || sessionStorage.getItem("name"))) || "anon";
    return `nesta_table_layout_${restId}_${userId}_${tableKey}`;
  }

  /** Item 10 — har bir jadval uchun BARQAROR, tilga/renderga bog'liq bo'lmagan kalit. */
  function tableKeyFor(table) {
    if (table.dataset.tableKey) return table.dataset.tableKey;
    let key = table.querySelector("tbody[id]")?.id
      || table.id
      || table.closest("[id]")?.id
      || null;
    if (!key) {
      // Oxirgi chora — DOM tuzilishi bo'yicha barqaror pozitsion indeks
      // (sahifa strukturasi o'zgarmasa, refreshlar orasida barqaror qoladi).
      key = "tbl_pos_" + (tableCounter++);
    }
    // Bir xil id'ga ega ikkita jadval (masalan bir xil komponent ikki marta
    // ishlatilgan) to'qnashmasligi uchun — juda kam uchraydigan holat, lekin
    // xavfsizlik uchun.
    if (window._nestaUsedTableKeys?.has(key)) key = key + "_" + (tableCounter++);
    window._nestaUsedTableKeys = window._nestaUsedTableKeys || new Set();
    window._nestaUsedTableKeys.add(key);
    table.dataset.tableKey = key;
    return key;
  }

  function loadState(tableKey) {
    try {
      const raw = lsGet(baseKey(tableKey));
      return raw ? JSON.parse(raw) : { cols: {}, rowH: null, headH: null };
    } catch { return { cols: {}, rowH: null, headH: null }; }
  }
  function saveState(tableKey, state) { lsSet(baseKey(tableKey), JSON.stringify(state)); }
  function clearState(tableKey) {
    lsDel(baseKey(tableKey));
    lsDel(baseKey(tableKey) + "_container");
  }

  function getStyleEl(tableKey) {
    const id = "nesta-tbl-style-" + tableKey;
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement("style");
      el.id = id;
      document.head.appendChild(el);
    }
    return el;
  }

  function renderCss(tableKey, state) {
    const sel = `table[data-table-key="${tableKey}"]`;
    let css = "";
    Object.entries(state.cols || {}).forEach(([idx, w]) => {
      const n = Number(idx) + 1;
      css += `${sel} th:nth-child(${n}),${sel} td:nth-child(${n}){width:${w}px;max-width:${w}px;}\n`;
    });
    if (state.rowH) {
      css += `${sel} tbody tr{height:${state.rowH}px;}\n`;
      css += `${sel} tbody td{white-space:normal;overflow:hidden;text-overflow:ellipsis;vertical-align:middle;}\n`;
    }
    if (state.headH) {
      css += `${sel} thead tr, ${sel} thead th{height:${state.headH}px;}\n`;
    }
    getStyleEl(tableKey).textContent = css;
  }

  function applyContainerSize(table, tableKey) {
    const raw = lsGet(baseKey(tableKey) + "_container");
    if (!raw) return;
    try {
      const { w, h } = JSON.parse(raw);
      if (w) table.style.width = w + "px";
      if (h) { table.style.height = h + "px"; table.style.display = "block"; table.style.overflow = "auto"; }
    } catch { /* jim */ }
  }

  function autoFitColumn(table, th, idx, tableKey, state) {
    let max = th.textContent.trim().length;
    table.querySelectorAll("tbody tr").forEach(tr => {
      const cell = tr.children[idx];
      if (cell) max = Math.max(max, cell.textContent.trim().length);
    });
    const w = clamp(Math.round(max * 7.5) + 24, COL_MIN, COL_MAX);
    state.cols[idx] = w;
    renderCss(tableKey, state);
    saveState(tableKey, state);
  }

  /** Bitta <table> elementiga event-delegatsiya orqali universal resize ulaydi. */
  function wireTable(table) {
    if (table.dataset.resizeInitialized === "true") return; // item 22 — duplicate guard
    if (table.closest("[data-no-resize]")) return; // item 15/opt-out hatch
    table.dataset.resizeInitialized = "true";

    const tableKey = tableKeyFor(table);
    const state = loadState(tableKey);
    renderCss(tableKey, state);
    applyContainerSize(table, tableKey);
    table.style.position = table.style.position || "relative";

    let dragCtx = null;

    function colEdgeAt(e) {
      const th = e.target.closest("thead th");
      if (!th || !table.contains(th)) return null;
      const rect = th.getBoundingClientRect();
      if (Math.abs(rect.right - e.clientX) <= EDGE) {
        const idx = Array.prototype.indexOf.call(th.parentElement.children, th);
        return { th, idx, startW: rect.width };
      }
      return null;
    }
    function rowEdgeAt(e) {
      const tr = e.target.closest("tbody tr");
      if (!tr || !table.contains(tr)) return null;
      const rect = tr.getBoundingClientRect();
      if (Math.abs(rect.bottom - e.clientY) <= EDGE) return { startH: rect.height };
      return null;
    }
    function headEdgeAt(e) {
      const tr = e.target.closest("thead tr");
      if (!tr || !table.contains(tr)) return null;
      const rect = tr.getBoundingClientRect();
      if (Math.abs(rect.bottom - e.clientY) <= EDGE) return { startH: rect.height };
      return null;
    }

    table.addEventListener("pointermove", (e) => {
      if (!customizationMode || dragCtx) return;
      if (colEdgeAt(e)) { table.style.cursor = "col-resize"; return; }
      if (headEdgeAt(e) || rowEdgeAt(e)) { table.style.cursor = "row-resize"; return; }
      table.style.cursor = "";
    });
    table.addEventListener("pointerleave", () => { if (!dragCtx) table.style.cursor = ""; });

    table.addEventListener("dblclick", (e) => {
      if (!customizationMode) return;
      const hit = colEdgeAt(e);
      if (!hit) return;
      e.preventDefault();
      autoFitColumn(table, hit.th, hit.idx, tableKey, state);
    });

    table.addEventListener("pointerdown", (e) => {
      if (!customizationMode) return;
      let hit;
      if ((hit = colEdgeAt(e))) {
        dragCtx = { type: "col", idx: hit.idx, startX: e.clientX, startW: hit.startW };
      } else if ((hit = headEdgeAt(e))) {
        dragCtx = { type: "head", startY: e.clientY, startH: hit.startH };
      } else if ((hit = rowEdgeAt(e))) {
        dragCtx = { type: "row", startY: e.clientY, startH: hit.startH };
      } else {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      document.body.classList.add("is-resizing", dragCtx.type === "col" ? "is-resizing-col" : "is-resizing-row");
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    });

    function onMove(e) {
      if (!dragCtx) return;
      if (dragCtx.type === "col") {
        state.cols[dragCtx.idx] = clamp(dragCtx.startW + (e.clientX - dragCtx.startX), COL_MIN, COL_MAX);
      } else if (dragCtx.type === "row") {
        state.rowH = clamp(dragCtx.startH + (e.clientY - dragCtx.startY), ROW_MIN, ROW_MAX);
      } else if (dragCtx.type === "head") {
        state.headH = clamp(dragCtx.startH + (e.clientY - dragCtx.startY), HEAD_MIN, HEAD_MAX);
      }
      renderCss(tableKey, state); // faqat local style — hech qanday saqlash (item 21)
    }
    function onUp() {
      if (!dragCtx) return;
      dragCtx = null;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.classList.remove("is-resizing", "is-resizing-col", "is-resizing-row");
      table.style.cursor = "";
      saveState(tableKey, state); // bitta marta
    }

    // ── Jadval konteynerining o'zini width/height bo'yicha resize qilish
    //    (item 8, ikkinchi darajali) — <table>ning o'ziga burchak handle. ──
    const cornerHandle = document.createElement("div");
    cornerHandle.className = "nesta-table-corner-handle";
    cornerHandle.setAttribute("role", "slider");
    cornerHandle.setAttribute("tabindex", "0");
    cornerHandle.setAttribute("aria-label", "Resize table");
    cornerHandle.title = "Resize";
    table.appendChild(cornerHandle);

    let cDrag = null;
    cornerHandle.addEventListener("pointerdown", (e) => {
      if (!customizationMode) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = table.getBoundingClientRect();
      cDrag = { startX: e.clientX, startY: e.clientY, startW: rect.width, startH: rect.height };
      document.body.classList.add("is-resizing");
      document.addEventListener("pointermove", onCornerMove);
      document.addEventListener("pointerup", onCornerUp);
    });
    function onCornerMove(e) {
      if (!cDrag) return;
      const w = clamp(cDrag.startW + (e.clientX - cDrag.startX), CONTAINER_MIN_W, CONTAINER_MAX_W);
      const h = clamp(cDrag.startH + (e.clientY - cDrag.startY), CONTAINER_MIN_H, CONTAINER_MAX_H);
      table.style.width = w + "px";
      table.style.height = h + "px";
      table.style.display = "block";
      table.style.overflow = "auto";
    }
    function onCornerUp() {
      if (!cDrag) return;
      cDrag = null;
      document.removeEventListener("pointermove", onCornerMove);
      document.removeEventListener("pointerup", onCornerUp);
      document.body.classList.remove("is-resizing");
      const rect = table.getBoundingClientRect();
      lsSet(baseKey(tableKey) + "_container", JSON.stringify({ w: Math.round(rect.width), h: Math.round(rect.height) }));
    }
  }

  function scanAndWire(root) {
    (root || document).querySelectorAll("table").forEach(wireTable);
  }

  // ── Item 3/21 — yangi <table> DOM'ga qo'shilganda avtomatik ulash.
  //    Faqat qo'shilgan tugunlar ICHIDA table bor-yo'qligi tekshiriladi,
  //    har bir node yoki har renderda BARCHA jadvallar qayta skan
  //    qilinmaydi. ──
  function startAutoDiscovery() {
    if (!("MutationObserver" in window)) return;
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach(node => {
          if (node.nodeType !== 1) return; // faqat element tugunlar
          if (node.tagName === "TABLE") {
            wireTable(node);
          } else if (typeof node.querySelectorAll === "function") {
            const found = node.querySelectorAll("table");
            if (found.length) found.forEach(wireTable);
          }
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function setCustomizationMode(on) {
    customizationMode = !!on;
    document.body.classList.toggle("nesta-customization-mode", customizationMode);
    lsSet("nesta_customization_mode", customizationMode ? "1" : "0");
    const btn = document.getElementById("nestaCustomizeBtn");
    if (btn) btn.classList.toggle("active", customizationMode);
    if (!customizationMode) {
      document.querySelectorAll("table[data-resize-initialized]").forEach(tb => { tb.style.cursor = ""; });
    }
  }

  window.toggleCustomizationMode = function () {
    setCustomizationMode(!customizationMode);
  };

  /** Item 20 — BARCHA jadvallarni (nafaqat Bronlar) standartga qaytaradi. */
  window.resetCustomLayout = function () {
    const msg = (typeof t === "function") ? t("customize_reset_confirm", "Standart jadval o'lchamlariga qaytarilsinmi?") : "Standart jadval o'lchamlariga qaytarilsinmi?";
    if (!confirm(msg)) return;
    document.querySelectorAll('table[data-table-key]').forEach(table => {
      const tableKey = table.dataset.tableKey;
      if (!tableKey) return;
      clearState(tableKey);
      getStyleEl(tableKey).textContent = "";
      table.style.width = "";
      table.style.height = "";
      table.style.display = "";
      table.style.overflow = "";
    });
    if (typeof showAdminNotification === "function") {
      showAdminNotification((typeof t === "function") ? t("customize_reset_done", "Standart o'lchamlarga qaytarildi") : "Standart o'lchamlarga qaytarildi", "success");
    }
  };

  /** Tashqi hook — biror modul o'z tabini ochganda/qayta chizganda ixtiyoriy
   *  ravishda chaqirishi mumkin (aslida shart emas — MutationObserver
   *  avtomatik ushlaydi — lekin eski chaqiruvlar buzilmasin uchun saqlanadi). */
  window.registerResizables = function (root) {
    scanAndWire(root);
  };

  document.addEventListener("DOMContentLoaded", () => {
    scanAndWire(document);
    startAutoDiscovery();
    // 🩹 "Moslashtirish" tugmasi headerdan olib tashlandi (user-facing
    // control endi mavjud emas) — shu sabab bu rejim endi hech qachon
    // avtomatik yoqilmaydi, oldingi sessiyadan qolgan localStorage bayrog'i
    // e'tiborga olinmaydi (aks holda tugma yo'q bo'lsa ham, ilgari bir marta
    // yoqilgan bo'lsa, rejim "ON" holida qolib ketardi — hech qanday tugma
    // uni endi o'chira olmasdi). Column/row resize DRAG state (localStorage
    // "nesta_table_layout_*") o'zgarishsiz qoladi — faqat DRAG REJIMINING
    // o'zi endi ishga tushmaydi.
    lsDel("nesta_customization_mode");
    setCustomizationMode(false);
  });
})();
