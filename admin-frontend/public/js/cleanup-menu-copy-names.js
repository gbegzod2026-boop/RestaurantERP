// cleanup-menu-copy-names.js
// Bir martalik tozalash skripti: allMenu ichidagi mahsulot nomlaridan
// takrorlangan "(копия)", "(nusxa)", "(copy)" qo'shimchalarini olib tashlaydi.
// Brauzer konsolida, tizimga kirgan holda, bitta marta ishga tushiring.

import { db } from "./firebase.js";
import { ref, get, update } from "./pgRtdb.js";

function restId() {
  return localStorage.getItem("restaurantId") || window.currentRestaurantId || "";
}

// Nom oxiridagi barcha takrorlangan "(копия)"/"(nusxa)"/"(copy)" bloklarini
// (bo'shliq bilan yoki bo'shliqsiz, istalgan sondagi takror) olib tashlaydi.
const COPY_SUFFIX_RE = /\s*\((копия|nusxa|copy)\)\s*$/i;
function stripCopySuffixes(name) {
  if (typeof name !== "string") return name;
  let prev = name;
  let curr = name.replace(COPY_SUFFIX_RE, "");
  while (curr !== prev) {
    prev = curr;
    curr = curr.replace(COPY_SUFFIX_RE, "");
  }
  return curr.trim();
}

async function cleanupMenuCopyNames({ dryRun = true } = {}) {
  const basePath = `restaurants/${restId()}/allMenu`;
  const snap = await get(ref(db, basePath));
  if (!snap.exists()) {
    console.log("allMenu topilmadi:", basePath);
    return;
  }

  const menu = snap.val();
  const updates = {};
  const report = [];

  for (const [menuId, item] of Object.entries(menu)) {
    if (!item) continue;

    if (typeof item.name === "string") {
      const cleaned = stripCopySuffixes(item.name);
      if (cleaned !== item.name) {
        updates[`${basePath}/${menuId}/name`] = cleaned;
        report.push({ menuId, field: "name", before: item.name, after: cleaned });
      }
    } else if (item.name && typeof item.name === "object") {
      for (const [lang, val] of Object.entries(item.name)) {
        const cleaned = stripCopySuffixes(val);
        if (cleaned !== val) {
          updates[`${basePath}/${menuId}/name/${lang}`] = cleaned;
          report.push({ menuId, field: `name.${lang}`, before: val, after: cleaned });
        }
      }
    }
  }

  console.log(`${report.length} ta yozuv tozalanadi:`);
  console.table(report);

  if (dryRun) {
    console.log("DRY RUN — hech narsa saqlanmadi. Haqiqatan qo'llash uchun: cleanupMenuCopyNames({ dryRun: false })");
    return report;
  }

  if (Object.keys(updates).length === 0) {
    console.log("Tozalash kerak bo'lgan yozuv topilmadi.");
    return report;
  }

  await update(ref(db), updates);
  console.log("Saqlandi:", Object.keys(updates).length, "ta maydon yangilandi.");
  return report;
}

window.cleanupMenuCopyNames = cleanupMenuCopyNames;
console.log("Tayyor. Avval tekshiring: cleanupMenuCopyNames()  →  keyin qo'llang: cleanupMenuCopyNames({ dryRun: false })");