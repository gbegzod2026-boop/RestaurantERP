// delivery/providerRegistry.js — maps deliverySettings.provider values to
// their adapter class. This is the single place to touch when adding a new
// delivery provider (Express24, MyTaxi, a custom in-house API, ...):
//
//   1. Create backend/delivery/providers/Express24Provider.js extending BaseProvider.
//   2. Import it below and add one line: express24: Express24Provider.
//   3. Add "express24" as an option in the admin Delivery Settings provider <select>.
//
// No changes to engine.js or any route are needed — the engine only ever
// talks to providers through the BaseProvider interface.
import { InternalCourierProvider } from "./providers/InternalCourierProvider.js";
import { YandexGoProvider } from "./providers/YandexGoProvider.js";

export const PROVIDER_REGISTRY = {
  internal: InternalCourierProvider,
  yandex_go: YandexGoProvider,
};

export function getProvider(key) {
  const ProviderClass = PROVIDER_REGISTRY[key];
  return ProviderClass ? new ProviderClass() : null;
}
