// Temporary read-only summarizer for the discovery report (deleted after use).
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT = path.join(__dirname, "../../../docs/migration-reports/firebase-discovery-latest.json");
const r = JSON.parse(readFileSync(REPORT, "utf8"));

const want = process.argv.slice(2);
const cols = want.length ? want : ["orders", "menu", "users", "customers", "tables", "reservations", "info", "settings", "inventory", "expenses", "finance", "couriers", "categories"];

console.log("ROOT KEY STATUS");
for (const [k, v] of Object.entries(r.rootKeys.status)) {
  if (String(v).startsWith("ABSENT")) console.log(`  ${k.padEnd(20)} ${v}`);
}
console.log("\nRESTAURANTS:", r.restaurants.count);

for (const c of cols) {
  const p = r.profiles[c];
  if (!p) { console.log(`\n### ${c}: NOT PRESENT`); continue; }
  console.log(`\n### ${c}  (in ${p.restaurantsWithCollection} restaurants, ${p.totalChildrenAcrossRestaurants} total children, ${p.recordsSampled} sampled)`);
  console.log(`    keyFormats: ${JSON.stringify(p.keyFormats)}`);
  if (p.nonObjectRecords) console.log(`    nonObjectRecords: ${p.nonObjectRecords}`);
  const fields = Object.entries(p.fields);
  for (const [name, f] of fields.slice(0, 60)) {
    const money = f.moneyAnomalies ? ` MONEY_ANOMALY=${JSON.stringify(f.moneyAnomalies)}` : "";
    const child = f.childKeys ? ` children=[${f.childKeys.join(",")}]` : "";
    let s = JSON.stringify(f.samples);
    if (s && s.length > 150) s = s.slice(0, 150) + "…";
    console.log(`    ${name.padEnd(24)} fill=${String(f.fillRate).padEnd(5)} types=${f.types.join("|").padEnd(18)} ${s}${child}${money}`);
  }
  if (fields.length > 60) console.log(`    … +${fields.length - 60} more fields`);
  if (p.nestedLevel2) {
    console.log(`    -- nested level 2 --  keyFormats=${JSON.stringify(p.nestedLevel2.keyFormats)}`);
    for (const [n, f] of Object.entries(p.nestedLevel2.fields).slice(0, 20)) {
      console.log(`       ${n.padEnd(22)} types=${f.types.join("|")}`);
    }
  }
}
