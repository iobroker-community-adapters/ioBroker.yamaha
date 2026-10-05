import { tIn, tName } from "./i18n";
import en from "../../admin/i18n/en.json";
import de from "../../admin/i18n/de.json";

describe("i18n — the eleven admin languages from the admin's own files", () => {
  test("a translated string carries every admin language, each from its own file", () => {
    const text = tName("volumeAsPercent") as Record<string, string>;
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
    // "adaptiveDRC" in front of the user. Proven on a key removed from one language.
    const key = "volumeAsPercent" as const;
    const original = (de as Record<string, string>)[key];
    delete (de as Record<string, string>)[key];
    try {
      const text = tName(key) as Record<string, string>;
      expect(text.de).toBe(en[key]);
      expect(text.de).not.toBe(key);
    } finally {
      (de as Record<string, string>)[key] = original;
    }
  });
});

describe("i18n placeholders take a device name literally (review 2026-10-05, A37)", () => {
  it("keeps $& and $$ in an argument as written", () => {
    const name = tName("dmDeleteConfirm", "Kino $& Bar $$") as Record<string, string>;
    expect(name.en).toContain("Kino $& Bar $$");
    expect(name.de).toContain("Kino $& Bar $$");
    expect(tIn("en", "labelZoneNumber", "$$")).toBe("Zone $$");
  });

  it("does not read a %s inside an argument as the next placeholder", () => {
    // "Trigger output %s on %s": the first argument's own "%s" swallowed the second argument.
    expect(tIn("en", "triggerOutForInput", "%s", "HDMI1")).toBe("Trigger output %s on HDMI1");
    expect((tName("triggerOutForInput", "%s", "HDMI1") as Record<string, string>).en).toBe(
      "Trigger output %s on HDMI1",
    );
  });

  it("leaves a placeholder without an argument, and ignores an argument without a placeholder", () => {
    expect(tIn("en", "triggerOutForInput", "1")).toBe("Trigger output 1 on %s");
    expect(tIn("en", "labelZoneNumber", 2, 3)).toBe("Zone 2");
  });
});

describe("tIn — one language, looked up directly (review 2026-10-05, F)", () => {
  it("reads the language's own text, the same as the translation object carries", () => {
    for (const language of ["en", "de", "zh-cn"]) {
      expect(tIn(language, "labelZoneNumber", 2)).toBe(
        (tName("labelZoneNumber", 2) as Record<string, string>)[language],
      );
    }
    expect(tIn("de", "labelZoneNumber", 2)).toBe(de.labelZoneNumber.replace("%s", "2"));
  });

  it("reads English for a language the admin does not ship, an inherited property name included", () => {
    expect(tIn("xx", "labelZoneNumber", 2)).toBe("Zone 2");
    expect(tIn("constructor", "labelZoneNumber", 2)).toBe("Zone 2");
    expect(tIn("__proto__", "labelZoneNumber", 2)).toBe("Zone 2");
  });
});
