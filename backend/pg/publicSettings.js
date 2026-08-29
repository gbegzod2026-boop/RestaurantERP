// Explicit customer/public restaurant configuration projection.
// Allowlist only — secrets and staff/integration fields are never copied.

function pickBoolMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "boolean") out[key] = item;
  }
  return out;
}

function publicDelivery(settings) {
  const ds = settings.deliverySettings && typeof settings.deliverySettings === "object"
    ? settings.deliverySettings
    : {};
  return {
    enabled: ds.enabled === true || settings.deliveryEnabled === true,
    fee: ds.publicFee ?? settings.publicDeliveryFee ?? ds.fee ?? settings.deliveryFee ?? null,
    minOrder: ds.minOrder ?? settings.minOrder ?? settings.minimumOrder ?? null,
    estimatedMinutes: ds.estimatedMinutes ?? ds.etaMinutes ?? null,
  };
}

export function projectPublicSettings(settings, restaurant = null) {
  const s = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  const branding = s.branding && typeof s.branding === "object" ? s.branding : {};
  return {
    name: restaurant?.name || s.restaurantName || s.publicName || s.name || null,
    address: s.publicAddress || s.address || null,
    phone: s.publicPhone || s.phone || null,
    serviceTypes: Array.isArray(s.serviceTypes) ? s.serviceTypes : (Array.isArray(s.orderTypes) ? s.orderTypes : null),
    openingHours: s.openingHours || s.workingHours || s.hours || null,
    minOrder: s.minOrder ?? s.minimumOrder ?? null,
    currency: s.currency || null,
    locale: s.locale || s.language || null,
    branding: {
      logo: branding.logo || s.logo || null,
      primaryColor: branding.primaryColor || s.primaryColor || null,
    },
    delivery: publicDelivery(s),
    features: pickBoolMap(s.features || s.publicFeatures),
  };
}

export function publicSettingsValue(settings, restaurant, pathParts = []) {
  let current = projectPublicSettings(settings, restaurant);
  for (const part of pathParts) {
    if (current == null || typeof current !== "object") return null;
    current = current[part];
  }
  return current ?? null;
}
