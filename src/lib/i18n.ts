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

/** A value for a `%s` placeholder. */
type Arg = string | number | boolean | null;

/**
 * One language's text of a key. A language missing the key falls back to the ENGLISH text,
 * never to the key: the keys are identifiers (fleet standard, gate `audit_i18n_keys`), so
 * falling back to the key would put `adaptiveDRC` in front of the user. Before 2026-09-03 the
 * keys WERE the English text and `?? key` happened to read correctly — that is exactly the
 * coincidence that hid the deviation. A language the admin does not ship reads English.
 *
 * @param language the language (`de`, `zh-cn`, …)
 * @param key the translation key (an identifier in `admin/i18n/en.json`)
 * @returns the text, its placeholders still open
 */
function textOf(language: string, key: I18nKey): string {
  // Own keys only: an inherited name (`constructor`) is no language.
  const words = Object.hasOwn(LANGUAGES, language) ? LANGUAGES[language] : en;
  return words[key] ?? en[key] ?? key;
}

/**
 * Fill a text's `%s` placeholders with the arguments, in order, in ONE pass over the text: an
 * argument goes in as written — a `$&` or `$$` in a device name is the name, not a replacement
 * pattern, and a `%s` in it is no placeholder of the next argument (review 2026-10-05, A37).
 * `null` is spelled out; a placeholder without an argument stays.
 *
 * @param text the text with its placeholders
 * @param args the values, in order
 * @returns the filled text
 */
function fill(text: string, args: readonly Arg[]): string {
  let next = 0;
  return text.replace(/%s/g, placeholder => {
    if (next >= args.length) {
      return placeholder;
    }
    const arg = args[next++];
    return arg === null ? "null" : String(arg);
  });
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
 * `%s` placeholders are filled in EVERY language (as adapter-core does), so a name with a
 * number or a protocol in it stays translated.
 *
 * @param key the translation key in `admin/i18n/en.json`
 * @param args values substituted into the key's `%s` placeholders
 * @returns the name in all eleven languages
 */
export function tName(key: I18nKey, ...args: Arg[]): ioBroker.StringOrTranslated {
  return Object.fromEntries(
    Object.keys(LANGUAGES).map(language => [language, fill(textOf(language, key), args)]),
  ) as ioBroker.StringOrTranslated;
}

/**
 * A text in ONE language — a value label (`common.states`), which the admin shows as it stands: a label is a
 * plain string in the system language (a translation object there crashes the object browser), resolved once
 * when the object is written. An unknown language reads English. Looked up directly — it built all eleven
 * languages to return one (review 2026-10-05, F).
 *
 * @param language the system language (`system.config.language`)
 * @param key the translation key in `admin/i18n/en.json`
 * @param args values substituted into the key's `%s` placeholders
 * @returns the text in that language
 */
export function tIn(language: string, key: I18nKey, ...args: Arg[]): string {
  return fill(textOf(language, key), args);
}
