export const EXPECTED_FIREBASE_PROJECT = "restoran-30d51";

export function freezeSnapshotComplete(doc) {
  if (!doc || doc.freezeWindow !== true || doc.mode !== "READ-ONLY") return false;
  if (doc.firebaseProject !== EXPECTED_FIREBASE_PROJECT) return false;
  const c = doc.counts || {};
  return ["restaurants", "users", "orders", "orderItems", "payments", "menu"].every(
    (k) => typeof c[k] === "number"
  );
}
