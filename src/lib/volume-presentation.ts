import { writableNumber } from "./catalog/value-coerce";
import type { ObjectDef } from "./catalog/types";
import {
  asPercentObject,
  fromPercent,
  isAmpVolumeId,
  toPercent,
  volumeBoundsOf,
  type VolumeBounds,
} from "./catalog/volume-percent";

/** Where the presentation keeps its per-state memory — the adapter's register, so a deleted device is forgotten. */
export interface StateMapRegister {
  /**
   * A map keyed by namespace-relative state ids.
   *
   * @returns the map
   */
  stateMap<V>(): Map<string, V>;
}

/**
 * The percent switch of the volume datapoints (Y-05), in one place — taken out of the adapter class (review 2026-10-05,
 * D): the object a volume datapoint is written as, both value directions, and what a switch does to the value that
 * stands on the datapoint.
 *
 * All three transports and every zone go through it: the decibels YNCA and XML declare and the display scale MusicCast
 * reports are all just "the device's own scale" here. It works on the FINISHED definition, after the coordinator picked
 * the owner.
 */
export class VolumePresentation {
  /**
   * What each volume datapoint declares on the DEVICE'S OWN scale — what both value directions convert against. Filled
   * by {@link present}: the object is always written before any value for it.
   */
  private readonly scales: Map<string, VolumeBounds>;
  /** Per volume datapoint, the definition before percent had its say — what the live switch rebuilds from. */
  private readonly defs: Map<string, ObjectDef>;
  /** Per volume datapoint, the device's last report on its own scale — what a switch converts from. */
  private readonly reported: Map<string, number>;

  /**
   * @param percentFor whether the device a full state id belongs to presents its volume in percent
   * @param register where the per-state memory lives
   * @param debug a routine log line
   */
  public constructor(
    private readonly percentFor: (id: string) => boolean,
    register: StateMapRegister,
    private readonly debug: (message: string) => void,
  ) {
    this.scales = register.stateMap<VolumeBounds>();
    this.defs = register.stateMap<ObjectDef>();
    this.reported = register.stateMap<number>();
  }

  /**
   * Whether a full state id is a zone's volume datapoint.
   *
   * @param id the full state id (`<deviceId>.<relativeId>`)
   * @returns true for the amp volume of a zone
   */
  public isVolume(id: string): boolean {
    return isAmpVolumeId(id.slice(id.indexOf(".") + 1));
  }

  /**
   * The object definition to write for a datapoint, once percent mode has had its say. The bounds it replaces are
   * remembered, because they are what the two value directions convert against.
   *
   * @param id the full object id
   * @param def the definition the coordinator produced
   * @returns the definition to write
   */
  public present(id: string, def: ObjectDef): ObjectDef {
    if (def.type !== "state" || !this.isVolume(id)) {
      return def;
    }
    const bounds = volumeBoundsOf(def);
    if (!bounds) {
      // Nothing declared to convert against. Percent would be a number with no meaning, so the
      // datapoint keeps the device's own scale even with the switch on, and says so once.
      this.scales.delete(id);
      this.defs.delete(id);
      if (this.percentFor(id)) {
        this.debug(`${id}: no declared range — keeping the device's own scale instead of percent`);
      }
      return def;
    }
    this.scales.set(id, bounds);
    this.defs.set(id, def);
    return this.percentFor(id) ? asPercentObject(def) : def;
  }

  /**
   * Whether a written volume object must lose the unit it carries: back on the device's own scale, a device that
   * declares no unit (a MusicCast speaker counting steps) kept the percent switch's "%" — `extendObject` merges, and the
   * clearing write took only the bounds along: 0…60 steps labelled "%" for good (Y-05, review 2026-10-05, A24).
   *
   * @param id the full object id
   * @param next the common part about to be written
   * @param storedUnit the unit the stored object carries
   * @returns true when the stored unit has to go
   */
  public dropsUnit(id: string, next: ObjectDef["common"], storedUnit: unknown): boolean {
    return this.isVolume(id) && next.unit === undefined && storedUnit !== undefined;
  }

  /**
   * A device value on its way into a datapoint, converted when that datapoint is in percent — and remembered on the
   * device's own scale.
   *
   * @param id the full state id
   * @param value the value the transport reported, on the device's own scale
   * @returns the value to store
   */
  public shown(id: string, value: boolean | number | string | null): boolean | number | string | null {
    const bounds = this.scales.get(id);
    if (!bounds || typeof value !== "number") {
      return value;
    }
    this.reported.set(id, value);
    return this.percentFor(id) ? toPercent(value, bounds) : value;
  }

  /**
   * A user's write on its way out, converted back to the scale the device expects. Only unacked writes reach here: an
   * acked one is the adapter's own echo, already in percent.
   *
   * @param id the state id without the namespace
   * @param value the value the user wrote
   * @returns the value to hand to the device's supervisor; null for a percent write that is no number
   */
  public toDevice(id: string, value: ioBroker.StateValue): ioBroker.StateValue {
    const bounds = this.percentFor(id) ? this.scales.get(id) : undefined;
    if (!bounds) {
      return value;
    }
    // A number written as text ("50" from a VIS input or MQTT) is still a percentage — passed on
    // unconverted it reached a speaker as its raw step 50, 83 % of a 0…60 scale (audit 2026-09-24, D1).
    const percent = writableNumber(value);
    return percent === undefined ? null : fromPercent(percent, bounds);
  }

  /**
   * The volume datapoints of one device, with their definitions on the device's own scale.
   *
   * @param deviceId the id-safe device id
   * @returns the full ids and their definitions
   */
  public definitionsOf(deviceId: string): Array<[string, ObjectDef]> {
    return [...this.defs].filter(([id]) => id.startsWith(`${deviceId}.`));
  }

  /**
   * The value that stands on a volume datapoint after the switch was turned. Converted from the device's last report
   * on its own scale when there is one: converting the STORED value meant converting twice when a report arrived while
   * the switch was applied (−40 dB → 50.5 % → read again as decibels → 100 %, review 2026-10-05, A34). Without a report
   * this run, the stored value is on the scale before the switch.
   *
   * @param id the full state id
   * @param on whether the datapoint reads percent now
   * @param stored the value the datapoint holds
   * @returns the value to write, or undefined when there is none
   */
  public standing(id: string, on: boolean, stored: unknown): number | undefined {
    const bounds = this.scales.get(id);
    if (!bounds) {
      return undefined;
    }
    const device =
      this.reported.get(id) ?? (typeof stored === "number" ? (on ? stored : fromPercent(stored, bounds)) : undefined);
    if (device === undefined) {
      return undefined;
    }
    return on ? toPercent(device, bounds) : device;
  }
}
