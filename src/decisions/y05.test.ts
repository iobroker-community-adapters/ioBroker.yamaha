import { describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Y-05: volume is ONE datapoint per zone, `volume`. It shows the value the receiver reports and sends the value the
// receiver expects — no display twins, no conversion of the adapter's own. The one conversion is the percent switch:
// it turns the same datapoint into 0–100 %, is set per device for all of its zones, and is set in one place only.

vi.mock("@iobroker/adapter-core", () => ({
  Adapter: class {
    public log = { silly: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    public namespace = "yamaha.0";
    public config: Record<string, unknown> = {};
    public on = vi.fn();
    constructor(_opts: unknown) {}
  },
  I18n: { init: vi.fn(() => Promise.resolve(undefined)) },
  getAbsoluteInstanceDataDir: () => "/tmp/yamaha-data",
}));

import { Yamaha } from "../main";
import { mapYxcToObjects, rawVolumeFor, shownVolumeFor, volumeScaleOf } from "../lib/yxc/object-mapper";
import { buildDeviceForm } from "../device-management-helpers";
import type { ObjectDef } from "../lib/catalog/types";
import type { YxcZone } from "../lib/yxc/capability";

const ROOT = join(__dirname, "..", "..");

/**
 * A MusicCast AV receiver zone: raw steps 0…161 on the wire, decibels on its display.
 *
 * @param id the zone id
 * @param top the loudest value its display scale declares
 * @returns the zone
 */
const ZONE = (id: string, top: number): YxcZone => ({
  id,
  funcs: ["power", "volume", "mute", "actual_volume"],
  inputs: ["hdmi1"],
  ranges: { volume: { min: 0, max: 161, step: 1 }, actual_volume_db: { min: -80.5, max: top, step: 0.5 } },
});

const DB_VOLUME: ObjectDef = {
  id: "volume",
  type: "state",
  common: {
    name: "Volume",
    type: "number",
    role: "level.volume",
    read: true,
    write: true,
    unit: "dB",
    min: -80.5,
    max: 16.5,
    step: 0.5,
  },
};

interface Presenting {
  presentVolume(id: string, def: ObjectDef): ObjectDef;
  volumeAsShown(id: string, value: number): number;
  volumeAsDeviceScale(id: string, value: number): number;
  volumePercent: Map<string, boolean>;
}

describe("Y-05 one volume datapoint on the receiver's own scale; percent is the one switch", () => {
  test("each zone has exactly one volume datapoint and no display twin", () => {
    const ids = mapYxcToObjects({ zones: [ZONE("main", 16.5), ZONE("zone2", 10)], media: [] }).map(o => o.id);
    expect(ids).toEqual(expect.arrayContaining(["volume", "multiroom.zone2.volume"]));
    const loudness = ids.filter(id => /volume/i.test(id) && !/maxVolume/.test(id));
    expect(loudness.sort()).toEqual(["multiroom.zone2.volume", "volume"]);
    expect(ids.filter(id => /actual/i.test(id))).toEqual([]);
  });

  test("it shows the receiver's display and sends the receiver's own steps", () => {
    const main = mapYxcToObjects({ zones: [ZONE("main", 16.5)], media: [] }).find(o => o.id === "volume")!;
    expect([main.common.unit, main.common.min, main.common.max]).toEqual(["dB", -80.5, 16.5]);
    const scale = volumeScaleOf(ZONE("main", 16.5), "db")!;
    expect(shownVolumeFor(scale, 83)).toBe(-39);
    expect(rawVolumeFor(scale, -39)).toBe(83);
  });

  test("without the switch the adapter converts nothing", () => {
    const adapter = new Yamaha() as unknown as Presenting;
    expect(adapter.presentVolume("living.volume", DB_VOLUME)).toEqual(DB_VOLUME);
    expect(adapter.volumeAsShown("living.volume", -39)).toBe(-39);
    expect(adapter.volumeAsDeviceScale("living.volume", -39)).toBe(-39);
  });

  test("the switch turns the same datapoint into 0–100 % for every zone of that device, and only that device", () => {
    const adapter = new Yamaha() as unknown as Presenting;
    adapter.volumePercent.set("living", true);
    for (const id of ["living.volume", "living.multiroom.zone2.volume", "living.multiroom.zoneB.volume"]) {
      const shown = adapter.presentVolume(id, DB_VOLUME);
      expect([shown.id, shown.common.unit, shown.common.min, shown.common.max]).toEqual(["volume", "%", 0, 100]);
    }
    expect(adapter.volumeAsShown("living.volume", 16.5)).toBe(100);
    expect(adapter.volumeAsDeviceScale("living.volume", 100)).toBe(16.5);
    // Another device keeps its own scale, and a limit on the volume scale is no volume.
    expect(adapter.presentVolume("kitchen.volume", DB_VOLUME).common.unit).toBe("dB");
    expect(
      adapter.presentVolume("living.advanced.maxVolume", { ...DB_VOLUME, id: "advanced.maxVolume" }).common.unit,
    ).toBe("dB");
  });

  test("the switch is set in one place: the device's own settings, not the instance settings", () => {
    const form = JSON.stringify(buildDeviceForm([]));
    expect(form).toContain('"volumeAsPercent"');
    const config = readFileSync(join(ROOT, "admin", "jsonConfig.json"), "utf-8");
    expect(config).not.toMatch(/volumeAsPercent|percent/i);
  });
});
