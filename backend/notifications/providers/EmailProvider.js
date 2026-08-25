// notifications/providers/EmailProvider.js — future channel (SMTP/SendGrid/etc).
// STUB — see PushProvider.js for the extension-point rationale.
import { BaseProvider } from "./BaseProvider.js";

export class EmailProvider extends BaseProvider {
  static key = "email";

  async send(_ctx) {
    return { ok: false, reason: "not_implemented" };
  }

  async testConnection(_ctx) {
    return { ok: false, reason: "not_implemented" };
  }
}
