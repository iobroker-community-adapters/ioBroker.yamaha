import { STATE_LABELS, withValueLabels } from "./state-labels";
import type { ObjectDef } from "./types";
import en from "../../../admin/i18n/en.json";

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
