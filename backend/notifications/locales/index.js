// notifications/locales/index.js — the ONE centralized localization service
// for the Telegram Notification Center. Every piece of Telegram-facing text
// (templates.js, TelegramBotService.js) goes through getTranslator() —
// there is no other place in this module that decides what a string says
// in which language, and no scattered `if (lang === "ru") ...` branches.
import uz from "./uz.js";
import ru from "./ru.js";
import en from "./en.js";

const DICTS = { uz, ru, en };
const DEFAULT_LANG = "uz";

/**
 * getTranslator(language) -> t(key, vars?)
 *
 * - Unknown/missing language falls back to "uz" (matches getNotificationSettings'
 *   own default in notifications/common.js).
 * - Unknown key falls back to the "uz" dictionary's value for that key, and
 *   finally to the raw key itself — a message can never come out blank.
 * - `vars` does simple {{placeholder}} interpolation, e.g.
 *     t("notif_x", { name: "Ali" })  with dict entry "Hello {{name}}"
 *   Optional — most keys here are plain strings with no placeholders.
 */
export function getTranslator(language) {
  const dict = DICTS[language] || DICTS[DEFAULT_LANG];

  return function t(key, vars) {
    let value = Object.prototype.hasOwnProperty.call(dict, key)
      ? dict[key]
      : (DICTS[DEFAULT_LANG][key] ?? key);

    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        value = value.replaceAll(`{{${k}}}`, v);
      }
    }
    return value;
  };
}

export const SUPPORTED_LANGUAGES = Object.keys(DICTS);
export default getTranslator;
