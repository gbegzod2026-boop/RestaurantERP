// notifications/providers/WhatsAppProvider.js — future channel (WhatsApp Business API).
// STUB — see PushProvider.js for the extension-point rationale.
import { BaseProvider } from "./BaseProvider.js";

export class WhatsAppProvider extends BaseProvider {
  static key = "whatsapp";

  async send(_ctx) {
    return { ok: false, reason: "not_implemented" };
  }

  async testConnection(_ctx) {
    return { ok: false, reason: "not_implemented" };
  }
}
