import { describe, expect, test } from "vitest";
import { mapYxcToObjects } from "../lib/yxc/object-mapper";
import type { YxcCapabilities } from "../lib/yxc/capability";

// Y-07: the minimum and maximum a device reports are the limits — taken as reported, never computed, clipped or
// shared. A zone that reports other values is handled on its own.

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

  test("every other reported range is taken per zone as well", () => {
    expect(bounds("sound.bass")).toEqual([-12, 12, 1]);
    expect(bounds("multiroom.zone2.sound.bass")).toEqual([-10, 10, 2]);
  });
});
