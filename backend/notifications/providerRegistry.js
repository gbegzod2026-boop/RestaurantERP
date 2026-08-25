// notifications/providerRegistry.js — channel key → provider instance.
// Mirrors delivery/providerRegistry.js exactly. Adding a real Push/Email/
// SMS/WhatsApp integration later is: implement the provider, done — this
// registry and NotificationService never need to change.
import { TelegramProvider } from "./providers/TelegramProvider.js";
import { PushProvider } from "./providers/PushProvider.js";
import { EmailProvider } from "./providers/EmailProvider.js";
import { SmsProvider } from "./providers/SmsProvider.js";
import { WhatsAppProvider } from "./providers/WhatsAppProvider.js";

export const PROVIDER_REGISTRY = {
  telegram: new TelegramProvider(),
  push: new PushProvider(),
  email: new EmailProvider(),
  sms: new SmsProvider(),
  whatsapp: new WhatsAppProvider(),
};

export function getProvider(key) {
  return PROVIDER_REGISTRY[key] || null;
}

export function getAllProviderKeys() {
  return Object.keys(PROVIDER_REGISTRY);
}
