import { catalogToObjects } from "./build-objects";
import type { CatalogEntry, ObjectDef } from "./types";

/**
 * The English half of an object's translated name.
 *
 * @param object the object definition to read the name from
 * @returns the English name, or undefined when there is none
 */
const englishName = (object: ObjectDef): string | undefined => (object.common.name as { en?: string }).en;

describe("catalogToObjects", () => {
  test("a top-level on/off entry becomes a boolean state object", () => {
    const entries: CatalogEntry[] = [
      {
        id: "power",
        nameKey: "Power",
        spec: { kind: "onoff", on: "On", off: "Standby" },
        write: true,
        role: "switch.power",
      },
    ];
    const [power] = catalogToObjects(entries);
    // The name is a translation object in all eleven languages — never a plain string.
    expect(englishName(power)).toBe("Power");
    expect(power).toMatchObject({
      id: "power",
      type: "state",
      common: { type: "boolean", role: "switch.power", read: true, write: true },
    });
  });

  test("an enum entry carries its states dropdown", () => {
    const entries: CatalogEntry[] = [
      {
        id: "input",
        nameKey: "Input",
        spec: { kind: "enum", states: { HDMI1: "HDMI1" } },
        write: true,
        role: "media.input",
      },
    ];
    const [obj] = catalogToObjects(entries);
    expect(obj.common.type).toBe("string");
    expect(obj.common.states).toEqual({ HDMI1: "HDMI1" });
  });

  test("a dotted id creates its channel object once, before the states", () => {
    const entries: CatalogEntry[] = [
      { id: "sound.bass", nameKey: "Bass", spec: { kind: "number", unit: "dB", min: -6, max: 6 }, write: true },
      { id: "sound.treble", nameKey: "Treble", spec: { kind: "number", unit: "dB", min: -6, max: 6 }, write: true },
    ];
    const objs = catalogToObjects(entries);
    expect(objs[0]).toMatchObject({ id: "sound", type: "channel" });
    expect(englishName(objs[0])).toBe("Sound");
    expect(objs.map(o => o.id)).toEqual(["sound", "sound.bass", "sound.treble"]);
    expect(objs.filter(o => o.type === "channel")).toHaveLength(1);
  });

  test("an unknown channel id falls back to its capitalised segment", () => {
    const entries: CatalogEntry[] = [{ id: "widget.artist", nameKey: "Artist", spec: { kind: "text" }, write: false }];
    const [channel] = catalogToObjects(entries);
    // An unlisted channel keeps its capitalised id — a device-derived name has no translation.
    expect(channel).toEqual({ id: "widget", type: "channel", common: { name: "Widget" } });
  });

  test("a known channel id uses its curated display name, not the raw capitalised id", () => {
    const entries: CatalogEntry[] = [{ id: "pc.artist", nameKey: "Artist", spec: { kind: "text" }, write: false }];
    const [channel] = catalogToObjects(entries);
    expect(englishName(channel)).toBe("PC"); // curated, not "Pc"
  });

  test("a protocol entry extends the base with its key; the same entry yields object AND sweep key (single source)", () => {
    // A protocol catalog adds its key (here a YNCA-style function) to the base
    // entry. build-objects reads only the object fields; the sweep/mapping reads
    // the key — one list, no second table.
    interface YncaEntry extends CatalogEntry {
      func: string;
    }
    const entries: YncaEntry[] = [
      {
        id: "power",
        nameKey: "Power",
        spec: { kind: "onoff", on: "On", off: "Standby" },
        write: true,
        role: "switch.power",
        func: "PWR",
      },
    ];
    const [obj] = catalogToObjects(entries);
    expect(englishName(obj)).toBe("Power");
    expect(obj).toMatchObject({
      id: "power",
      type: "state",
      common: { type: "boolean", role: "switch.power", read: true, write: true },
    });
    expect(entries[0].func).toBe("PWR");
  });
});
