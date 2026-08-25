// routes/aiImport.js — REST surface for AI Smart Import. Mirrors the
// existing routes/notifications.js convention exactly: thin Express
// handlers delegating to backend/aiImport/*, requirePermission() gates on
// every route, restId resolved the same way every other router resolves it.
//
// RBAC note: the spec asks for three logical actions — view / create /
// history. This app's permission model uses one fixed action vocabulary
// across every module (view/create/edit/delete/export/refund/discount/
// manage_roles — see admin.js ALL_ACTIONS / rbac.js), so per the existing
// "don't invent a new permission model" convention, "history" is mapped
// onto the existing "export" action (closest existing meaning: access to
// historical/reporting records) rather than adding a new action string that
// the generic custom-role UI has no way to display.
import express from "express";
import { requirePermission } from "../rbac.js";
import { previewManualImport, analyzeWithAi, quickCaptureWithAi, commitImport } from "../aiImport/importService.js";
import { getAiImportSettings, updateAiImportSettings } from "../aiImport/settingsService.js";
import { ALL_MODULE_IDS, MANUAL_MODULE_IDS } from "../aiImport/moduleSchemas.js";
import { isSafeId } from "../security/sanitize.js";
// 🩹 429-storm fix: this limiter used to gate the whole router from server.js
// (every route, including the free GET modules/settings/history reads and the
// PUT settings save, sharing ONE 15-req/60s-per-restaurant bucket with the
// actual token-costing Gemini calls). Applied here, per-route, ONLY to the
// two routes that call Gemini (analyzeWithAi/quickCaptureWithAi below) — every
// other route in this file is still covered by the app-wide globalApiLimiter
// (server.js, 300 req/60s) same as before, just no longer sharing the tight
// AI-specific budget for routes that never touch Gemini.
import { aiImportLimiter } from "../security/rateLimit.js";
// Architecture Fix Pass: database.rules.json requires `auth != null` on
// restaurants/$restId now, so this file's own reads go through the
// admin-or-client fallback (systemDb.js) instead of the plain client SDK.
import { systemGet } from "../systemDb.js";

const router = express.Router();

function getRestId(req) {
  const raw = req.query.restId || req.body?.restId || req.headers["x-rest-id"] || process.env.DEFAULT_REST_ID || null;
  return raw && isSafeId(String(raw)) ? raw : null;
}

async function resolveActor(restId, userId) {
  if (!restId || !userId) return { userId: userId || null, userName: "", userRole: "" };
  const snap = await systemGet(`restaurants/${restId}/users/${userId}`);
  const user = snap.exists() ? snap.val() : {};
  return { userId, userName: user.name || "", userRole: user.role || "" };
}

// GET the list of destination modules this deployment supports (drives the
// Manual Import module picker — kept server-driven so a new module type
// only needs to be added in moduleSchemas.js once).
router.get("/ai-import/modules", requirePermission("ai_import", "view", getRestId), async (req, res) => {
  res.json({ manual: MANUAL_MODULE_IDS, all: ALL_MODULE_IDS });
});

router.get("/ai-import/settings", requirePermission("ai_import", "view", getRestId), async (req, res) => {
  const restId = getRestId(req);
  if (!restId) return res.status(400).json({ error: "restId required" });
  res.json(await getAiImportSettings(restId));
});

// Console-error fix pass: this used to check requirePermission("settings",
// "edit", ...) — a different module than every sibling route in this file
// (GET /modules, GET /settings, POST /preview, POST /analyze all check
// "ai_import"). No built-in role template grants "settings" and "ai_import"
// together except owner/admin (who bypass this check entirely anyway), so
// any OTHER role a restaurant had actually granted ai_import access to
// (via customRoles/roleOverrides) could view AI Import settings but never
// save them — the exact reported "Access Denied" on save only. Aligned
// with the rest of this file's own convention: same module, "edit" action
// (the file's header comment already documents this module's action
// vocabulary as view/create/edit/export).
router.put("/ai-import/settings", requirePermission("ai_import", "edit", getRestId), async (req, res) => {
  const restId = getRestId(req);
  if (!restId) return res.status(400).json({ error: "restId required" });
  res.json(await updateAiImportSettings(restId, req.body || {}));
});

// ── MODE 1 — Manual Import. Parsing already happened client-side; this
// endpoint only validates + classifies rows. Nothing here imports
// geminiImportService, so this code path physically cannot call Gemini.
router.post("/ai-import/preview", requirePermission("ai_import", "create", getRestId), async (req, res) => {
  const restId = getRestId(req);
  const { moduleId, rows } = req.body || {};
  if (!restId) return res.status(400).json({ error: "restId required" });
  if (!moduleId || !Array.isArray(rows)) return res.status(400).json({ error: "moduleId and rows[] required" });

  try {
    const preview = await previewManualImport(restId, moduleId, rows);
    res.json(preview);
  } catch (err) {
    console.error("[aiImport] /preview error:", err.message);
    res.status(500).json({ ok: false, error: "ai_import_err_preview_failed" });
  }
});

// ── MODE 2 — AI Smart Import. Module NOT preselected; Gemini detects it.
router.post("/ai-import/analyze", aiImportLimiter, requirePermission("ai_import", "create", getRestId), async (req, res) => {
  const restId = getRestId(req);
  const { parts } = req.body || {};
  if (!restId) return res.status(400).json({ error: "restId required" });
  if (!Array.isArray(parts) || !parts.length) return res.status(400).json({ error: "parts[] required" });

  try {
    const result = await analyzeWithAi(restId, parts);
    res.json(result);
  } catch (err) {
    console.error("[aiImport] /analyze error:", err.message);
    const status = err.code === "NO_API_KEY" ? 503 : err.code === "AI_DISABLED" ? 403 : 500;
    res.status(status).json({ ok: false, error: err.message || "ai_import_err_analyze_failed" });
  }
});

// Legacy single/few-item quick-capture — the pre-existing "AI Import" modal
// (admin.js) calls this with a preselected type. Kept fully backward
// compatible so that older client bundles (or a cached page) don't break.
router.post("/ai-import", aiImportLimiter, requirePermission("ai_import", "create", getRestId), async (req, res) => {
  const { type, parts, instruction } = req.body || {};
  if (!type || !Array.isArray(parts) || !parts.length) {
    return res.status(400).json({ error: "type and parts[] required" });
  }
  // `instruction` flows straight into the Gemini system prompt
  // (geminiImportService.quickCapture) — capped to a sane length as
  // defense-in-depth against prompt-injection payloads riding along in a
  // field that's meant to be a short one-line extraction hint. The real
  // backstop stays what it already was: commitImport() re-validates every
  // row server-side against the module's schema regardless of what the AI
  // returned, so this endpoint can never write unvalidated data either way.
  if (instruction != null && String(instruction).length > 2000) {
    return res.status(400).json({ error: "instruction too long" });
  }
  try {
    const items = await quickCaptureWithAi(type, parts, instruction);
    res.json({ items });
  } catch (err) {
    console.error("[aiImport] legacy /ai-import error:", err.message);
    const status = err.code === "NO_API_KEY" ? 503 : 500;
    res.status(status).json({ error: err.message || "ai_import_err_analyze_failed" });
  }
});

// ── COMMIT — shared by both modes. Re-validates server-side regardless of
// which mode produced the rows, writes to Firebase, then audits.
// Registered under BOTH "/commit" (what admin-frontend/public/js/
// aiImportClient.js actually calls) and "/import" (the path name some
// callers — e.g. manual API testing — expect) so neither naming breaks;
// same handler, no duplicated logic.
async function handleCommit(req, res) {
  const restId = getRestId(req);
  const { moduleId, mode, rows, fileName, docType, confidence } = req.body || {};
  if (!restId) return res.status(400).json({ error: "restId required" });
  if (!moduleId || !Array.isArray(rows)) return res.status(400).json({ error: "moduleId and rows[] required" });

  try {
    // Production Security Fix Pass (P0-1): req.nestaAuth is the VERIFIED
    // identity requirePermission() just resolved (both routes that reach
    // handleCommit are gated by it) — reused here instead of the raw
    // x-user-id header so the commit's audit trail can't be mislabeled by a
    // spoofed header.
    const actor = await resolveActor(restId, req.nestaAuth?.userId);
    const result = await commitImport(restId, {
      moduleId,
      mode: mode === "ai" ? "ai" : "manual",
      rows,
      fileName: fileName || "",
      docType,
      confidence,
      ...actor,
    });
    res.json(result);
  } catch (err) {
    console.error("[aiImport] /commit error:", err.message);
    // Production Security Fix Pass, Phase 4 (Low: information disclosure) —
    // this was the one route returning a raw internal error message to the
    // client; every other route in the app returns a generic string and
    // logs the real message server-side only (see the try/catch pattern in
    // server.js and the other routers). Same response shape/status either
    // way — only the message text changes.
    res.status(500).json({ ok: false, error: "ai_import_err_commit_failed" });
  }
}

router.post("/ai-import/commit", requirePermission("ai_import", "create", getRestId), handleCommit);
router.post("/ai-import/import", requirePermission("ai_import", "create", getRestId), handleCommit);

// ── IMPORT HISTORY — "history" action, mapped to "export" (see file header).
router.get("/ai-import/history", requirePermission("ai_import", "export", getRestId), async (req, res) => {
  const restId = getRestId(req);
  if (!restId) return res.status(400).json({ error: "restId required" });

  const snap = await systemGet(`restaurants/${restId}/importHistory`);
  const rows = Object.entries(snap.exists() ? snap.val() : {})
    .map(([id, row]) => ({ id, ...row }))
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  res.json({ rows });
});

export default router;
