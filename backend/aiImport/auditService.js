// aiImport/auditService.js — writes every import to TWO places:
//   1. restaurants/{restId}/activityLogs — the SAME node the existing Audit
//      Log page already reads (admin.js loadAuditLog() queries exactly this
//      path), in the exact record shape crmAdvAudit() already writes
//      (module/action/target/severity/description/payload/createdAt/userId/
//      userName/userRole) — so an import shows up in the general Audit Log
//      for free, with zero changes to that existing page.
//   2. restaurants/{restId}/importHistory — a richer, import-specific record
//      (file name, mode, counts, duration) backing the new Import History
//      page, which needs more structured detail than the generic audit
//      table's columns can show.
// Architecture Fix Pass: database.rules.json requires `auth != null` on
// restaurants/$restId now, so both writes here go through the admin-or-
// client fallback (systemDb.js) instead of the plain client SDK.
import { systemPush } from "../systemDb.js";

export async function writeImportAudit(restId, entry) {
  const {
    userId, userName, userRole,
    mode, moduleId, fileName,
    imported, updated, skipped, errors,
    durationMs, status, docType, confidence,
  } = entry;

  const now = Date.now();

  const activityDescription = status === "failed"
    ? `AI Smart Import: "${fileName}" — muvaffaqiyatsiz (${mode === "ai" ? "AI" : "Manual"})`
    : `AI Smart Import: "${fileName}" — ${imported} yangi, ${updated} yangilandi, ${skipped} o'tkazib yuborildi (${mode === "ai" ? "AI" : "Manual"})`;

  await systemPush(`restaurants/${restId}/activityLogs`, {
    userId: userId || null,
    userName: userName || "",
    userRole: userRole || "",
    module: "ai_import",
    action: mode === "ai" ? "ai_import_ai" : "ai_import_manual",
    target: moduleId || "",
    severity: status === "failed" ? "warning" : "info",
    description: activityDescription,
    payload: { fileName, moduleId, imported, updated, skipped, errors },
    createdAt: now,
  });

  await systemPush(`restaurants/${restId}/importHistory`, {
    userId: userId || null,
    userName: userName || "",
    mode,
    moduleId: moduleId || "",
    docType: docType || "",
    confidence: typeof confidence === "number" ? confidence : null,
    fileName: fileName || "",
    imported: imported || 0,
    updated: updated || 0,
    skipped: skipped || 0,
    errors: errors || 0,
    durationMs: durationMs || 0,
    status: status || "success",
    createdAt: now,
  });
}
