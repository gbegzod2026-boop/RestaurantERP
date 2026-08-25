// db/scripts/lib/report.mjs — structured reporting for the migration engine.
//
// Phase 1 requirements #13/#14/#15 all come down to one rule: a migration that
// finishes is not a migration that succeeded. This module is what makes the
// difference measurable — it forces every record into exactly one of six
// outcomes and refuses to let a skipped record disappear without a Firebase
// path, a legacy id, a reason and a severity.
import { writeFileSync, mkdirSync } from "fs";
import path from "path";

export const OUTCOME = Object.freeze({
  MIGRATED: "migrated",
  SKIPPED: "skipped",
  FAILED: "failed",
  DUPLICATE: "duplicate",
  MALFORMED: "malformed",
  VERIFIED: "verified",
});

export const SEVERITY = Object.freeze({
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
  CRITICAL: "critical",
});

export class MigrationReport {
  constructor({ mode, reportDir }) {
    this.mode = mode;
    this.reportDir = reportDir;
    this.startedAt = new Date();
    this.restaurants = {};   // restId -> { entity -> counters }
    this.dataLoss = [];      // every skipped/failed record, fully attributed
    this.warnings = [];      // non-fatal findings (precision loss, negatives)
    this.reconciliation = {};
    this.fatal = [];
    this.writes = { inserted: 0, updated: 0 };
  }

  _bucket(restId, entity) {
    const r = (this.restaurants[restId] ||= {});
    return (r[entity] ||= {
      migrated: 0, skipped: 0, failed: 0, duplicate: 0, malformed: 0, verified: 0,
      firebaseRecords: 0,
    });
  }

  seen(restId, entity, n = 1) {
    this._bucket(restId, entity).firebaseRecords += n;
  }

  count(restId, entity, outcome, n = 1) {
    this._bucket(restId, entity)[outcome] += n;
  }

  countWrite(kind, n = 1) {
    if (kind === "inserted" || kind === "updated") this.writes[kind] += n;
  }

  /** Records a record that did NOT make it into PostgreSQL. Every argument is
   *  mandatory by contract — an entry without a path or a reason is exactly
   *  the silent data loss this phase forbids. */
  lose({ restId, entity, firebasePath, legacyId, reason, severity = SEVERITY.ERROR, detail = null, outcome = OUTCOME.SKIPPED }) {
    this.count(restId, entity, outcome);
    this.dataLoss.push({
      restaurantId: restId, entity, firebasePath, legacyId,
      reason, severity, detail, outcome,
    });
  }

  /** A record that WAS migrated but carries a finding worth surfacing. */
  warn({ restId, entity, firebasePath, legacyId, code, detail = null, severity = SEVERITY.WARN }) {
    this.warnings.push({ restaurantId: restId, entity, firebasePath, legacyId, code, detail, severity });
  }

  fatalError(scope, err) {
    this.fatal.push({ scope, message: err?.message || String(err), stack: err?.stack || null });
  }

  totals() {
    const t = { migrated: 0, skipped: 0, failed: 0, duplicate: 0, malformed: 0, verified: 0, firebaseRecords: 0 };
    for (const entities of Object.values(this.restaurants)) {
      for (const c of Object.values(entities)) {
        for (const k of Object.keys(t)) t[k] += c[k] || 0;
      }
    }
    return t;
  }

  perEntityTotals() {
    const out = {};
    for (const entities of Object.values(this.restaurants)) {
      for (const [entity, c] of Object.entries(entities)) {
        const e = (out[entity] ||= { migrated: 0, skipped: 0, failed: 0, duplicate: 0, malformed: 0, verified: 0, firebaseRecords: 0 });
        for (const k of Object.keys(e)) e[k] += c[k] || 0;
      }
    }
    return out;
  }

  /** Groups data-loss entries by reason so the biggest problem is obvious
   *  instead of buried in a thousand-line list. */
  lossByReason() {
    const out = {};
    for (const d of this.dataLoss) {
      const b = (out[d.reason] ||= { count: 0, severity: d.severity, examples: [] });
      b.count++;
      if (b.examples.length < 5) b.examples.push({ path: d.firebasePath, legacyId: d.legacyId, detail: d.detail });
    }
    return Object.fromEntries(Object.entries(out).sort((a, b) => b[1].count - a[1].count));
  }

  warningsByCode() {
    const out = {};
    for (const w of this.warnings) {
      const b = (out[w.code] ||= { count: 0, examples: [] });
      b.count++;
      if (b.examples.length < 5) b.examples.push({ path: w.firebasePath, legacyId: w.legacyId, detail: w.detail });
    }
    return Object.fromEntries(Object.entries(out).sort((a, b) => b[1].count - a[1].count));
  }

  toJSON() {
    return {
      mode: this.mode,
      startedAt: this.startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      totals: this.totals(),
      perEntity: this.perEntityTotals(),
      perRestaurant: this.restaurants,
      reconciliation: this.reconciliation,
      dataLossSummary: this.lossByReason(),
      warningSummary: this.warningsByCode(),
      dataLoss: this.dataLoss,
      warnings: this.warnings,
      fatal: this.fatal,
      writes: this.writes,
    };
  }

  write(basename) {
    mkdirSync(this.reportDir, { recursive: true });
    const stamp = this.startedAt.toISOString().replace(/[:.]/g, "-");
    const file = path.join(this.reportDir, `${basename}-${stamp}.json`);
    const json = JSON.stringify(this.toJSON(), null, 2);
    writeFileSync(file, json, "utf8");
    writeFileSync(path.join(this.reportDir, `${basename}-latest.json`), json, "utf8");
    return file;
  }

  printSummary(log = console.log) {
    const t = this.totals();
    const line = "-".repeat(78);
    log(`\n${line}`);
    log(`MIGRATION REPORT — mode=${this.mode}`);
    log(line);
    log(`Firebase records seen : ${t.firebaseRecords}`);
    log(`  migrated            : ${t.migrated}`);
    log(`  skipped             : ${t.skipped}`);
    log(`  failed              : ${t.failed}`);
    log(`  duplicate           : ${t.duplicate}`);
    log(`  malformed           : ${t.malformed}`);
    if (t.verified) log(`  verified            : ${t.verified}`);
    if (this.writes.inserted || this.writes.updated) {
      log(`  postgres inserted   : ${this.writes.inserted}`);
      log(`  postgres updated    : ${this.writes.updated}`);
    }

    log(`\nPer entity:`);
    log(`  ${"entity".padEnd(24)} ${"seen".padStart(7)} ${"migrated".padStart(9)} ${"skipped".padStart(8)} ${"failed".padStart(7)} ${"malformed".padStart(10)}`);
    for (const [e, c] of Object.entries(this.perEntityTotals()).sort()) {
      log(`  ${e.padEnd(24)} ${String(c.firebaseRecords).padStart(7)} ${String(c.migrated).padStart(9)} ${String(c.skipped).padStart(8)} ${String(c.failed).padStart(7)} ${String(c.malformed).padStart(10)}`);
    }

    const loss = this.lossByReason();
    log(`\nData-loss risks (${this.dataLoss.length} records):`);
    if (!this.dataLoss.length) {
      log(`  none`);
    } else {
      for (const [reason, b] of Object.entries(loss)) {
        log(`  [${b.severity}] ${reason.padEnd(38)} ${String(b.count).padStart(6)}`);
        for (const ex of b.examples.slice(0, 2)) {
          log(`        e.g. ${ex.path}${ex.detail ? `  (${String(ex.detail).slice(0, 70)})` : ""}`);
        }
      }
    }

    const warns = this.warningsByCode();
    log(`\nWarnings (${this.warnings.length}):`);
    if (!this.warnings.length) log(`  none`);
    else for (const [code, b] of Object.entries(warns)) log(`  ${code.padEnd(40)} ${String(b.count).padStart(6)}`);

    if (this.fatal.length) {
      log(`\nFATAL (${this.fatal.length}):`);
      for (const f of this.fatal) log(`  ${f.scope}: ${f.message}`);
    }
    log(line);
  }
}
