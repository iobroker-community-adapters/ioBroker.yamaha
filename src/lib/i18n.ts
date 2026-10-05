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
 * number or a protocol in it stays translated. A language missing the key falls back to the
 * ENGLISH text, never to the key: the keys are identifiers (fleet standard, gate
 * `audit_i18n_keys`), so falling back to the key would put `adaptiveDRC` in front of the
 * user. Before 2026-09-03 the keys WERE the English text and `?? key` happened to read
 * correctly — that is exactly the coincidence that hid the deviation.
 *
 * @param key the translation key (an identifier in `admin/i18n/en.json`)
 * @param args values substituted into the key's `%s` placeholders, in order
 * @returns the text in all eleven languages
 */
function translated(key: I18nKey, args: (string | number | boolean | null)[]): ioBroker.StringOrTranslated {
  const out: Record<string, string> = {};
  for (const [lang, words] of Object.entries(LANGUAGES)) {
    let text = words[key] ?? en[key] ?? key;
    for (const arg of args) {
      // A function, not a string: `$&` or `$$` in a device name is the name, not a replacement pattern
      // (review 2026-10-05, A37).
      const filled = arg === null ? "null" : String(arg);
      text = text.replace("%s", () => filled);
    }
    out[lang] = text;
  }
  return out as ioBroker.StringOrTranslated;
}

/**
 * A text as a translation object — an OBJECT name or explanation (`common.name`/`desc`) and every
 * device-manager title, dialog and confirmation alike (one export since 2026-09-29; `t` was the same
 * function under a second name, D20).
 *
 * ioBroker resolves the object itself in the reader's language (js-controller
 * `StringOrTranslated`), which is why the core team asks for the object rather than a string
 * picked at creation time: a plain string would freeze the tree in one language, and rewriting
 * the names on every start would trample the names a user has changed.
 *
 * @param key the translation key in `admin/i18n/en.json`
 * @param args values substituted into the key's `%s` placeholders
 * @returns the name in all eleven languages
 */
export function tName(key: I18nKey, ...args: (string | number | boolean | null)[]): ioBroker.StringOrTranslated {
  return translated(key, args);
}

/**
 * A text in ONE language — a value label (`common.states`), which the admin shows as it stands: a label is a
 * plain string in the system language (a translation object there crashes the object browser), resolved once
 * when the object is written. An unknown language reads English.
 *
 * @param language the system language (`system.config.language`)
 * @param key the translation key in `admin/i18n/en.json`
 * @param args values substituted into the key's `%s` placeholders
 * @returns the text in that language
 */
export function tIn(language: string, key: I18nKey, ...args: (string | number | boolean | null)[]): string {
  const all = translated(key, args) as Record<string, string>;
  return all[language] ?? all.en;
}
