import de from "../../admin/i18n/de.json";
import en from "../../admin/i18n/en.json";
import es from "../../admin/i18n/es.json";
import fr from "../../admin/i18n/fr.json";
import it from "../../admin/i18n/it.json";
import nl from "../../admin/i18n/nl.json";
import pl from "../../admin/i18n/pl.json";
import pt from "../../admin/i18n/pt.json";
import ru from "../../admin/i18n/ru.json";
import uk from "../../admin/i18n/uk.json";
import zhCn from "../../admin/i18n/zh-cn.json";

/** A key of `admin/i18n/en.json` — the compile-time guard against a typo in a translated string. */
export type I18nKey = keyof typeof en;

/**
 * The eleven admin languages, loaded from the SAME `admin/i18n` files the configuration page
 * uses — one source, no second table.
 *
 * Deliberately resolved here rather than through adapter-core's `I18n`: that helper reads the
 * files at runtime and throws until `init()` has run, which would make every object name depend
 * on start-up order and would pull the whole adapter runtime into the pure catalog modules (and
 * with it, into their unit tests). The result is identical — ioBroker resolves the object into
 * the reader's language itself.
 */
const LANGUAGES: Record<string, Record<string, string>> = {
  en,
  de,
  ru,
  pt,
  nl,
  fr,
  it,
  es,
  pl,
  uk,
  "zh-cn": zhCn,
};

/**
 * A text in all eleven admin languages.
 *
 * `%s` placeholders are filled in EVERY language (as adapter-core does), so a name with a
 * number or a protocol in it stays translated. A language missing the key falls back to the key
 * itself, which is the English text — so a forgotten translation reads correctly instead of
 * showing a key.
 *
 * @param key the English text, which is also its translation key
 * @param args values substituted into the key's `%s` placeholders, in order
 * @returns the text in all eleven languages
 */
function translated(key: I18nKey, args: (string | number | boolean | null)[]): ioBroker.StringOrTranslated {
  const out: Record<string, string> = {};
  for (const [lang, words] of Object.entries(LANGUAGES)) {
    let text = words[key] ?? key;
    for (const arg of args) {
      text = text.replace("%s", arg === null ? "null" : String(arg));
    }
    out[lang] = text;
  }
  return out as ioBroker.StringOrTranslated;
}

/**
 * A user-facing string for the device-manager titles, dialogs and confirmations, resolved to
 * all admin languages so the card renders in the admin's language.
 *
 * @param key translation key from admin/i18n/en.json
 * @param args values substituted into the key's `%s` placeholders
 * @returns the translated string object
 */
export function t(key: I18nKey, ...args: (string | number | boolean | null)[]): ioBroker.StringOrTranslated {
  return translated(key, args);
}

/**
 * An OBJECT name as a translation object, for `common.name` of a state or channel.
 *
 * ioBroker resolves the object itself in the reader's language (js-controller
 * `StringOrTranslated`), which is why the core team asks for the object rather than a string
 * picked at creation time: a plain string would freeze the tree in one language, and rewriting
 * the names on every start would trample the names a user has changed.
 *
 * @param key the English name, which is also its translation key
 * @param args values substituted into the key's `%s` placeholders
 * @returns the name in all eleven languages
 */
export function tName(key: I18nKey, ...args: (string | number | boolean | null)[]): ioBroker.StringOrTranslated {
  return translated(key, args);
}
