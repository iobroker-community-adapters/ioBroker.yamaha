import { formDifferences } from "./object-form";
import { catalogToObjects } from "./build-objects";
import { withValueLabels } from "./state-labels";
import { keyedCommon, type ObjectDef } from "./types";
import { tName } from "../i18n";
import { YNCA_CATALOG } from "../ynca/catalog";
import { XML_AMP_CATALOG } from "../xml/catalog";

const level: ObjectDef = {
  id: "sound.bass",
  type: "state",
  common: {
    name: tName("bass"),
    type: "number",
    role: "level",
    read: true,
    write: true,
    unit: "dB",
    min: -6,
    max: 6,
    step: 0.5,
  },
};

const list = (states: Record<string, string>): ObjectDef => ({
  id: "sleep",
  type: "state",
  common: { name: tName("sleepTimer"), type: "string", role: "state", read: true, write: true, states },
});

// The check behind "one datapoint, one form on every protocol" (krobi 2026-10-05) — the parity test runs it over the
// inventory fixtures; these pin what it compares.
describe("formDifferences", () => {
  test("finds nothing between two definitions a user cannot tell apart", () => {
    expect(formDifferences(level, { ...level, common: { ...level.common, name: tName("bass") } })).toEqual([]);
    // The id, the explanation and the flags never written to the object are no part of the form.
    expect(
      formDifferences(level, {
        ...level,
        id: "multiroom.zone2.sound.bass",
        liveLabels: true,
        declaredStates: true,
        common: { ...level.common, desc: tName("descBass") },
      }),
    ).toEqual([]);
  });

  test("names every field of the form that differs", () => {
    const other: ObjectDef = {
      id: "sound.bass",
      type: "channel",
      common: {
        name: tName("treble"),
        type: "string",
        role: "value",
        read: false,
        write: false,
        unit: "%",
        min: 0,
        max: 100,
        step: 1,
      },
    };
    expect(formDifferences(level, other).map(difference => difference.field)).toEqual([
      "type",
      "common.type",
      "common.role",
      "common.read",
      "common.write",
      "common.min",
      "common.max",
      "common.step",
      "common.unit",
      "common.name",
    ]);
  });

  test("takes a missing unit and an empty one for the same", () => {
    const { unit: _unit, ...withoutUnit } = level.common;
    expect(
      formDifferences({ ...level, common: withoutUnit }, { ...level, common: { ...withoutUnit, unit: "" } }),
    ).toEqual([]);
    expect(formDifferences({ ...level, common: withoutUnit }, level)).toEqual([
      { field: "common.unit", a: undefined, b: "dB" },
    ]);
  });

  test("compares a name text by text — a plain string is not the translated name", () => {
    expect(formDifferences(level, { ...level, common: { ...level.common, name: "Bass" } })[0]).toMatchObject({
      field: "common.name",
      b: "Bass",
    });
    const german = { ...(tName("bass") as Record<string, string>), de: "Tiefen" } as ioBroker.Translated;
    expect(formDifferences(level, { ...level, common: { ...level.common, name: german } })).toHaveLength(1);
  });

  test("reports every value of the lists that is missing on one side or labelled otherwise", () => {
    expect(formDifferences(list({ Off: "Off", "30 min": "30 min" }), list({ Off: "Aus", "60 min": "60 min" }))).toEqual(
      [
        { field: "common.states.Off", a: "Off", b: "Aus" },
        { field: "common.states.30 min", a: "30 min", b: undefined },
        { field: "common.states.60 min", a: undefined, b: "60 min" },
      ],
    );
    // A list on one side only is a dropdown against a free field.
    expect(
      formDifferences(list({ Off: "Off" }), { ...list({}), common: { ...list({}).common, states: undefined } }),
    ).toEqual([{ field: "common.states.Off", a: "Off", b: undefined }]);
  });

  test("compares the labels a user sees once both pass the one label table", () => {
    const ynca = list({ Off: "Off", "30 min": "30 min" });
    const xml = list({ Off: "Off", "30 min": "30" });
    expect(formDifferences(ynca, xml)).toHaveLength(1);
    expect(formDifferences(withValueLabels("sleep", ynca, "en"), withValueLabels("sleep", xml, "en"))).toEqual([]);
  });

  test("YNCA and XML build the main zone's power alike", () => {
    const [ynca] = catalogToObjects(YNCA_CATALOG.filter(entry => entry.id === "power"));
    const entry = XML_AMP_CATALOG.find(candidate => candidate.state === "power");
    expect(entry).toBeDefined();
    const xml: ObjectDef = { id: "power", type: "state", common: keyedCommon(entry!.common) };
    expect(formDifferences(ynca, xml)).toEqual([]);
  });
});
