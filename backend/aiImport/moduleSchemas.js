// aiImport/moduleSchemas.js — canonical per-destination-module schema catalog
// for the AI Smart Import feature.
//
// This mirrors (does not duplicate the intent of, but necessarily re-states
// server-side, exactly like rbac.js already does for ROLE_TEMPLATES vs
// admin.js) the AI_IMPORT_FIELD_SCHEMAS object in
// admin-frontend/public/js/admin.js's existing "AI Import" block, plus the
// real Firebase write shapes already used by saveQuickAddItem()/
// saveAiImportItem() in that same file. The backend can never trust the
// client's field list, so validationService/previewService/importService
// all read from THIS copy.
//
// Each module entry:
//   path(restId)        -> RTDB path new rows are pushed under
//   fields               -> [{ key, type: "text"|"number"|"email"|"phone"|"date", required }]
//   duplicateKey(row)    -> string used to detect "this already exists" (or null = never dedupe)
//   findExisting(existingList, row) -> the matching existing record, if any (for "updated" vs "new")
//   toRecord(row)        -> maps a validated input row to the exact Firebase record shape
//   mirrorPath(restId, id) -> optional second path the same record must also be written to (e.g. inventory -> ingredients)
export const MODULE_SCHEMAS = {
  menu: {
    labelKey: "ai_import_type_menu",
    path: (restId) => `restaurants/${restId}/menu`,
    fields: [
      { key: "name", type: "text", required: true },
      { key: "price", type: "number", required: true },
      { key: "category", type: "text", required: false },
    ],
    duplicateKey: (row) => `${String(row.name || "").trim().toLowerCase()}::${String(row.category || "").trim().toLowerCase()}`,
    toRecord: (row) => ({
      name: { uz: row.name || "", ru: "", en: "" },
      price: Number(row.price) || 0,
      category: row.category || "",
      createdAt: Date.now(),
      importedFrom: "ai_import",
    }),
  },

  inventory: {
    labelKey: "ai_import_type_inventory",
    path: (restId) => `restaurants/${restId}/inventory`,
    mirrorPath: (restId, id) => `restaurants/${restId}/ingredients/${id}`,
    fields: [
      { key: "name", type: "text", required: true },
      { key: "stock", type: "number", required: false },
      { key: "unit", type: "text", required: false },
      { key: "price", type: "number", required: false },
    ],
    duplicateKey: (row) => String(row.name || "").trim().toLowerCase(),
    toRecord: (row) => ({
      name: row.name || "",
      stock: Number(row.stock) || 0,
      unit: row.unit || "dona",
      price: Number(row.price) || 0,
      minStock: 0,
      createdAt: Date.now(),
      addedFrom: "ai_import",
    }),
  },

  staff: {
    labelKey: "ai_import_type_staff",
    path: (restId) => `restaurants/${restId}/users`,
    fields: [
      { key: "name", type: "text", required: true },
      { key: "phone", type: "phone", required: false },
      { key: "role", type: "text", required: false },
      { key: "salary", type: "number", required: false },
    ],
    duplicateKey: (row) => String(row.phone || "").replace(/\D/g, ""),
    toRecord: (row) => ({
      name: row.name || "",
      phone: row.phone || "",
      role: row.role || "waiter",
      salary: Number(row.salary) || 0,
      createdAt: Date.now(),
      importedFrom: "ai_import",
    }),
  },

  expense: {
    labelKey: "ai_import_type_expense",
    path: (restId) => `restaurants/${restId}/expenses`,
    fields: [
      { key: "name", type: "text", required: true },
      { key: "supplierName", type: "text", required: false },
      { key: "amount", type: "number", required: true },
      { key: "category", type: "text", required: false },
      { key: "note", type: "text", required: false },
    ],
    duplicateKey: () => null, // Har bir xarajat mustaqil yozuv — takrorlanish tekshirilmaydi
    toRecord: (row) => ({
      name: row.name || "",
      supplierName: row.supplierName || "",
      amount: Number(row.amount) || 0,
      category: row.category || "other",
      recurring: "once",
      note: row.note || "",
      date: Date.now(),
      importedFrom: "ai_import",
    }),
  },

  customer: {
    labelKey: "ai_import_type_customer",
    path: (restId) => `restaurants/${restId}/customers`,
    fields: [
      { key: "name", type: "text", required: true },
      { key: "phone", type: "phone", required: true },
      { key: "note", type: "text", required: false },
    ],
    // customers already keys itself by phone in the real app (see admin.js
    // saveQuickAddItem "customer" branch) — so duplicateKey doubles as the
    // literal Firebase key here.
    duplicateKey: (row) => (row.phone || "").replace(/[^\d+]/g, "") || null,
    keyedByDuplicateKey: true,
    toRecord: (row) => ({
      name: row.name || "",
      phone: row.phone || "",
      note: row.note || "",
      updatedAt: Date.now(),
      importedFrom: "ai_import",
    }),
  },

  reservation: {
    labelKey: "ai_import_type_reservation",
    path: (restId) => `restaurants/${restId}/reservations`,
    fields: [
      { key: "guestName", type: "text", required: true },
      { key: "phone", type: "phone", required: false },
      { key: "date", type: "date", required: true },
      { key: "time", type: "text", required: false },
      { key: "guests", type: "number", required: false },
      { key: "table", type: "text", required: false },
      { key: "note", type: "text", required: false },
    ],
    duplicateKey: (row) => `${(row.phone || "").replace(/\D/g, "")}::${row.date || ""}::${row.time || ""}`,
    toRecord: (row) => ({
      guestName: row.guestName || "",
      phone: row.phone || "",
      date: row.date || "",
      time: row.time || "",
      guests: Number(row.guests) || 1,
      table: row.table || "",
      note: row.note || "",
      status: "pending",
      createdAt: Date.now(),
      importedFrom: "ai_import",
    }),
  },

  courier: {
    labelKey: "ai_import_type_courier",
    path: (restId) => `restaurants/${restId}/couriers`,
    fields: [
      { key: "name", type: "text", required: true },
      { key: "phone", type: "phone", required: true },
      { key: "vehicleType", type: "text", required: false },
    ],
    duplicateKey: (row) => String(row.phone || "").replace(/\D/g, ""),
    toRecord: (row) => ({
      name: row.name || "",
      phone: row.phone || "",
      vehicleType: row.vehicleType || "on_foot",
      status: "offline",
      createdAt: Date.now(),
      importedFrom: "ai_import",
    }),
  },

  supplier: {
    labelKey: "ai_import_type_supplier",
    path: (restId) => `restaurants/${restId}/suppliers`,
    fields: [
      { key: "name", type: "text", required: true },
      { key: "phone", type: "phone", required: false },
      { key: "address", type: "text", required: false },
      { key: "note", type: "text", required: false },
    ],
    duplicateKey: (row) => `${String(row.name || "").trim().toLowerCase()}::${String(row.phone || "").replace(/\D/g, "")}`,
    toRecord: (row) => ({
      name: row.name || "",
      phone: row.phone || "",
      address: row.address || "",
      note: row.note || "",
      createdAt: Date.now(),
      importedFrom: "ai_import",
    }),
  },

  // "report" — AI-only, single free-text summary capture (kept for exact
  // backward compatibility with the pre-existing quick-capture modal).
  // Not offered as a Manual Import destination since it isn't tabular data.
  report: {
    labelKey: "ai_import_type_report",
    path: (restId) => `restaurants/${restId}/ai_reports`,
    fields: [
      { key: "title", type: "text", required: true },
      { key: "summary", type: "text", required: true },
    ],
    duplicateKey: () => null,
    aiOnly: true,
    toRecord: (row) => ({
      title: row.title || "",
      summary: row.summary || "",
      createdAt: Date.now(),
      importedFrom: "ai_import",
    }),
  },
};

/** Modules offered in Manual Import's "choose destination first" picker — tabular data only. */
export const MANUAL_MODULE_IDS = Object.keys(MODULE_SCHEMAS).filter((id) => !MODULE_SCHEMAS[id].aiOnly);

/** Every module id, including AI-only ones — used by Gemini's detection prompt. */
export const ALL_MODULE_IDS = Object.keys(MODULE_SCHEMAS);

export function getModuleSchema(moduleId) {
  return MODULE_SCHEMAS[moduleId] || null;
}
