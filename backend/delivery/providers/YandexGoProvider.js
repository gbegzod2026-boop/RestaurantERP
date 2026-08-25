// delivery/providers/YandexGoProvider.js — Yandex Go Courier API adapter.
//
// ⚠️ MOCKED: there is no live Yandex Go API key/contract available yet, so
// _callYandexApi() below is a stub that fabricates a plausible response
// instead of calling https://... . The request/response shapes are modeled
// on Yandex's public Delivery/Courier API docs so that swapping the mock
// for a real fetch() later is a small, isolated change — nothing else in
// the Delivery Engine, routes, or frontend needs to change.
//
// TODO(real integration): replace _callYandexApi() with a real fetch() to
// the Yandex Go Delivery API once an API key + environment are configured
// in deliverySettings.yandexGo (apiKey, clientId, environment).
import { DELIVERY_STATUS } from "../common.js";
import { BaseProvider } from "./BaseProvider.js";

// Mocked call — shape mirrors a real Yandex Go "create delivery" request/response:
//   REQUEST:  POST /api/v1/delivery { route: [{point, type:"source"}, {point, type:"destination"}], items, ... }
//   RESPONSE: { id, status, eta_minutes, tracking_url, performer: {name, phone}, vehicle: {model, plate_number} }
//
// P1-6 fix (PRODUCTION-AUDIT.md): this used to return a FAKE ok:true
// "assigned" result — complete with a fabricated tracking id, a
// non-existent "courier" (performer.name literally "Yandex Go", a
// placeholder phone number, a tracking URL that resolves nowhere real) —
// whenever settings.yandexGo.apiKey was merely present, with zero
// verification that key is real or that any actual dispatch happened. A
// restaurant that configured ANY apiKey value (or a customer/admin viewing
// the resulting order) would see a fully "successful" delivery assignment
// for a courier who was never actually dispatched — the order flow's
// delivery status would be lying. Per this fix's explicit scope (no real
// Yandex Go integration is authorized to be built here, and no credential
// is created), the only safe correction is to never report a successful
// assignment at all, regardless of whether an apiKey is configured —
// there is no way to verify a configured key is genuinely a working
// integration without actually calling Yandex's API, which does not exist
// yet (see the TODO above). This makes the mock behave identically to
// "not implemented" in every case, so no order can ever show a fake
// successful Yandex Go dispatch — see delivery/engine.js's assign(): a
// failed provider result already falls back to WAITING_FOR_COURIER
// (Automatic mode) or leaves the order visibly unassigned (explicit Yandex
// Go mode) — both are honest, pre-existing, unchanged behaviors.
async function _callYandexApi({ settings, order, restaurantLocation, customerLocation, distanceKm }) {
  if (!settings?.yandexGo?.apiKey) {
    return { ok: false, reason: "missing_api_key" };
  }
  return { ok: false, reason: "not_implemented" };
}

export class YandexGoProvider extends BaseProvider {
  static key = "yandex_go";

  async createDelivery(ctx) {
    const { order, settings, restaurantLocation, customerLocation } = ctx;

    const resp = await _callYandexApi({
      settings,
      order,
      restaurantLocation,
      customerLocation,
      distanceKm: ctx.distanceKm ?? null,
    });

    if (!resp.ok) {
      return { ok: false, status: DELIVERY_STATUS.WAITING_FOR_COURIER, reason: resp.reason || "yandex_request_failed" };
    }

    return {
      ok: true,
      status: DELIVERY_STATUS.ASSIGNED,
      trackingId: resp.id,
      trackingUrl: resp.tracking_url,
      courierName: resp.performer?.name || "Yandex Go",
      courierPhone: resp.performer?.phone || "",
      vehicle: { type: resp.vehicle?.model || "", plate: resp.vehicle?.plate_number || "" },
      eta: resp.eta_minutes,
    };
  }

  async getStatus(ctx) {
    // MOCK: no live status polling endpoint wired up yet — assume unchanged.
    return { ok: true, status: ctx.currentStatus || DELIVERY_STATUS.ASSIGNED };
  }

  async cancel(_ctx) {
    // MOCK: a real integration would POST /api/v1/delivery/{id}/cancel.
    return { ok: true, status: DELIVERY_STATUS.CANCELLED };
  }
}
