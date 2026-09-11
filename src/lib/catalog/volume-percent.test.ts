import { asPercentObject, fromPercent, isAmpVolumeId, toPercent, volumeBoundsOf } from "./volume-percent";
import type { ObjectDef } from "./types";

describe("volume percent mode", () => {
  /** The two scales the fleet actually meets: MusicCast decibels and the YNCA catalog's. */
  const musicCastDb = { min: -80.5, max: 16.5, step: 0.5 };
  const speaker = { min: 0, max: 60, step: 1 };

  describe("isAmpVolumeId", () => {
    // The switch reaches EVERY zone (krobi 2026-09-11: "ein schalter für ALLE"), and nothing else.
    // Every other id carrying "volume" is a different quantity on a different scale: a limit, a
    // calibration offset, a line-output mode, a button.
    test("matches main and every zone, and nothing else", () => {
      for (const id of ["volume", "multiroom.zone2.volume", "multiroom.zone3.volume", "multiroom.zone4.volume"]) {
        expect(isAmpVolumeId(id), id).toBe(true);
      }
      for (const id of [
        "advanced.maxVolume",
        "multiroom.zone2.advanced.maxVolume",
        "sound.ypaoVolume",
        "subwooferVolume",
        "multiroom.zone2.volumeOutput",
        "multiroom.partyVolumeUp",
        "player.airplay.volumeInterlock",
      ]) {
        expect(isAmpVolumeId(id), id).toBe(false);
      }
    });
  });

  describe("the declared bounds", () => {
    const def = (common: Record<string, unknown>): ObjectDef =>
      ({ id: "volume", type: "state", common }) as unknown as ObjectDef;

    test("are read from the finished object definition", () => {
      expect(volumeBoundsOf(def({ min: -80.5, max: 16.5, step: 0.5 }))).toEqual(musicCastDb);
    });

    // Percent against an unknown range would be a number with no meaning. The caller keeps the
    // device's own scale instead of inventing ends for it.
    test("are undefined when the device declared none", () => {
      expect(volumeBoundsOf(def({ min: -80.5, max: 16.5 }))).toBeUndefined();
      expect(volumeBoundsOf(def({}))).toBeUndefined();
      expect(volumeBoundsOf(def({ min: 5, max: 5, step: 1 }))).toBeUndefined();
    });
  });

  describe("the percent object", () => {
    test("declares 0…100 % and keeps the role a widget binds to", () => {
      const source = {
        id: "multiroom.zone2.volume",
        type: "state",
        common: { type: "number", role: "level.volume", write: true, min: -80.5, max: 0, step: 0.5, unit: "dB" },
      } as unknown as ObjectDef;
      const percent = asPercentObject(source);
      expect(percent.common.min).toBe(0);
      expect(percent.common.max).toBe(100);
      expect(percent.common.unit).toBe("%");
      expect(percent.common.role).toBe("level.volume");
      expect(percent.common.write).toBe(true);
      // The explanation follows the mode — the datapoint has to say what its numbers mean.
      expect(percent.common.desc).not.toEqual(source.common.desc);
      // The source definition is the coordinator's; rewriting it in place would leak percent
      // bounds into the fingerprint the handle compares against.
      expect(source.common.max).toBe(0);
    });
  });

  describe("the conversion", () => {
    test("puts the ends of the device's range at 0 % and 100 %", () => {
      expect(toPercent(-80.5, musicCastDb)).toBe(0);
      expect(toPercent(16.5, musicCastDb)).toBe(100);
      expect(fromPercent(0, musicCastDb)).toBe(-80.5);
      expect(fromPercent(100, musicCastDb)).toBe(16.5);
    });

    // The whole point of percent mode: a value the user writes has to come back as the value they
    // wrote. That holds only while the percent grid is at least as fine as the device's own — 201
    // percent values against 161 raw steps on the widest receiver in the captures.
    test("round-trips every step the device offers", () => {
      for (const bounds of [musicCastDb, speaker]) {
        const steps = Math.round((bounds.max - bounds.min) / bounds.step);
        for (let i = 0; i <= steps; i++) {
          const value = Number((bounds.min + i * bounds.step).toFixed(4));
          expect(fromPercent(toPercent(value, bounds), bounds), `${value} on ${bounds.min}…${bounds.max}`).toBe(value);
        }
      }
    });

    // Every volume scale in the captures moves on halves or whole steps, and those are exact in
    // binary. A grid of tenths is not: 0.1 x 3 is 0.30000000000000004, and the datapoint would
    // carry that tail for ever and never compare equal to what the device reports. The bounds come
    // from the DEVICE's own declaration, so the grid is not the adapter's to assume.
    test("lands on the device's own grid, whatever that grid is", () => {
      for (const bounds of [musicCastDb, { min: 0, max: 10, step: 0.1 }]) {
        for (let percent = 0; percent <= 100; percent += 0.5) {
          const value = fromPercent(percent, bounds);
          expect(value, `${percent} % on step ${bounds.step}`).toBe(Number(value.toFixed(1)));
        }
      }
    });

    // A script writing 120 or -5 must not send the device a value outside what it declared.
    test("holds a value past either end at that end", () => {
      expect(fromPercent(140, musicCastDb)).toBe(16.5);
      expect(fromPercent(-20, musicCastDb)).toBe(-80.5);
      expect(toPercent(40, musicCastDb)).toBe(100);
      expect(toPercent(-200, musicCastDb)).toBe(0);
    });
  });
});
