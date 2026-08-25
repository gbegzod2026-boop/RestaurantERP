// aiImport/previewService.js — classifies validated rows into new / updated
// / skipped against whatever already exists in Firebase for that module, and
// builds the summary counts the Preview screen (spec section "PREVIEW")
// requires: Detected Module, Rows, New records, Updated records, Skipped
// records, Errors, Warnings.
// Architecture Fix Pass: database.rules.json requires `auth != null` on
// restaurants/$restId now, so this read goes through the admin-or-client
// fallback (systemDb.js) instead of the plain client SDK.
import { systemGet } from "../systemDb.js";
import { getModuleSchema } from "./moduleSchemas.js";
import { validateRows } from "./validationService.js";

async function loadExistingRecords(restId, moduleId) {
  const schema = getModuleSchema(moduleId);
  if (!schema) return [];
  const snap = await systemGet(schema.path(restId));
  if (!snap.exists()) return [];
  const val = snap.val();
  return Object.entries(val).map(([id, data]) => ({ id, ...data }));
}

/**
 * Builds the full preview object for a set of already-parsed (Manual) or
 * AI-extracted (AI mode) rows, without writing anything to Firebase.
 */
export async function buildPreview(restId, moduleId, rawRows) {
  const schema = getModuleSchema(moduleId);
  if (!schema) {
    return { ok: false, error: "ai_import_err_unknown_module" };
  }

  const { rows: validated, validCount, errorCount } = validateRows(moduleId, rawRows);
  const existing = await loadExistingRecords(restId, moduleId);
  const existingKeys = new Set(
    existing.map((rec) => (typeof schema.duplicateKey === "function" ? schema.duplicateKey(rec) : null)).filter(Boolean)
  );

  let newCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;

  const rows = validated.map((row) => {
    if (row._errors.length) {
      skippedCount++;
      return { ...row, _status: "error" };
    }
    const dupKey = row._dupKey;
    if (dupKey && existingKeys.has(dupKey)) {
      updatedCount++;
      return { ...row, _status: "updated" };
    }
    newCount++;
    return { ...row, _status: "new" };
  });

  return {
    ok: true,
    moduleId,
    moduleLabelKey: schema.labelKey,
    totalRows: rows.length,
    newCount,
    updatedCount,
    skippedCount,
    errorCount,
    warningCount: rows.reduce((sum, r) => sum + (r._warnings?.length || 0), 0),
    validCount,
    rows,
  };
}
