import { tName } from "../i18n";
import { qualifiedName } from "./qualified-name";
import { CHANNEL_NAME_KEYS } from "./types";

const en = (name: ioBroker.StringOrTranslated): string => (name as Record<string, string>).en;

// Rule D19 of the fleet (krobi 2026-10-29): the name main.ts writes tells a datapoint apart from its namesakes on the
// same device — the zone or the source goes in front, the id stays.
describe("the name a datapoint is written with", () => {
  test("a source's preset names its source, on every source", () => {
    const source = en(tName(CHANNEL_NAME_KEYS.netRadio));
    expect(en(qualifiedName("player.netRadio.preset", tName("recallPreset")))).toBe(`${source}: Recall preset`);
    expect(en(qualifiedName("player.netRadio.presetSave", tName("recallPreset")))).toBe(`${source}: Recall preset`);
    expect(en(qualifiedName("player.usb.preset", tName("recallPreset")))).not.toBe(
      en(qualifiedName("player.netRadio.preset", tName("recallPreset"))),
    );
  });

  test("a zone's datapoint names its zone; the main zone, a tuner preset and another source's datapoint keep theirs", () => {
    expect(en(qualifiedName("multiroom.zone2.mute", tName("mute")))).toBe("Zone 2 Mute");
    expect(en(qualifiedName("multiroom.zoneB.mute", tName("mute")))).toBe("Zone B Mute");
    expect(en(qualifiedName("mute", tName("mute")))).toBe("Mute");
    expect(en(qualifiedName("tuner.preset", tName("recallPreset")))).toBe("Recall preset");
    expect(en(qualifiedName("player.netRadio.song", tName("mute")))).toBe("Mute");
  });

  test("an unknown source keeps the name it was built with", () => {
    expect(en(qualifiedName("player.somethingNew.preset", tName("recallPreset")))).toBe("Recall preset");
  });
});
