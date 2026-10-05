import { STATE_LABELS, withValueLabels } from "./state-labels";
import type { ObjectDef } from "./types";
import { specToCommon } from "./value-coerce";
import en from "../../../admin/i18n/en.json";
import { YNCA_CATALOG } from "../ynca/catalog";
import { XML_AMP_CATALOG } from "../xml/catalog";
import { YXC_AMP_CATALOG } from "../yxc/catalog";
import { YXC_SYSTEM_CATALOG } from "../yxc/system-catalog";

const list = (id: string, states: Record<string, string>): ObjectDef => ({
  id,
  type: "state",
  common: { name: "x", type: "string", role: "state", read: true, write: true, states },
});

describe("withValueLabels (readable values, 2026-09-30)", () => {
  test("the adapter's words replace a label that only repeated its key, in the system language", () => {
    const def = list("muteLevel", { Off: "Off", On: "On", "Att -20 dB": "Att -20 dB" });
    expect(withValueLabels("muteLevel", def, "en").common.states).toEqual({
      Off: "Not muted",
      On: "Muted",
      "Att -20 dB": "Lowered by 20 dB",
    });
    expect(withValueLabels("muteLevel", def, "de").common.states).toEqual({
      Off: "Nicht stumm",
      On: "Stumm",
      "Att -20 dB": "Um 20 dB abgesenkt",
    });
  });

  test("a zone's copy is labelled like the main zone's, Zone B included", () => {
    const def = list("multiroom.zoneB.sleep", { Off: "Off", "30 min": "30 min" });
    expect(withValueLabels("multiroom.zoneB.sleep", def, "en").common.states).toEqual({
      Off: "No sleep timer",
      "30 min": "30 minutes",
    });
    expect(withValueLabels("multiroom.zone3.sleep", list("x", { 60: "60" }), "de").common.states).toEqual({
      60: "60 Minuten",
    });
  });

  test("a value the table does not name keeps the label its transport gave it", () => {
    const def = list("sound.surroundDecoder", { Auto: "Auto", "Dolby Surround": "Dolby Surround" });
    expect(withValueLabels("sound.surroundDecoder", def, "en").common.states).toEqual({
      Auto: "Automatic",
      "Dolby Surround": "Dolby Surround",
    });
  });

  test("an unknown system language reads English", () => {
    const def = list("tuner.band", { fm: "fm" });
    expect(withValueLabels("tuner.band", def, "xx").common.states).toEqual({ fm: "FM (VHF)" });
  });

  test("a datapoint without a list, or one the table does not know, is written as it is", () => {
    const plain: ObjectDef = {
      id: "volume",
      type: "state",
      common: { name: "v", type: "number", role: "level", read: true, write: true },
    };
    expect(withValueLabels("volume", plain, "en")).toBe(plain);
    const unknown = list("input", { AUDIO1: "AUDIO1" });
    expect(withValueLabels("input", unknown, "en")).toBe(unknown);
    const noStates: ObjectDef = {
      id: "sleep",
      type: "state",
      common: { name: "s", type: "number", role: "level", read: true, write: true },
    };
    expect(withValueLabels("sleep", noStates, "en")).toBe(noStates);
  });

  // One datapoint, one form on every protocol (krobi 2026-10-05): a switch is a boolean everywhere and carries no
  // value list, so an entry for a datapoint every catalog builds as a switch labels nothing — `power` and `mute`
  // stood here for the words XML put on its booleans by mistake (review 2026-10-05, A19).
  test("labels no datapoint that every protocol builds as a switch", () => {
    const types = (id: string): string[] => [
      ...YNCA_CATALOG.filter(entry => entry.id === id).map(entry => specToCommon(entry.spec).type),
      ...[...XML_AMP_CATALOG, ...YXC_AMP_CATALOG, ...YXC_SYSTEM_CATALOG]
        .filter(entry => entry.state === id)
        .map(entry => entry.common.type ?? ""),
    ];
    const switchesOnly = Object.keys(STATE_LABELS).filter(id => {
      const built = types(id);
      return built.length > 0 && built.every(type => type === "boolean");
    });
    expect(switchesOnly).toEqual([]);
    expect(types("power")).not.toHaveLength(0);
    expect(types("power").every(type => type === "boolean")).toBe(true);
  });

  test("every label of the table is a key of the admin texts, and no label repeats its value", () => {
    for (const [id, labels] of Object.entries(STATE_LABELS)) {
      for (const [value, label] of Object.entries(labels)) {
        const key = typeof label === "string" ? label : label[0];
        expect(en, `${id}.${value}`).toHaveProperty(key);
        const shown = withValueLabels(id, list(id, { [value]: value }), "en").common.states as Record<string, string>;
        expect(shown[value], `${id}.${value}`).not.toBe(value);
      }
    }
  });
});
