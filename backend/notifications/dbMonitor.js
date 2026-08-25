// notifications/dbMonitor.js — real Firebase connectivity monitoring using
// the RTDB SDK's own `.info/connected` special path (not a custom heuristic
// or a fabricated check). This is the same mechanism Firebase's own docs
// recommend for presence/connectivity detection.
//
// Honest limitation, stated up front: while the connection is actually down,
// this backend cannot reach Firebase at all — so it cannot read
// notificationSettings or send anything through NotificationService during
// the outage itself. What IS real and useful: detecting the *recovery* (back
// online after N seconds down) and notifying every known restaurant once
// reconnected. The "went offline" moment is logged server-side only.
import { ref, onValue } from "firebase/database";
import { getDB } from "../db.js";
import { listRestaurantIds } from "./common.js";
import { NotificationService } from "./NotificationService.js";
import { NOTIFICATION_TYPES } from "./types.js";

let _wentOfflineAt = null;
let _started = false;

export function startDbMonitor() {
  if (_started) return; // idempotent, safe to call once from server.js
  _started = true;

  const connectedRef = ref(getDB(), ".info/connected");
  onValue(connectedRef, (snap) => {
    const isConnected = snap.val() === true;

    if (!isConnected) {
      _wentOfflineAt = Date.now();
      console.error("[dbMonitor] 🔴 Firebase connection lost.");
      return;
    }

    if (_wentOfflineAt) {
      const offlineForSec = Math.round((Date.now() - _wentOfflineAt) / 1000);
      console.log(`[dbMonitor] 🟢 Firebase reconnected after ${offlineForSec}s.`);
      _wentOfflineAt = null;

      // Only worth notifying about outages long enough to matter — a 1-2s
      // blip on every cold start would otherwise fire a notification on
      // every server boot.
      if (offlineForSec >= 30) {
        listRestaurantIds()
          .then((restIds) =>
            Promise.all(
              restIds.map((restId) =>
                NotificationService.send(NOTIFICATION_TYPES.DATABASE_OFFLINE, restId, null, { recovered: true, offlineForSec }).catch(() => {})
              )
            )
          )
          .catch((err) => console.error("[dbMonitor] failed to notify restaurants of recovery:", err.message));
      }
    }
  });

  console.log("🔌 Database connectivity monitor started (.info/connected).");
}
