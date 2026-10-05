import { describe, expect, test } from "vitest";
import { mapYxcToObjects } from "../lib/yxc/object-mapper";
import type { YxcCapabilities } from "../lib/yxc/capability";

// Y-07: the minimum and maximum a device reports are the limits — taken as reported, never clipped or shared. A zone
// that reports other values is handled on its own. Bass and treble are decibels on every protocol (merged Y-32, krobi
// 2026-10-05 22:47 "y07 change is fine"): MusicCast's reported steps are halved into decibels, zone by zone.

/** An AV receiver whose zone 2 declares a lower volume top and a narrower tone range than its main zone. */
const RECEIVER: YxcCapabilities = {
  zones: [
    {
      id: "main",
      funcs: ["power", "volume", "tone_control", "actual_volume"],
      inputs: ["hdmi1"],
      ranges: {
        volume: { min: 0, max: 161, step: 1 },
        actual_volume_db: { min: -80.5, max: 16.5, step: 0.5 },
        tone_control: { min: -12, max: 12, step: 1 },
      },
    },
    {
      id: "zone2",
      funcs: ["power", "volume", "tone_control", "actual_volume"],
      inputs: ["hdmi1"],
      ranges: {
        volume: { min: 0, max: 121, step: 1 },
        actual_volume_db: { min: -80.5, max: 10, step: 0.5 },
        tone_control: { min: -10, max: 10, step: 2 },
      },
    },
  ],
  media: [],
};

function bounds(id: string): [unknown, unknown, unknown] {
  const common = mapYxcToObjects(RECEIVER).find(o => o.id === id)?.common;
  return [common?.min, common?.max, common?.step];
}

describe("Y-07 the reported minimum and maximum are the limits, zone by zone", () => {
  test("main takes its own reported volume limits", () => {
    expect(bounds("volume")).toEqual([-80.5, 16.5, 0.5]);
  });

  test("zone 2 takes ITS reported volume limits, not main's", () => {
    expect(bounds("multiroom.zone2.volume")).toEqual([-80.5, 10, 0.5]);
  });

  test("bass and treble take each zone's reported range, halved into decibels", () => {
    expect(bounds("sound.bass")).toEqual([-6, 6, 0.5]);
    expect(bounds("sound.treble")).toEqual([-6, 6, 0.5]);
    expect(bounds("multiroom.zone2.sound.bass")).toEqual([-5, 5, 1]);
    expect(bounds("multiroom.zone2.sound.treble")).toEqual([-5, 5, 1]);
  });

  test("bass and treble are decibels", () => {
    const unit = (id: string): unknown => mapYxcToObjects(RECEIVER).find(o => o.id === id)?.common.unit;
    expect([unit("sound.bass"), unit("sound.treble"), unit("multiroom.zone2.sound.bass")]).toEqual(["dB", "dB", "dB"]);
  });
});
