// exportUtils.js — Nesta ERP yagona professional Excel/CSV eksport helperi.
//
// Admin paneldagi BARCHA XLSX/CSV eksportlar (buyurtmalar, moliya, xodimlar,
// davomat, ish haqi va h.k.) shu bitta faylni chaqiradi — har bir modul
// o'zining 100-200 qatorlik alohida styling kodini yozmaydi (item 22).
//
// Kutubxona: global `XLSX` — endi xlsx-js-style (admin.html) orqali
// yuklanadi. SheetJS Community Edition bilan BIR XIL API (XLSX.utils.*,
// XLSX.writeFile), faqat qo'shimcha ravishda cell.s style obyektlarini ham
// yozadi (oddiy community build buni jim tarzda e'tiborsiz qoldiradi — shu
// sababli header rangi/border/zebra hech qachon ko'rinmas edi). Bu fayl shu
// global obyektni ishlatadi — hech qanday import kerak emas (chunki XLSX
// klassik <script> orqali yuklangan, ES module emas).
//
// Chaqiruvchi tomon (admin.js va h.k.) hali ham xuddi avvalgidek t()/
// escapeHtml() bilan tayyorlangan `Array<{[header:string]: value}>` shaklidagi
// qatorlarni beradi — bu faylning vazifasi FAQAT ko'rinishni (style, width,
// filter, freeze, number format) qo'shish, ma'lumot shaklini o'zgartirish
// emas.

// ── Nesta ERP brend ranglari (Excel style uchun RGB hex, # belgisisiz) ──
export const EXPORT_COLORS = {
  headerBg: "16A34A",       // Nesta ERP asosiy yashil
  headerBgDark: "15803D",
  headerText: "FFFFFF",
  border: "D9DEE3",
  zebraBg: "F3FBF6",        // juda och yashil tint (zebra qator)
  success: "DCFCE7", successText: "15803D",
  warning: "FEF3C7", warningText: "92400E",
  danger: "FEE2E2", dangerText: "B91C1C",
  info: "DBEAFE", infoText: "1D4ED8",
  neutral: "F1F5F9", neutralText: "475569",
};

const MIN_COL_WIDTH = 10;
const MAX_COL_WIDTH = 50;
const COL_PADDING = 2;

function _xlsx() {
  if (typeof XLSX === "undefined") {
    console.error("[exportUtils] XLSX kutubxonasi topilmagan (admin.html'da <script> yuklanmagan bo'lishi mumkin)");
    return null;
  }
  return XLSX;
}

function _thinBorder(rgb) {
  const side = { style: "thin", color: { rgb } };
  return { top: side, bottom: side, left: side, right: side };
}

/** header matni + har bir qatordagi qiymat uzunligiga qarab optimal ustun kengligini hisoblaydi (item 5). */
function _computeColumnWidths(headers, rows) {
  return headers.map(h => {
    let max = String(h ?? "").length;
    rows.forEach(r => {
      const v = r[h];
      if (v == null) return;
      const s = v instanceof Date ? 10 : String(v).length;
      if (s > max) max = s;
    });
    return { wch: Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, max + COL_PADDING)) };
  });
}

/** Uzun matnli (wrap) qatorlar uchun taxminiy qator balandligini (nuqtalarda,
 *  "hpt" — Xodimlar davomati eksportida ham aynan shu birlik ishlatilgan va
 *  ishlashi tasdiqlangan) hisoblaydi (item 7). */
function _estimateRowHeightPt(row, headers, wrapCols, colWidths) {
  let maxLines = 1;
  wrapCols.forEach(h => {
    const idx = headers.indexOf(h);
    if (idx === -1) return;
    const val = row[h];
    if (val == null) return;
    const text = String(val);
    const width = colWidths[idx]?.wch || MIN_COL_WIDTH;
    const lines = Math.max(1, Math.ceil(text.length / Math.max(8, width)));
    if (lines > maxLines) maxLines = lines;
  });
  return Math.min(90, 14 + maxLines * 11); // 1 qator ~11pt, min balandlik 14pt, max 90pt (sheet buzilmasin)
}

/**
 * Bitta stillashtirilgan Excel worksheet (ws) obyektini quradi — hech qanday
 * workbook yaratmaydi/faylga yozmaydi (item 25/36: global multi-sheet eksport
 * uchun exportRowsToExcel()'ning ichki styling'ini duplikatsiya qilmasdan
 * qayta ishlatish uchun ajratildi). exportRowsToExcel() bir varaqlik hollarda
 * shu funksiyani chaqirib, natijasini bitta workbook'ga yozadi — mavjud
 * public API/xulq-atvor o'zgarmagan.
 */
function _buildStyledSheet(X, { rows, currencyColumns = [], dateColumns = [], wrapColumns = [], rowColor = null, summary = null }) {
  const headers = Object.keys(rows[0]);
  const summaryRowCount = summary
    ? 1 + (summary.subtitle ? 1 : 0) + (summary.lines?.length || 0) + 1 // title + subtitle + lines + bo'sh qator
    : 0;
  const headerRowIdx = summaryRowCount; // 0-based

  const ws = X.utils.json_to_sheet(rows, { origin: headerRowIdx === 0 ? "A1" : `A${headerRowIdx + 1}` });

  // ── Summary blok (item 14) — jadvaldan tepada, alohida stil bilan ──
  if (summary) {
    let r = 0;
    if (summary.title) {
      const addr = X.utils.encode_cell({ r, c: 0 });
      X.utils.sheet_add_aoa(ws, [[summary.title]], { origin: addr });
      ws[addr].s = { font: { bold: true, sz: 14, color: { rgb: EXPORT_COLORS.headerBgDark } } };
      r++;
    }
    if (summary.subtitle) {
      const addr = X.utils.encode_cell({ r, c: 0 });
      X.utils.sheet_add_aoa(ws, [[summary.subtitle]], { origin: addr });
      ws[addr].s = { font: { italic: true, sz: 11, color: { rgb: "6B7280" } } };
      r++;
    }
    (summary.lines || []).forEach(([label, value]) => {
      const labelAddr = X.utils.encode_cell({ r, c: 0 });
      const valueAddr = X.utils.encode_cell({ r, c: 1 });
      X.utils.sheet_add_aoa(ws, [[label, value]], { origin: labelAddr });
      ws[labelAddr].s = { font: { bold: true, sz: 11, color: { rgb: "374151" } } };
      ws[valueAddr].s = { font: { sz: 11, color: { rgb: "111827" } } };
      r++;
    });
  }

  // ── Ustun kengligi (item 5) ──
  const colWidths = _computeColumnWidths(headers, rows);
  ws["!cols"] = colWidths;

  // ── Header qator stili (item 3-4) ──
  headers.forEach((h, c) => {
    const addr = X.utils.encode_cell({ r: headerRowIdx, c });
    if (!ws[addr]) ws[addr] = { t: "s", v: h };
    ws[addr].s = {
      font: { bold: true, sz: 11, color: { rgb: EXPORT_COLORS.headerText } },
      fill: { fgColor: { rgb: EXPORT_COLORS.headerBg } },
      alignment: { horizontal: "center", vertical: "center", wrapText: true },
      border: _thinBorder(EXPORT_COLORS.border),
    };
  });

  // ── Ma'lumot qatorlari: border, zebra, wrap, valyuta/sana format, shartli rang ──
  const rowHeights = [];
  rows.forEach((row, i) => {
    const excelRow = headerRowIdx + 1 + i;
    const isZebra = i % 2 === 1;
    const conditional = typeof rowColor === "function" ? rowColor(row, i) : null;
    let needsWrap = false;

    headers.forEach((h, c) => {
      const addr = X.utils.encode_cell({ r: excelRow, c });
      let cell = ws[addr];
      if (!cell) { cell = { t: "s", v: "" }; ws[addr] = cell; }

      const isCurrency = currencyColumns.includes(h);
      const isDate = dateColumns.includes(h);
      const isWrap = wrapColumns.includes(h);
      if (isWrap) needsWrap = true;

      if (isCurrency && typeof cell.v === "number") {
        cell.t = "n";
        cell.z = '#,##0" so\'m"';
      } else if (isDate && cell.v instanceof Date) {
        cell.t = "d";
        cell.z = "dd.mm.yyyy";
      }

      const bg = conditional?.bg || (isZebra ? EXPORT_COLORS.zebraBg : undefined);
      cell.s = {
        alignment: {
          vertical: "center",
          wrapText: isWrap || undefined,
          horizontal: isCurrency ? "right" : (isDate ? "center" : undefined),
        },
        border: _thinBorder(EXPORT_COLORS.border),
        fill: bg ? { fgColor: { rgb: bg } } : undefined,
        font: conditional?.text ? { color: { rgb: conditional.text } } : undefined,
      };
    });

    if (needsWrap) {
      rowHeights[excelRow] = _estimateRowHeightPt(row, headers, wrapColumns, colWidths);
    }
  });

  // ── Qator balandligi (item 7) — faqat wrap bo'lgan qatorlarga ──
  if (rowHeights.length) {
    const rowsArr = [];
    for (let i = 0; i <= Math.max(...Object.keys(rowHeights).map(Number)); i++) {
      rowsArr[i] = rowHeights[i] ? { hpt: rowHeights[i] } : undefined;
    }
    ws["!rows"] = rowsArr;
  }

  // ── AutoFilter (item 8) — faqat header qatoridan boshlab ──
  const lastCol = headers.length - 1;
  const lastRow = headerRowIdx + rows.length;
  ws["!autofilter"] = {
    ref: X.utils.encode_range({ s: { r: headerRowIdx, c: 0 }, e: { r: headerRowIdx, c: lastCol } }),
  };

  // ── Freeze panes (item 9) — header qatorigacha bo'lgan hammasi freeze.
  //    Oddiy {xSplit,ySplit} shakli ataylab ishlatildi — bu repo'dagi
  //    allaqachon ishlayotgan, tasdiqlangan Xodimlar davomati Excel
  //    eksportida (ws2["!freeze"] = {xSplit:2, ySplit:2}) ham xuddi shu
  //    naqsh, murakkabroq topLeftCell/activePane/state variantiga qaraganda
  //    xlsx-js-style bilan ishlashi ISBOT qilingan. ──
  ws["!freeze"] = { xSplit: 0, ySplit: headerRowIdx + 1 };

  ws["!ref"] = X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow, c: lastCol } });

  return ws;
}

/**
 * Asosiy funksiya — qatorlar massividan to'liq stilllangan professional
 * Excel workbook yaratib, foydalanuvchiga yuklab beradi (bitta varaq).
 *
 * @param {Object} opts
 * @param {Array<Object>} opts.rows - har biri {[headerText]: value} shaklida (mavjud _build*ExportRows() funksiyalari qaytaradigan format, o'zgarmagan)
 * @param {string} opts.sheetName - Excel varaq nomi (31 belgidan oshmasin, avtomatik qisqartiriladi)
 * @param {string} opts.filename - kengaytmasiz fayl nomi
 * @param {string[]} [opts.currencyColumns] - shu header-kalitlar UZS valyuta formatida ko'rsatiladi (qiymat Number bo'lishi kerak)
 * @param {string[]} [opts.dateColumns] - shu header-kalitlar sana formatida (qiymat Date obyekti bo'lsa haqiqiy Excel sana hujayrasi, aks holda matn sifatida qoladi)
 * @param {string[]} [opts.wrapColumns] - shu header-kalitlarda uzun matn wrap qilinadi
 * @param {(row:Object, idx:number)=>({bg:string,text?:string}|null)} [opts.rowColor] - har bir qator uchun shartli rang (item 18)
 * @param {{title?:string, subtitle?:string, lines?:Array<[string,string]>}} [opts.summary] - jadvaldan oldingi qisqa xulosa bloki (item 14)
 * @returns {boolean} muvaffaqiyatli yozildimi
 */
export function exportRowsToExcel({
  rows,
  sheetName = "Sheet1",
  filename = "export",
  currencyColumns = [],
  dateColumns = [],
  wrapColumns = [],
  rowColor = null,
  summary = null,
}) {
  const X = _xlsx();
  if (!X) return false;
  if (!Array.isArray(rows) || !rows.length) return false;

  const ws = _buildStyledSheet(X, { rows, currencyColumns, dateColumns, wrapColumns, rowColor, summary });

  const wb = X.utils.book_new();
  const safeSheetName = String(sheetName || "Sheet1").slice(0, 31);
  X.utils.book_append_sheet(wb, ws, safeSheetName);

  try {
    X.writeFile(wb, `${filename}.xlsx`);
    return true;
  } catch (err) {
    console.error("[exportUtils] Excel yozishda xatolik:", err);
    return false;
  }
}

/**
 * Global Hisobotlar eksporti (item 25/36) — bitta workbook, HAR BIR report
 * o'zining ALOHIDA varag'ida. Har bir varaq exportRowsToExcel() bilan AYNAN
 * bir xil styling logikasidan (_buildStyledSheet) foydalanadi — duplikatsiya
 * yo'q. Bo'sh `rows` bilan kelgan sheetlar avtomatik o'tkazib yuboriladi
 * (item 25: "Faqat mavjud va ishonchli data bor sheetlarni yarating").
 *
 * @param {Object} opts
 * @param {Array<{sheetName:string, rows:Array<Object>, currencyColumns?:string[], dateColumns?:string[], wrapColumns?:string[], rowColor?:Function, summary?:Object}>} opts.sheets - tartib bo'yicha
 * @param {string} opts.filename
 * @returns {boolean}
 */
export function exportMultiSheetExcel({ sheets, filename = "export" }) {
  const X = _xlsx();
  if (!X) return false;
  if (!Array.isArray(sheets) || !sheets.length) return false;

  const wb = X.utils.book_new();
  const usedNames = new Set();
  let anyAdded = false;

  sheets.forEach(sheetDef => {
    if (!Array.isArray(sheetDef.rows) || !sheetDef.rows.length) return; // bo'sh sheet qo'shilmaydi
    const ws = _buildStyledSheet(X, sheetDef);
    let safeName = String(sheetDef.sheetName || "Sheet").slice(0, 31);
    // Excel bir xil nomli ikkita sheetga ruxsat bermaydi — nom to'qnashsa raqam qo'shiladi.
    let n = 2;
    while (usedNames.has(safeName)) {
      safeName = `${String(sheetDef.sheetName || "Sheet").slice(0, 28)} ${n}`;
      n++;
    }
    usedNames.add(safeName);
    X.utils.book_append_sheet(wb, ws, safeName);
    anyAdded = true;
  });

  if (!anyAdded) return false;

  try {
    X.writeFile(wb, `${filename}.xlsx`);
    return true;
  } catch (err) {
    console.error("[exportUtils] Global Excel yozishda xatolik:", err);
    return false;
  }
}

/**
 * CSV eksport — UTF-8 BOM, to'g'ri quote/escape, UZ/RU/EN matnlar buzilmasin
 * (item 19). Barcha mavjud eksportlar shu bitta implementatsiyani ishlatadi
 * — har birida alohida qo'lda yozilgan CSV-yig'ish kodi bo'lmasin.
 */
// Ajratkich standarti: ";" — bu allaqachon repo'dagi ko'pchilik mavjud CSV
// eksportlarining (davomat/xodimlar/to'lov tarixi/hisobot) tanlovi edi (UZ/RU
// regional Excel sozlamalarida o'nlik ajratkich "," bo'lgani uchun ustun
// ajratkich sifatida ";" ishlatiladi). Endi BARCHA modullar uchun yagona
// standart — hech bir chaqiruvchi o'zining alohida ajratkichini tanlamaydi
// (item 8/10: "har bir modul boshqa-boshqa separator ishlatmasin").
export function exportRowsToCsv({ rows, filename = "export", delimiter = ";" }) {
  if (!Array.isArray(rows) || !rows.length) return false;
  const headers = Object.keys(rows[0]);
  const escapeCell = (val) => {
    const s = val == null ? "" : (val instanceof Date ? val.toLocaleDateString() : String(val));
    // Har qanday qiymatni quote ichiga olamiz (delimiter/quote/newline bo'lsa ham xavfsiz) —
    // ichidagi " belgisi Excel/CSV standartiga mos ikki marta takrorlanadi.
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [
    headers.map(escapeCell).join(delimiter),
    ...rows.map(row => headers.map(h => escapeCell(row[h])).join(delimiter)),
  ];
  const csvContent = "﻿" + lines.join("\r\n"); // BOM — Excel'da kirill/o'zbek matnlari to'g'ri ochilishi uchun
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return true;
}

/**
 * Sana oralig'ini fayl nomiga qo'shish uchun kichik yordamchi — barcha
 * modullar bir xil naming konventsiyasidan foydalansin (item 20).
 * Masalan: buildExportFilename("sales_report", "2026-08-01", "2026-08-16")
 * → "sales_report_2026-08-01_2026-08-16"
 */
export function buildExportFilename(base, fromDate, toDate) {
  const safe = (s) => String(s || "").trim().replace(/\s+/g, "_");
  const parts = [safe(base)];
  if (fromDate) parts.push(safe(fromDate));
  if (toDate && toDate !== fromDate) parts.push(safe(toDate));
  return parts.join("_");
}
