// aiImport/settingsService.js — Settings → AI Smart Import.
// Mirrors backend/notifications/common.js's getNotificationSettings/
// updateNotificationSettings pattern exactly (defaults merged with whatever
// is actually stored, single RTDB path per restaurant).
// Architecture Fix Pass: database.rules.json requires `auth != null` on
// restaurants/$restId now, so every read/write here goes through the
// admin-or-client fallback (systemDb.js) instead of the plain client SDK.
import { systemGet, systemUpdate } from "../systemDb.js";

const SETTINGS_PATH = (restId) => `restaurants/${restId}/settings/aiImport`;

export const DEFAULT_AI_IMPORT_SETTINGS = {
  aiImportEnabled: true,
  manualImportEnabled: true,
  defaultMode: "manual", // "manual" | "ai"
  maxFileSizeMB: 10,
  allowedFileTypes: ["xlsx", "xls", "csv", "json", "xml", "pdf", "docx", "jpg", "jpeg", "png"],
  allowOcr: true,
  confidenceThreshold: 90,
  autoPreview: true,
  auditLogging: true,
};

export async function getAiImportSettings(restId) {
  const snap = await systemGet(SETTINGS_PATH(restId));
  return { ...DEFAULT_AI_IMPORT_SETTINGS, ...(snap.exists() ? snap.val() : {}) };
}

export async function updateAiImportSettings(restId, patch) {
  const clean = {
    aiImportEnabled: patch.aiImportEnabled !== false,
    manualImportEnabled: patch.manualImportEnabled !== false,
    defaultMode: patch.defaultMode === "ai" ? "ai" : "manual",
    maxFileSizeMB: Math.max(1, Number(patch.maxFileSizeMB) || DEFAULT_AI_IMPORT_SETTINGS.maxFileSizeMB),
    allowedFileTypes: Array.isArray(patch.allowedFileTypes) && patch.allowedFileTypes.length
      ? patch.allowedFileTypes
      : DEFAULT_AI_IMPORT_SETTINGS.allowedFileTypes,
    allowOcr: patch.allowOcr !== false,
    confidenceThreshold: Math.min(100, Math.max(50, Number(patch.confidenceThreshold) || DEFAULT_AI_IMPORT_SETTINGS.confidenceThreshold)),
    autoPreview: patch.autoPreview !== false,
    auditLogging: patch.auditLogging !== false,
  };
  await systemUpdate(SETTINGS_PATH(restId), clean);
  return clean;
}
