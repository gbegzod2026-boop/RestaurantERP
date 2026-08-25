// aiImport/geminiImportService.js — the ONLY file in this codebase allowed
// to call the Gemini API. Manual Import never imports this module at all
// (see routes/aiImport.js: the /parse and /preview handlers don't even
// import geminiImportService), so there is no code path by which choosing
// Manual mode can ever trigger generateContent() — zero AI cost is
// structural, not just a runtime check.
//
// The API key lives only in process.env.GEMINI_API_KEY (backend-only, never
// sent to the frontend — mirrors how TelegramProvider.js keeps the bot token
// server-side and talks to Telegram's REST API directly via fetch(), which
// is the existing convention this file follows instead of pulling in the
// @google/generative-ai SDK as a new dependency).
import { ALL_MODULE_IDS, MODULE_SCHEMAS } from "./moduleSchemas.js";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

function stripCodeFence(text) {
  return String(text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
}

/** Low-level call — never used with Manual Mode data. */
async function callGemini(systemInstruction, parts) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("[GeminiImportService] GEMINI_API_KEY is not set — AI Import cannot run.");
    const err = new Error("ai_import_err_no_api_key");
    err.code = "NO_API_KEY";
    throw err;
  }

  const body = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: "user", parts }],
    generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
  };

  console.log(`[GeminiImportService] Calling ${GEMINI_MODEL} — ${parts.length} part(s)`);
  const t0 = Date.now();
  const res = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  const ms = Date.now() - t0;

  if (!res.ok) {
    console.error(`[GeminiImportService] Gemini error (${res.status}, ${ms}ms):`, json?.error?.message || json);
    const err = new Error(json?.error?.message || `Gemini HTTP ${res.status}`);
    err.code = "GEMINI_ERROR";
    throw err;
  }

  const textOut = (json.candidates || [])
    .flatMap((c) => c.content?.parts || [])
    .map((p) => p.text || "")
    .join("\n");

  console.log(`[GeminiImportService] Gemini responded in ${ms}ms (${textOut.length} chars)`);

  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(textOut));
  } catch (e) {
    console.error("[GeminiImportService] Failed to parse Gemini JSON response:", textOut.slice(0, 500));
    const err = new Error("ai_import_err_ai_parse_failed");
    err.code = "PARSE_FAILED";
    throw err;
  }
  return parsed;
}

function buildModuleCatalogText() {
  return ALL_MODULE_IDS.map((id) => {
    const schema = MODULE_SCHEMAS[id];
    const fieldList = schema.fields.map((f) => `${f.key}${f.required ? " (required)" : ""}: ${f.type}`).join(", ");
    return `- "${id}": ${fieldList}`;
  }).join("\n");
}

/**
 * AI Smart Import (Mode 2) — module NOT preselected. Gemini must detect the
 * document type, the destination module, extract structured rows in that
 * module's exact field shape, and report a confidence score.
 *
 * `parts` is an array of Gemini content parts: { text } for
 * already-extracted text (Excel/CSV/JSON/XML/Word, extracted client-side) or
 * { inlineData: { mimeType, data(base64) } } for images/PDF sent as-is.
 */
export async function detectAndExtract(parts) {
  const systemInstruction = `Sen restoran boshqaruv tizimi (Nesta ERP) uchun "AI Smart Import" yordamchisisan.
Foydalanuvchi yuklagan hujjatni tahlil qil va quyidagilarni bajar:
1. Hujjat turini aniqla (masalan: chek, faktura, ta'minotchi narxlar ro'yxati, restoran menyusi, xodimlar ro'yxati va h.k.)
2. Ma'lumot qaysi modulga tegishli ekanini aniqla. Faqat quyidagi modullardan birini tanla:
${buildModuleCatalogText()}
3. Har bir modul uchun yuqorida ko'rsatilgan maydonlar bo'yicha strukturaviy ma'lumotni chiqar.
4. Aniqlaganingga qanchalik ishonch bilan qaraganingni 0-100 oralig'ida confidence sifatida bahola.
5. Agar ikkinchi darajali mos modul ham bo'lishi mumkin bo'lsa, uni alternatives ichida ko'rsat.

FAQAT quyidagi JSON formatida javob qaytar, boshqa hech qanday matn yoki izoh yozma:
{
  "docType": "hujjat turi tavsifi",
  "detectedModule": "yuqoridagi modullardan biri",
  "confidence": 0-100 oralig'idagi son,
  "alternatives": [{ "module": "modul_id", "confidence": son }],
  "rows": [ { tegishli modul maydonlari bo'yicha obyekt } ]
}
Agar bitta yozuv topilsa ham, "rows" massiv ichida bitta element bo'lsin. Topilmagan maydonni bo'sh string yoki 0 qilib qoldir, lekin maydonni albatta kirit.`;

  const result = await callGemini(systemInstruction, parts);

  const detectedModule = ALL_MODULE_IDS.includes(result.detectedModule) ? result.detectedModule : null;
  const confidence = Number(result.confidence);
  const alternatives = Array.isArray(result.alternatives)
    ? result.alternatives.filter((a) => ALL_MODULE_IDS.includes(a.module)).map((a) => ({ module: a.module, confidence: Number(a.confidence) || 0 }))
    : [];

  return {
    docType: result.docType || "",
    detectedModule,
    confidence: Number.isFinite(confidence) ? confidence : 0,
    alternatives,
    rows: Array.isArray(result.rows) ? result.rows : [],
  };
}

/**
 * Backward-compatible with the pre-existing single-item "AI Import" modal
 * (admin.js's callClaudeForImport, now actually wired to a real backend):
 * the destination module IS preselected here, so this simply extracts rows
 * in that module's shape without needing module detection.
 */
export async function quickCapture(moduleId, parts, instruction) {
  const schema = MODULE_SCHEMAS[moduleId];
  if (!schema) {
    const err = new Error("ai_import_err_unknown_module");
    err.code = "UNKNOWN_MODULE";
    throw err;
  }
  const fieldList = schema.fields.map((f) => f.key).join(", ");
  // `instruction` is the frontend's own hand-written per-type extraction
  // guidance (admin.js's AI_IMPORT_TYPE_PROMPTS — e.g. how to merge a
  // multi-item receipt into one expense record); fall back to a generic
  // instruction if the caller didn't provide one.
  const typeInstruction = instruction || `Bu hujjatdan "${moduleId}" turidagi ma'lumotni chiqar.`;
  const systemInstruction = `Sen restoran boshqaruv tizimi uchun ma'lumot import qiluvchi yordamchisan.
${typeInstruction}
Har bir yozuv uchun quyidagi maydonlar bo'lsin: ${fieldList}.
Faqat JSON qaytar, hech qanday izoh yoki markdown belgilarisiz.
Format: {"items": [ { yuqoridagi maydonlar bo'yicha obyekt } ]}
Agar hujjatda faqat bitta yozuv bo'lsa ham, "items" array ichida bitta element bo'lsin.
Agar biror maydon topilmasa, uni bo'sh string yoki 0 qilib qoldir, lekin maydonni albatta kirit.`;

  const result = await callGemini(systemInstruction, parts);
  return Array.isArray(result.items) ? result.items : [result];
}
