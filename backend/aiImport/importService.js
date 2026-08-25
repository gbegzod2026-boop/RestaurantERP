// aiImport/importService.js — the orchestrator. Routes/aiImport.js stays a
// thin Express layer (mirroring routes/notifications.js's own convention);
// all real logic lives here so it's independently testable and so the two
// modes share every step EXCEPT the Gemini call itself.
// Architecture Fix Pass: database.rules.json requires `auth != null` on
// restaurants/$restId now, so every write here goes through the admin-or-
// client fallback (systemDb.js) instead of the plain client SDK.
import { systemSet, systemUpdate, systemPush } from "../systemDb.js";
import { getModuleSchema } from "./moduleSchemas.js";
import { buildPreview } from "./previewService.js";
import { validateRows } from "./validationService.js";
import { writeImportAudit } from "./auditService.js";
import { getAiImportSettings } from "./settingsService.js";
import * as geminiImportService from "./geminiImportService.js";

/** Manual mode preview — parsing already happened client-side; never touches Gemini. */
export async function previewManualImport(restId, moduleId, rows) {
  return buildPreview(restId, moduleId, rows);
}

/**
 * AI mode analyze — the ONLY function in importService that reaches
 * geminiImportService. `parts` are pre-built Gemini content parts (text for
 * already-extracted Excel/CSV/JSON/XML/Word content, inlineData for
 * images/PDF) — see routes/aiImport.js for how the request body is turned
 * into parts.
 */
export async function analyzeWithAi(restId, parts) {
  const settings = await getAiImportSettings(restId);
  if (!settings.aiImportEnabled) {
    const err = new Error("ai_import_err_ai_disabled");
    err.code = "AI_DISABLED";
    throw err;
  }

  const result = await geminiImportService.detectAndExtract(parts);

  if (!result.detectedModule) {
    return { ok: false, needsModuleChoice: true, ...result };
  }

  const preview = await buildPreview(restId, result.detectedModule, result.rows);

  // Spec: "If confidence < 90% -> ask user to choose one of suggested
  // modules. Never import automatically." The preview is still returned
  // (so the UI can show it once the user confirms the module), but the
  // frontend must treat confidence < threshold as "needs confirmation",
  // never auto-committing.
  const needsConfirmation = result.confidence < settings.confidenceThreshold;

  return {
    ok: true,
    docType: result.docType,
    detectedModule: result.detectedModule,
    confidence: result.confidence,
    alternatives: result.alternatives,
    needsConfirmation,
    confidenceThreshold: settings.confidenceThreshold,
    preview,
  };
}

/** Backward-compatible single/few-item quick-capture (the pre-existing modal), now real. */
export async function quickCaptureWithAi(moduleId, parts, instruction) {
  return geminiImportService.quickCapture(moduleId, parts, instruction);
}

/**
 * Commits a previously-previewed row set to Firebase. Re-validates
 * server-side no matter which mode produced the rows (never trusts the
 * client's own validation pass), writes each row via its module's toRecord()
 * mapping, mirrors to a second path when the schema declares one (e.g.
 * inventory -> ingredients, exactly matching the existing manual "quick add"
 * behaviour), then logs the audit + import-history entry.
 */
export async function commitImport(restId, { moduleId, mode, rows, fileName, userId, userName, userRole, docType, confidence }) {
  const startedAt = Date.now();
  const schema = getModuleSchema(moduleId);
  if (!schema) {
    const err = new Error("ai_import_err_unknown_module");
    err.code = "UNKNOWN_MODULE";
    throw err;
  }

  const { rows: validated } = validateRows(moduleId, rows);

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of validated) {
    if (row._errors.length) { errors++; skipped++; continue; }

    const record = schema.toRecord(row);

    if (schema.keyedByDuplicateKey) {
      // e.g. customers — the duplicate key IS the Firebase key (update, not push)
      const key = row._dupKey;
      if (!key) { errors++; skipped++; continue; }
      await systemUpdate(`${schema.path(restId)}/${key}`, record);
      imported++; // treated as a successful upsert either way
      continue;
    }

    const newKey = await systemPush(schema.path(restId), record);
    if (schema.mirrorPath) {
      await systemSet(schema.mirrorPath(restId, newKey), record);
    }
    if (row._status === "updated") updated++;
    else imported++;
  }

  const durationMs = Date.now() - startedAt;
  const settings = await getAiImportSettings(restId);

  if (settings.auditLogging) {
    await writeImportAudit(restId, {
      userId, userName, userRole,
      mode, moduleId, fileName,
      imported, updated, skipped, errors,
      durationMs, status: "success", docType, confidence,
    });
  }

  return { ok: true, imported, updated, skipped, errors, durationMs };
}
