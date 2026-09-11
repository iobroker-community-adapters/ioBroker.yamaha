import { ZONE_PREFIX } from "./owner-policy";
import { tName } from "../i18n";
import type { ObjectDef } from "./types";

/**
 * Percent mode: the one `volume` datapoint expressed as 0…100 % instead of the scale the device
 * itself uses.
 *
 * Why the adapter offers it at all: a receiver's own scale is decibels on the two text protocols
 * and a step count on MusicCast, so a finished VIS widget bound to `volume` meets a number it
 * cannot present (issue #623) — and a person picking a loudness thinks upwards from zero, not in
 * negative decibels (krobi 2026-09-11). The setting is instance-wide and off by default: the
 * device's own scale is the truth, and a user asking for percent is asking for a conversion.
 *
 * The layer sits over the FINISHED object definition, so it is one rule for all three transports
 * and every zone — the decibels YNCA and XML declare in their catalogs and the display scale
 * MusicCast reports go through the same two functions.
 */

/**
 * The grid the percent datapoint declares.
 *
 * 0.5 gives 201 values, more than the finest device scale in the bundled captures (161 raw steps
 * on an AV receiver, 195 on the YNCA decibel scale), so no loudness the device offers becomes
 * unreachable — which a whole-number percent would do to about a third of them.
 */
const PERCENT_STEP = 0.5;

/** What a volume datapoint declares on the device's own scale. */
export interface VolumeBounds {
  /** The quietest value the device accepts. */
  min: number;
  /** The loudest value the device accepts. */
  max: number;
  /** The grid the device's own scale moves on. */
  step: number;
}

/**
 * Whether a canonical state id is the amp volume — main's or any zone's.
 *
 * Measured against the built tree: only `volume` and `multiroom.zoneN.volume` carry the loudness
 * of a zone. `advanced.maxVolume` (a limit), `sound.ypaoVolume` (a calibration offset),
 * `subwooferVolume`, `multiroom.zone2.volumeOutput`, `multiroom.partyVolumeUp/Down` and
 * `player.airplay.volumeInterlock` are other quantities on other scales and stay untouched.
 *
 * @param stateId the canonical state id, without the device prefix
 * @returns true when the id is a zone's volume datapoint
 */
export function isAmpVolumeId(stateId: string): boolean {
  return stateId.replace(ZONE_PREFIX, "") === "volume";
}

/**
 * The bounds a volume object declares, if it declares all three.
 *
 * @param def the finished object definition
 * @returns the bounds, or undefined when the device declared none (nothing to convert against)
 */
export function volumeBoundsOf(def: ObjectDef): VolumeBounds | undefined {
  const { min, max, step } = def.common;
  if (typeof min !== "number" || typeof max !== "number" || typeof step !== "number" || max <= min) {
    return undefined;
  }
  return { min, max, step };
}

/**
 * The same object, declared as 0…100 %.
 *
 * The role stays `level.volume` — the ioBroker catalog names 0…100 as its usual range, so percent
 * is the shape a widget expects there. Only the presentation changes; the datapoint is still the
 * one the device's loudness lives on.
 *
 * @param def the finished object definition, on the device's own scale
 * @returns the definition to write in percent mode
 */
export function asPercentObject(def: ObjectDef): ObjectDef {
  return {
    ...def,
    common: { ...def.common, min: 0, max: 100, step: PERCENT_STEP, unit: "%", desc: tName("descVolumePercent") },
  };
}

/**
 * A value on the device's scale, as a percentage of what the device accepts.
 *
 * @param value the value the device reported
 * @param bounds what the datapoint declares on the device's own scale
 * @returns the percentage, on the grid the percent datapoint declares
 */
export function toPercent(value: number, bounds: VolumeBounds): number {
  const share = ((value - bounds.min) / (bounds.max - bounds.min)) * 100;
  return clamp(Math.round(share / PERCENT_STEP) * PERCENT_STEP, 0, 100);
}

/**
 * A percentage, as a value on the device's own scale.
 *
 * Snapped to the device's own grid: a receiver counting in half decibels must not be sent a
 * quarter, and the snap is what makes a read-back land on the percentage that was written.
 *
 * @param percent the value the user wrote
 * @param bounds what the datapoint declares on the device's own scale
 * @returns the value to hand to the transport, on the device's scale
 */
export function fromPercent(percent: number, bounds: VolumeBounds): number {
  const raw = bounds.min + (clamp(percent, 0, 100) / 100) * (bounds.max - bounds.min);
  const snapped = bounds.step > 0 ? Math.round(raw / bounds.step) * bounds.step : raw;
  // Half-decibel grids reach this with a floating-point tail (-50.500000000000004); the datapoint
  // and every comparison against the device's own report would carry it for ever.
  return clamp(Number(snapped.toFixed(4)), bounds.min, bounds.max);
}

/**
 * Hold a number inside an inclusive range.
 *
 * @param value the number to hold
 * @param low the lowest allowed value
 * @param high the highest allowed value
 * @returns the value, held inside the range
 */
function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
