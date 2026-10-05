import { describe, expect, test } from "vitest";
import { mapYxcToObjects } from "../lib/yxc/object-mapper";
import type { YxcCapabilities } from "../lib/yxc/capability";

// Y-33 (krobi 2026-10-05 22:47 "y33 yes"): on a MusicCast-only device the subwoofer stays in the device's own steps.
// MusicCast reports a different range per model (-12..12, -10..10, -4..4) and nowhere says how many decibels a step
// is, so nothing is converted — unlike bass and treble (Y-07).

/**
 * A MusicCast device with the given subwoofer range and the receiver's tone range.
 *
 * @param min the reported minimum
 * @param max the reported maximum
 * @returns the capabilities
 */
function device(min: number, max: number): YxcCapabilities {
  return {
    zones: [
      {
        id: "main",
        funcs: ["power", "subwoofer_volume", "tone_control"],
        inputs: [],
        ranges: { subwoofer_volume: { min, max, step: 1 }, tone_control: { min: -12, max: 12, step: 1 } },
      },
    ],
    media: [],
  };
}

function common(caps: YxcCapabilities, id: string): Record<string, unknown> {
  return mapYxcToObjects(caps).find(o => o.id === id)?.common ?? {};
}

describe("Y-33 the MusicCast subwoofer stays in the device's own steps", () => {
  test("each model's reported range is the limit, not halved", () => {
    for (const [min, max] of [
      [-12, 12],
      [-10, 10],
      [-4, 4],
    ]) {
      const sub = common(device(min, max), "subwooferVolume");
      expect([sub.min, sub.max, sub.step]).toEqual([min, max, 1]);
    }
  });

  test("its steps carry no decibel unit, while bass on the same device is converted", () => {
    const caps = device(-12, 12);
    expect(common(caps, "subwooferVolume").unit ?? "").not.toBe("dB");
    // Positive control: the same device's bass IS converted, so the subwoofer is left alone on purpose.
    expect([common(caps, "sound.bass").max, common(caps, "sound.bass").unit]).toEqual([6, "dB"]);
  });
});
