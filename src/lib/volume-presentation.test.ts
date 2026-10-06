import type { ObjectDef } from "./catalog/types";
import { PerDeviceCaches } from "./lifecycle/per-device";
import { VolumePresentation } from "./volume-presentation";

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
    min: -80,
    max: 0,
    step: 0.5,
  },
};

function presentation(percent: Set<string>): { volume: VolumePresentation; caches: PerDeviceCaches } {
  const caches = new PerDeviceCaches();
  const volume = new VolumePresentation(
    id => percent.has(id.slice(0, id.indexOf("."))),
    caches,
    () => undefined,
  );
  return { volume, caches };
}

describe("VolumePresentation", () => {
  test("presents the zone volumes of a percent device in percent, and converts both ways", () => {
    const { volume } = presentation(new Set(["living"]));
    expect(volume.present("living.multiroom.zone2.volume", DB_VOLUME).common).toMatchObject({ unit: "%", max: 100 });
    expect(volume.present("living.advanced.maxVolume", DB_VOLUME).common.unit).toBe("dB");
    expect(volume.shown("living.multiroom.zone2.volume", -40)).toBe(50);
    expect(volume.toDevice("living.multiroom.zone2.volume", "50")).toBe(-40);
    expect(volume.toDevice("living.multiroom.zone2.volume", "loud")).toBeNull();
  });

  test("a volume without declared bounds keeps its scale, and only a percent device says so", () => {
    const lines: string[] = [];
    const volume = new VolumePresentation(
      id => id.startsWith("living."),
      new PerDeviceCaches(),
      message => void lines.push(message),
    );
    const { min: _min, max: _max, ...unbounded } = DB_VOLUME.common;
    const def: ObjectDef = { ...DB_VOLUME, common: unbounded };
    expect(volume.present("living.volume", def)).toBe(def);
    expect(volume.present("office.volume", def)).toBe(def);
    expect(lines).toEqual(["living.volume: no declared range — keeping the device's own scale instead of percent"]);
  });

  // Review 2026-10-05, A34: the switch converted the STORED value — after a report during the switch, a second time.
  test("the value after a switch comes from the device's last report, not from what is stored", () => {
    const percent = new Set<string>();
    const { volume } = presentation(percent);
    volume.present("living.volume", DB_VOLUME);
    expect(volume.shown("living.volume", -40)).toBe(-40);
    percent.add("living");
    // Stored is already 50 (a report converted it while the switch ran) — read as decibels it would be 100 %.
    expect(volume.standing("living.volume", true, 50)).toBe(50);
    percent.delete("living");
    expect(volume.standing("living.volume", false, 50)).toBe(-40);
  });

  test("without a report the stored value is on the scale before the switch", () => {
    const { volume } = presentation(new Set());
    volume.present("living.volume", DB_VOLUME);
    expect(volume.standing("living.volume", true, -40)).toBe(50);
    expect(volume.standing("living.volume", false, 50)).toBe(-40);
    expect(volume.standing("living.volume", true, null)).toBeUndefined();
    expect(volume.standing("living.other", true, 1)).toBeUndefined();
  });

  // Review 2026-10-05, A24: a unit-less device scale kept the "%" of the percent switch.
  test("a volume written without a unit drops a stored one; other datapoints keep theirs", () => {
    const { volume } = presentation(new Set());
    const steps = { ...DB_VOLUME.common, unit: undefined };
    expect(volume.dropsUnit("wx.volume", steps, "%")).toBe(true);
    expect(volume.dropsUnit("wx.volume", DB_VOLUME.common, "%")).toBe(false);
    expect(volume.dropsUnit("wx.volume", steps, undefined)).toBe(false);
    expect(volume.dropsUnit("wx.sound.bass", steps, "dB")).toBe(false);
  });

  test("a deleted device is forgotten", () => {
    const { volume, caches } = presentation(new Set());
    volume.present("living.volume", DB_VOLUME);
    caches.forget("living");
    expect(volume.definitionsOf("living")).toEqual([]);
    expect(volume.standing("living.volume", true, -40)).toBeUndefined();
  });
});
