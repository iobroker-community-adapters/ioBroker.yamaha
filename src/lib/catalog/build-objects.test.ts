import { catalogToObjects } from "./build-objects";
import type { CatalogEntry } from "./types";

describe("catalogToObjects", () => {
  test("a top-level on/off entry becomes a boolean state object", () => {
    const entries: CatalogEntry[] = [
      { id: "power", name: "Power", spec: { kind: "onoff", on: "On", off: "Standby" }, write: true, role: "switch.power" },
    ];
    expect(catalogToObjects(entries)).toEqual([
      {
        id: "power",
        type: "state",
        common: { name: "Power", type: "boolean", role: "switch.power", read: true, write: true },
      },
    ]);
  });

  test("an enum entry carries its states dropdown", () => {
    const entries: CatalogEntry[] = [
      { id: "input", name: "Input", spec: { kind: "enum", states: { HDMI1: "HDMI1" } }, write: true, role: "media.input" },
    ];
    const [obj] = catalogToObjects(entries);
    expect(obj.common.type).toBe("string");
    expect(obj.common.states).toEqual({ HDMI1: "HDMI1" });
  });

  test("a dotted id creates its channel object once, before the states", () => {
    const entries: CatalogEntry[] = [
      { id: "sound.bass", name: "Bass", spec: { kind: "number", unit: "dB", min: -6, max: 6 }, write: true },
      { id: "sound.treble", name: "Treble", spec: { kind: "number", unit: "dB", min: -6, max: 6 }, write: true },
    ];
    const objs = catalogToObjects(entries);
    expect(objs[0]).toEqual({ id: "sound", type: "channel", common: { name: "Sound" } });
    expect(objs.map(o => o.id)).toEqual(["sound", "sound.bass", "sound.treble"]);
    expect(objs.filter(o => o.type === "channel")).toHaveLength(1);
  });

  test("an unknown channel id falls back to its capitalised segment", () => {
    const entries: CatalogEntry[] = [
      { id: "airplay.artist", name: "Artist", spec: { kind: "text" }, write: false },
    ];
    const [channel] = catalogToObjects(entries);
    expect(channel).toEqual({ id: "airplay", type: "channel", common: { name: "Airplay" } });
  });

  test("a protocol entry extends the base with its key; the same entry yields object AND sweep key (single source)", () => {
    // A protocol catalog adds its key (here a YNCA-style function) to the base
    // entry. build-objects reads only the object fields; the sweep/mapping reads
    // the key — one list, no second table.
    interface YncaEntry extends CatalogEntry {
      func: string;
    }
    const entries: YncaEntry[] = [
      { id: "power", name: "Power", spec: { kind: "onoff", on: "On", off: "Standby" }, write: true, role: "switch.power", func: "PWR" },
    ];
    const [obj] = catalogToObjects(entries);
    expect(obj).toEqual({
      id: "power",
      type: "state",
      common: { name: "Power", type: "boolean", role: "switch.power", read: true, write: true },
    });
    expect(entries[0].func).toBe("PWR");
  });
});
