import test from "node:test";
import assert from "node:assert/strict";
import { projectPublicSettings, publicSettingsValue } from "../../pg/publicSettings.js";

test("public settings DTO never serializes internal secrets", () => {
  const raw = {
    name: "Cafe",
    publicAddress: "1 Main",
    currency: "UZS",
    features: { qr_menu: true, kitchen: true },
    deliverySettings: {
      enabled: true,
      fee: 5000,
      yandexGo: { apiKey: "secret-yandex-key", clientId: "yandex-client" },
    },
    telegramBotToken: "123:ABC",
    smtp: { password: "smtp-secret" },
    payment: { clickSecret: "click-secret" },
    printerConfig: { ip: "10.0.0.8" },
  };
  const dto = projectPublicSettings(raw, { name: "Cafe" });
  const serialized = JSON.stringify(dto);
  assert.equal(serialized.includes("secret-yandex-key"), false);
  assert.equal(serialized.includes("yandex-client"), false);
  assert.equal(serialized.includes("123:ABC"), false);
  assert.equal(serialized.includes("smtp-secret"), false);
  assert.equal(serialized.includes("click-secret"), false);
  assert.equal(serialized.includes("10.0.0.8"), false);
  assert.equal(dto.name, "Cafe");
  assert.equal(dto.delivery.enabled, true);
  assert.equal(publicSettingsValue(raw, { name: "Cafe" }, ["deliverySettings", "yandexGo", "apiKey"]), null);
});
