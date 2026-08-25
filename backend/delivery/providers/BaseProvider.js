// delivery/providers/BaseProvider.js — the interface every delivery
// provider adapter implements. Add a new provider (Express24, MyTaxi,
// Custom) by extending this class and registering it in
// providerRegistry.js — no changes to engine.js or business logic needed.
export class BaseProvider {
  /** Unique provider key, matches deliverySettings.provider values (e.g. "internal", "yandex_go"). */
  static key = "base";

  /**
   * Creates/requests a delivery for an order.
   * @param {object} ctx - { restId, orderId, order, settings, restaurantLocation, customerLocation }
   * @returns {Promise<object>} delivery result: { ok, status, courierId?, courierName?,
   *   trackingId?, trackingUrl?, vehicle?, eta?, distance?, reason? }
   */
  async createDelivery(_ctx) {
    throw new Error("createDelivery() not implemented");
  }

  /** Fetches the current status of an existing delivery (used for polling/refresh). */
  async getStatus(_ctx) {
    throw new Error("getStatus() not implemented");
  }

  /** Cancels an in-progress delivery. */
  async cancel(_ctx) {
    throw new Error("cancel() not implemented");
  }

  /** Retries a failed delivery request (default: re-run createDelivery). */
  async retry(ctx) {
    return this.createDelivery(ctx);
  }
}
