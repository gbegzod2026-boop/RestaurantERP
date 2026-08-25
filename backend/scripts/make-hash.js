// scripts/make-hash.js — dev utility: prints a bcrypt hash for a sample
// password, useful for manually seeding a test account. Not imported by any
// other module, not on any HTTP-servable or execution path — safe to run
// standalone only (`node scripts/make-hash.js`).
//
// P3 fix (PRODUCTION-AUDIT.md #20): moved here from the backend/ root
// (cosmetic-only reorg, confirmed unreferenced anywhere before the move).
import bcrypt from "bcryptjs";

const hash = await bcrypt.hash("123567", 10);

console.log(hash);
console.log("length:", hash.length);
