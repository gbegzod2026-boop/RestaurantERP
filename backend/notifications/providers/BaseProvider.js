// notifications/providers/BaseProvider.js — the interface every channel
// adapter implements. Mirrors delivery/providers/BaseProvider.js exactly,
// so the two provider-adapter systems in this codebase (delivery, and now
// notifications) read as one consistent pattern.
//
// A provider never talks to a business module directly — NotificationService
// is the only caller. Adding a real channel later (Push/Email/SMS/WhatsApp)
// means: implement send() here, register it in providerRegistry.js — nothing
// else in the system changes.
export class BaseProvider {
  /**
   * @param {object} ctx - { restId, settings, type, text, payload }
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async send(_ctx) {
    throw new Error("send() not implemented");
  }

  /** Optional: verify the channel is reachable/configured (used by "Test Connection" in Settings). */
  async testConnection(_ctx) {
    return { ok: false, reason: "not_implemented" };
  }
}
