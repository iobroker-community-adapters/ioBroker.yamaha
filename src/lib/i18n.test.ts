import { t, tName } from "./i18n";
import en from "../../admin/i18n/en.json";
import de from "../../admin/i18n/de.json";

describe("i18n — the eleven admin languages from the admin's own files", () => {
  test("a translated string carries every admin language, each from its own file", () => {
    const text = t("volumeAsPercent") as Record<string, string>;
    expect(Object.keys(text).sort()).toEqual(["de", "en", "es", "fr", "it", "nl", "pl", "pt", "ru", "uk", "zh-cn"]);
    expect(text.en).toBe(en.volumeAsPercent);
    expect(text.de).toBe(de.volumeAsPercent);
  });

  test("fills %s placeholders in EVERY language, so a name with a number stays translated", () => {
    const withArgs = Object.entries(en).find(([, value]) => value.includes("%s"));
    expect(withArgs).toBeDefined();
    const [key] = withArgs as [keyof typeof en, string];
    const text = tName(key, 3) as Record<string, string>;
    for (const [lang, value] of Object.entries(text)) {
      expect(value, lang).not.toContain("%s");
      expect(value, lang).toContain("3");
    }
    // null is spelled out, never dropped into "undefined".
    const nulled = tName(key, null) as Record<string, string>;
    expect(nulled.en).toContain("null");
  });

  test("a language that lacks a key falls back to the ENGLISH text, never to the key", () => {
    // The keys are identifiers (fleet standard); a fallback to the key would put
    // "soundAdaptiveDrc" in front of the user. Proven on a key removed from one language.
    const key = "volumeAsPercent" as const;
    const original = (de as Record<string, string>)[key];
    delete (de as Record<string, string>)[key];
    try {
      const text = t(key) as Record<string, string>;
      expect(text.de).toBe(en[key]);
      expect(text.de).not.toBe(key);
    } finally {
      (de as Record<string, string>)[key] = original;
    }
  });
});
