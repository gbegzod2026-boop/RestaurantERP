// notifications/providers/SmsProvider.js — future channel (Eskiz/Playmobile/Twilio/etc).
// STUB — see PushProvider.js for the extension-point rationale.
import { BaseProvider } from "./BaseProvider.js";

export class SmsProvider extends BaseProvider {
  static key = "sms";

  async send(_ctx) {
    return { ok: false, reason: "not_implemented" };
  }

  async testConnection(_ctx) {
    return { ok: false, reason: "not_implemented" };
  }
}
