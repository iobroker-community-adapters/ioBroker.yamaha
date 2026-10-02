import { describe, expect, test } from "vitest";
import { mapYxcToObjects } from "../lib/yxc/object-mapper";
import { yncaObjectsFor } from "../lib/ynca/catalog";

// Y-23: the adapter finds out by itself what the connected device can do and creates datapoints for that only —
// for every device, not for one sample.

describe("Y-23 datapoints only for what the device can do", () => {
  test("MusicCast: a speaker that declares no tuner, no player and no zone 2 gets none of them", () => {
    const ids = mapYxcToObjects({
      zones: [{ id: "main", funcs: ["power", "volume", "mute"], inputs: ["aux"] }],
      media: [],
    }).map(o => o.id);
    expect(ids).toEqual(expect.arrayContaining(["power", "volume", "mute", "input"]));
    expect(ids.filter(id => /^(tuner|player|multiroom\.zone\d)/.test(id))).toEqual([]);
  });

  test("MusicCast: what a device declares is what it gets", () => {
    const ids = mapYxcToObjects({
      zones: [
        { id: "main", funcs: ["power", "volume"], inputs: ["tuner", "net_radio"] },
        { id: "zone2", funcs: ["power"], inputs: ["tuner"] },
      ],
      media: ["tuner", "netusb"],
      tuner: { bands: ["fm"], funcs: ["fm"], presetType: "common" },
    }).map(o => o.id);
    expect(ids).toEqual(expect.arrayContaining(["multiroom.zone2.power", "player.playback"]));
    expect(ids.some(id => id.startsWith("tuner."))).toBe(true);
    expect(ids).not.toContain("multiroom.zone2.volume");
  });

  test("YNCA: only the functions the receiver answered become datapoints", () => {
    const amp = yncaObjectsFor({ model: "RX-V473", subunits: { MAIN: { PWR: "On", VOL: "-40.0" } } }).map(o => o.id);
    expect(amp).toEqual(expect.arrayContaining(["power", "volume"]));
    expect(amp.filter(id => /^(tuner|multiroom|player|sound)\./.test(id))).toEqual([]);
    const withTuner = yncaObjectsFor({
      model: "RX-V473",
      subunits: { MAIN: { PWR: "On" }, TUN: { BAND: "FM" } },
    }).map(o => o.id);
    expect(withTuner).toContain("tuner.band");
  });
});
