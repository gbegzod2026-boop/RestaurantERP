// aiImport/validationService.js — server-side row validation for AI Smart
// Import. Runs identically for Manual and AI mode (the client's parsed/AI-
// extracted rows are NEVER trusted as already-valid) — this is the one place
// "duplicate / required fields / currency / date / phone / email / barcode /
// SKU / price / negative values / invalid formats" are actually enforced.
import { getModuleSchema } from "./moduleSchemas.js";

const PHONE_RE = /^\+?\d{7,15}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SKU_RE = /^[A-Za-z0-9._-]{2,32}$/;
const BARCODE_RE = /^\d{8,14}$/; // EAN-8 / EAN-13 / UPC-A range

function normalizeDate(value) {
  if (!value) return null;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
  const s = String(value).trim();
  // dd.mm.yyyy or dd/mm/yyyy
  const m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/);
  if (m) {
    const [, d, mo, y] = m;
    const year = y.length === 2 ? Number(y) + 2000 : Number(y);
    const dt = new Date(year, Number(mo) - 1, Number(d));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  const dt = new Date(s);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/** Validates a single field value against its declared type. Returns an error message key, or null if valid. */
function validateField(field, rawValue) {
  const value = rawValue === undefined || rawValue === null ? "" : rawValue;
  const isEmpty = typeof value === "string" ? value.trim() === "" : value === "";

  if (field.required && isEmpty) return "ai_import_err_required";
  if (isEmpty) return null; // optional + empty -> nothing else to check

  switch (field.type) {
    case "number": {
      const n = Number(String(value).replace(/[\s,]/g, ""));
      if (Number.isNaN(n)) return "ai_import_err_invalid_number";
      if (n < 0) return "ai_import_err_negative";
      return null;
    }
    case "phone":
      if (!PHONE_RE.test(String(value).replace(/[\s()-]/g, ""))) return "ai_import_err_invalid_phone";
      return null;
    case "email":
      if (!EMAIL_RE.test(String(value).trim())) return "ai_import_err_invalid_email";
      return null;
    case "date":
      if (!normalizeDate(value)) return "ai_import_err_invalid_date";
      return null;
    case "sku":
      if (!SKU_RE.test(String(value).trim())) return "ai_import_err_invalid_sku";
      return null;
    case "barcode":
      if (!BARCODE_RE.test(String(value).trim())) return "ai_import_err_invalid_barcode";
      return null;
    default:
      return null;
  }
}

/**
 * Validates every row for a given destination module.
 * Returns { rows: [{ ...row, _rowIndex, _errors:[], _warnings:[] }], validCount, errorCount }.
 * Duplicate detection against rows already seen IN THIS SAME FILE is also
 * flagged here as a warning (cross-checking against existing Firebase data
 * happens separately in previewService, since that's about new/updated/
 * skipped classification rather than "is this row malformed").
 */
export function validateRows(moduleId, rows) {
  const schema = getModuleSchema(moduleId);
  if (!schema) {
    return { rows: [], validCount: 0, errorCount: 0, error: "ai_import_err_unknown_module" };
  }

  const seenKeys = new Set();
  let validCount = 0;
  let errorCount = 0;

  const out = (rows || []).map((row, idx) => {
    const errors = [];
    const warnings = [];

    schema.fields.forEach((field) => {
      const errKey = validateField(field, row[field.key]);
      if (errKey) errors.push({ field: field.key, key: errKey });
    });

    const dupKey = typeof schema.duplicateKey === "function" ? schema.duplicateKey(row) : null;
    if (dupKey) {
      if (seenKeys.has(dupKey)) {
        warnings.push({ field: null, key: "ai_import_warn_duplicate_in_file" });
      }
      seenKeys.add(dupKey);
    }

    if (!errors.length) validCount++;
    else errorCount++;

    return { ...row, _rowIndex: idx, _errors: errors, _warnings: warnings, _dupKey: dupKey };
  });

  return { rows: out, validCount, errorCount };
}
