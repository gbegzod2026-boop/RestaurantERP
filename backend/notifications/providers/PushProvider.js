// notifications/providers/PushProvider.js — future channel (Web/Mobile Push).
// STUB: no push infrastructure (FCM/APNs) exists in this codebase yet. This
// file exists so the architecture is complete today — wiring a real push
// provider later is a self-contained change to this one file plus flipping
// `settings.push.enabled` in Settings → Notifications; NotificationService,
// the scheduler, and every business module stay untouched.
import { BaseProvider } from "./BaseProvider.js";

export class PushProvider extends BaseProvider {
  static key = "push";

  async send(_ctx) {
    return { ok: false, reason: "not_implemented" };
  }

  async testConnection(_ctx) {
    return { ok: false, reason: "not_implemented" };
  }
}
