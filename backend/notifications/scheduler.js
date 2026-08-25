// notifications/scheduler.js — the ONE background job loop for the whole
// Notification Center. No cron dependency is installed in this project
// (backend/package.json has none), and this is a small, single-process
// Express server (see backend exploration notes — no serverless/Cloud
// Functions), so a plain `setInterval` tick is the right-sized tool: no new
// dependency, no infra change, easy to reason about.
//
// Responsibilities (spec sections 4/14):
//  - every minute: check each restaurant's report schedule (daily ×N times,
//    weekly, monthly) against the restaurant's configured timezone, and
//    generate+send a report exactly once per configured slot per day
//  - every minute: scan for large orders (cheap, poll-based — see
//    instantScanners.js for why polling instead of a live listener)
//  - every 5 minutes: scan for new reservations / new reviews
//  - every 30 minutes: scan warehouse stock thresholds
//
// All actual work (what to compute, what to say, how to send) lives in
// reportGenerator.js / templates.js / NotificationService.js — this file is
// only the clock.
import { listRestaurantIds, getNotificationSettings, getAlertState, setAlertState, getRestaurantName } from "./common.js";
import {
  dayRange, weekRange, monthRange, previousPeriodRange,
  generateDailyReportData, generateWeeklyReportData, generateMonthlyReportData,
} from "./reportGenerator.js";
import { formatDailyReport, formatWeeklyReport, formatMonthlyReport } from "./templates.js";
import { NotificationService } from "./NotificationService.js";
// Reused so an automatic (scheduled) report message carries the exact same
// inline dashboard buttons as the manual /start menu — one keyboard
// definition, one callback-handling code path, never duplicated/out-of-sync.
import { dashboardKeyboard } from "./TelegramBotService.js";
import { scanWarehouse } from "./warehouseScanner.js";
import { scanLargeOrders, scanNewReservations, scanCancelledReservations, scanNewReviews, scanNewOrders, scanCancelledOrders, scanPaymentsReceived, scanSoldOutFoods, scanKitchenDelays, scanRevenueMilestones } from "./instantScanners.js";

const TICK_MS = 60 * 1000;
let _tickCount = 0;
let _timer = null;

function nowPartsInZone(timeZone) {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone, hour: "2-digit", minute: "2-digit", hour12: false, weekday: "long", day: "2-digit",
    });
    const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
    return {
      hhmm: `${parts.hour}:${parts.minute}`,
      weekday: (parts.weekday || "").toLowerCase(),
      dayOfMonth: Number(parts.day),
    };
  } catch {
    const d = new Date();
    return {
      hhmm: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
      weekday: d.toLocaleDateString("en-US", { weekday: "long" }).toLowerCase(),
      dayOfMonth: d.getDate(),
    };
  }
}

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function sendReportIfDue(restId, settings, slotKey, dateLabel, range, kind) {
  const LOG = `[${kind === "daily" ? "Daily Report" : kind === "weekly" ? "Weekly Report" : "Monthly Report"}]`;
  console.log(`${LOG} due — restId="${restId}" slot="${slotKey}"`);

  const today = new Date().toDateString();
  const dedupeKey = `report_${slotKey}`;
  const prior = await getAlertState(restId, dedupeKey);
  if (prior && prior.day === today) {
    console.log(`${LOG} SKIPPED — already sent for "${today}" (dedupe key "${dedupeKey}").`);
    return;
  }

  const restaurantName = await getRestaurantName(restId);
  const generatedAt = nowHHMM();
  let text, typeForSlot;

  console.log(`${LOG} generating report data for restId="${restId}" range=[${new Date(range.from).toISOString()} .. ${new Date(range.to).toISOString()}]`);

  if (kind === "daily") {
    const data = await generateDailyReportData(restId, range.from, range.to);
    text = formatDailyReport(settings.language, { restaurantName, dateLabel, generatedAt, data });
    typeForSlot = "daily_report";
  } else if (kind === "weekly") {
    const data = await generateWeeklyReportData(restId, range.from, range.to);
    text = formatWeeklyReport(settings.language, { restaurantName, dateLabel, generatedAt, data });
    typeForSlot = "weekly_report";
  } else {
    const { from: prevFrom, to: prevTo } = previousPeriodRange(range.from, range.to);
    const data = await generateMonthlyReportData(restId, range.from, range.to, prevFrom, prevTo);
    text = formatMonthlyReport(settings.language, { restaurantName, dateLabel, generatedAt, data });
    typeForSlot = "monthly_report";
  }

  console.log(`${LOG} report generated (${text.length} chars) — calling NotificationService.send("${typeForSlot}", "${restId}", ...)`);
  // Attach the same live-dashboard inline buttons the manual /start menu
  // shows, so tapping a button on an automatic report routes through the
  // identical, already-tested callback handling (spec: "Admin shu reportni
  // olgach darhol boshqa detailga o'ta olsin").
  const replyMarkup = { inline_keyboard: dashboardKeyboard(settings.language) };
  const result = await NotificationService.send(typeForSlot, restId, null, {}, { text, replyMarkup });

  if (!result.ok) {
    // IMPORTANT: dedupe state is only marked "sent" on real success. Marking
    // it on every attempt (the previous behavior) permanently swallowed a
    // failed report for the rest of the day, since this exact time slot only
    // matches once per day and there is no separate retry loop.
    console.error(`${LOG} ❌ FAILED — NotificationService.send() returned ok:false, reason="${result.reason}". Dedupe state NOT set — see [NotificationService] log above for exactly which gate stopped it.`);
    return;
  }

  console.log(`${LOG} ✅ SENT successfully.`);
  await setAlertState(restId, dedupeKey, { day: today });
}

async function tickRestaurant(restId) {
  console.log(`[Scheduler] Processing ${restId}`);

  // Always a live Firebase read, never cached — this is what makes a time/
  // toggle change made in Admin Settings take effect on the very next tick
  // (≤60s later) with NO server restart required.
  const settings = await getNotificationSettings(restId);
  console.log(`[Scheduler] Settings loaded — restId="${restId}" ->`, JSON.stringify({
    enabled: settings.enabled,
    telegramEnabled: settings.telegram?.enabled,
    schedule: settings.schedule,
    language: settings.language,
  }));

  console.log(`[Scheduler] Notifications enabled — restId="${restId}" -> ${settings.enabled}`);
  if (!settings.enabled) {
    console.log(`[Scheduler] Restaurant "${restId}" SKIPPED — notificationSettings.enabled is false.`);
    console.log(`[Scheduler] Done — restId="${restId}"`);
    return;
  }

  const { hhmm, weekday, dayOfMonth } = nowPartsInZone(settings.schedule.timezone);
  console.log(`[Scheduler] Current time — restId="${restId}" -> ${hhmm} (${weekday}, day ${dayOfMonth} of month) [tz=${settings.schedule.timezone}]`);
  const dateLabel = new Date().toLocaleDateString(settings.language === "en" ? "en-US" : settings.language === "ru" ? "ru-RU" : "uz-UZ");

  // ── Daily ──────────────────────────────────────────────────────────────
  const dailyEnabled = !!settings.schedule.daily?.enabled;
  const dailyTimes = settings.schedule.daily?.times || [];
  console.log(`[Scheduler] Daily enabled — restId="${restId}" -> ${dailyEnabled} (configured times=[${dailyTimes.join(", ")}])`);
  if (dailyEnabled) {
    const dailyDue = dailyTimes.includes(hhmm);
    console.log(`[Scheduler] Should send report? (daily) — restId="${restId}" -> ${dailyDue} (now=${hhmm}, configured=[${dailyTimes.join(", ")}])`);
    if (dailyDue) {
      console.log(`[Scheduler] Sending Daily Report — restId="${restId}"`);
      await sendReportIfDue(restId, settings, `daily_${hhmm}`, dateLabel, dayRange(), "daily").catch((err) => console.error("[Scheduler] daily report error:", err.message));
    }
  }

  // ── Weekly ─────────────────────────────────────────────────────────────
  const weeklyEnabled = !!settings.schedule.weekly?.enabled;
  console.log(`[Scheduler] Weekly enabled — restId="${restId}" -> ${weeklyEnabled} (configured day="${settings.schedule.weekly?.day}" time="${settings.schedule.weekly?.time}")`);
  if (weeklyEnabled) {
    const weeklyDue = settings.schedule.weekly.day === weekday && settings.schedule.weekly.time === hhmm;
    console.log(`[Scheduler] Should send report? (weekly) — restId="${restId}" -> ${weeklyDue} (now="${weekday} ${hhmm}", configured="${settings.schedule.weekly.day} ${settings.schedule.weekly.time}")`);
    if (weeklyDue) {
      console.log(`[Scheduler] Sending Weekly Report — restId="${restId}"`);
      await sendReportIfDue(restId, settings, "weekly", dateLabel, weekRange(), "weekly").catch((err) => console.error("[Scheduler] weekly report error:", err.message));
    }
  }

  // ── Monthly ────────────────────────────────────────────────────────────
  const monthlyEnabled = !!settings.schedule.monthly?.enabled;
  console.log(`[Scheduler] Monthly enabled — restId="${restId}" -> ${monthlyEnabled} (configured day=${settings.schedule.monthly?.day} time="${settings.schedule.monthly?.time}")`);
  if (monthlyEnabled) {
    const monthlyDue = Number(settings.schedule.monthly.day) === dayOfMonth && settings.schedule.monthly.time === hhmm;
    console.log(`[Scheduler] Should send report? (monthly) — restId="${restId}" -> ${monthlyDue} (now=day ${dayOfMonth} ${hhmm}, configured=day ${settings.schedule.monthly.day} ${settings.schedule.monthly.time})`);
    if (monthlyDue) {
      console.log(`[Scheduler] Sending Monthly Report — restId="${restId}"`);
      await sendReportIfDue(restId, settings, "monthly", dateLabel, monthRange(), "monthly").catch((err) => console.error("[Scheduler] monthly report error:", err.message));
    }
  }

  // Instant, poll-based scans — see instantScanners.js for why polling.
  scanLargeOrders(restId).catch((err) => console.error("large-order scan error:", err.message));
  scanNewOrders(restId).catch((err) => console.error("new-order scan error:", err.message));
  scanCancelledOrders(restId).catch((err) => console.error("cancelled-order scan error:", err.message));
  scanCancelledReservations(restId).catch((err) => console.error("cancelled-reservation scan error:", err.message));
  scanPaymentsReceived(restId).catch((err) => console.error("payment-received scan error:", err.message));
  scanKitchenDelays(restId).catch((err) => console.error("kitchen-delay scan error:", err.message));
  scanRevenueMilestones(restId).catch((err) => console.error("revenue-milestone scan error:", err.message));

  if (_tickCount % 5 === 0) {
    scanNewReservations(restId).catch((err) => console.error("reservation scan error:", err.message));
    scanNewReviews(restId).catch((err) => console.error("review scan error:", err.message));
    scanSoldOutFoods(restId).catch((err) => console.error("sold-out scan error:", err.message));
  }
  if (_tickCount % 30 === 0) {
    scanWarehouse(restId).catch((err) => console.error("warehouse scan error:", err.message));
  }

  console.log(`[Scheduler] Done — restId="${restId}"`);
}

async function tick() {
  _tickCount += 1;
  try {
    const restIds = await listRestaurantIds();
    console.log(`[Scheduler] tick #${_tickCount} — ${restIds.length} restaurant(s): [${restIds.join(", ")}]`);
    await Promise.all(restIds.map((id) => tickRestaurant(id).catch((err) => console.error(`[Scheduler] tick error [${id}]:`, err.message))));
  } catch (err) {
    console.error("[Scheduler] tick error:", err.message);
  }
}

export function startScheduler() {
  if (_timer) return; // idempotent — safe to call once from server.js
  console.log("🔔 Notification scheduler started (1-minute tick).");
  // setInterval alone only fires the first tick 60s after boot — that's a
  // needless blind spot right after a restart (e.g. right after saving new
  // notification settings and restarting to verify them). Run one tick
  // immediately, then continue on the normal 1-minute interval.
  tick().catch((err) => console.error("[Scheduler] initial tick error:", err.message));
  _timer = setInterval(tick, TICK_MS);
}

export function stopScheduler() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}
