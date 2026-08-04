import type { StateValue } from "../types";

/** A YXC amplifier command: a YamahaYXC method with its target zone and value. */
export interface YxcCommand {
  /** The YamahaYXC method to call (`power`, `setVolumeTo`, `mute`, `setInput`, `setSound`). */
  method: string;
  /** The target zone (`main`, `zone2`, …). */
  zone: string;
  /** The value to pass to the method. */
  value: boolean | number | string;
}

interface YxcStateMapping {
  /** Field name carrying this state in a getStatus response. */
  statusField: string;
  /** YamahaYXC method for a write to this state. */
  method: string;
  /** Convert a written state value into the YamahaYXC argument. */
  toYxc: (value: unknown) => boolean | number | string;
  /** Convert a getStatus field value into the typed state value. */
  fromStatus: (value: unknown) => boolean | number | string;
}

/**
 * Unified state name → YXC getStatus field, write method, and value conversions.
 * `sound_program` (getStatus) maps to the unified `soundProgram` state and the
 * `setSound` method — the method name is `setSound`, not `setSoundProgram`.
 */
const YXC_STATE_MAPPINGS: Record<string, YxcStateMapping> = {
  power: { statusField: "power", method: "power", toYxc: value => Boolean(value), fromStatus: value => value === "on" },
  volume: {
    statusField: "volume",
    method: "setVolumeTo",
    toYxc: value => Number(value),
    fromStatus: value => Number(value),
  },
  mute: { statusField: "mute", method: "mute", toYxc: value => Boolean(value), fromStatus: value => Boolean(value) },
  input: {
    statusField: "input",
    method: "setInput",
    toYxc: value => String(value),
    fromStatus: value => String(value),
  },
  soundProgram: {
    statusField: "sound_program",
    method: "setSound",
    toYxc: value => String(value),
    fromStatus: value => String(value),
  },
  enhancer: {
    statusField: "enhancer",
    method: "setEnhancer",
    toYxc: value => Boolean(value),
    fromStatus: value => Boolean(value),
  },
  pureDirect: {
    statusField: "pure_direct",
    method: "setPureDirect",
    toYxc: value => Boolean(value),
    fromStatus: value => Boolean(value),
  },
};

const ZONE_PREFIX: Record<string, string> = { main: "", zone2: "zone2.", zone3: "zone3.", zone4: "zone4." };

/**
 * Parse a YXC getStatus response into unified amp state updates for a zone. Only
 * fields the response actually carries are emitted (presence-checked, so a
 * `mute: false` is kept), each prefixed for its zone.
 *
 * @param zoneStatus the getStatus response object
 * @param zone the zone the status belongs to (`main`, `zone2`, …)
 * @returns the state updates, empty if malformed or no amp fields are present
 */
export function parseYxcStatus(zoneStatus: unknown, zone: string): StateValue[] {
  if (typeof zoneStatus !== "object" || zoneStatus === null) {
    return [];
  }
  const prefix = ZONE_PREFIX[zone];
  if (prefix === undefined) {
    return [];
  }
  const status = zoneStatus as Record<string, unknown>;
  const updates: StateValue[] = [];
  for (const [name, mapping] of Object.entries(YXC_STATE_MAPPINGS)) {
    if (mapping.statusField in status) {
      updates.push({ id: `${prefix}${name}`, value: mapping.fromStatus(status[mapping.statusField]) });
    }
  }
  return updates;
}

/**
 * Map a unified state write to a YXC amplifier command.
 *
 * @param stateId the state id (e.g. `power`, `zone2.volume`)
 * @param value the value written to the state
 * @returns the YXC command, or undefined if the state or its zone is not mapped
 */
export function stateToYxc(stateId: string, value: unknown): YxcCommand | undefined {
  let zone = "main";
  let name = stateId;
  const dot = stateId.indexOf(".");
  if (dot > 0) {
    zone = stateId.slice(0, dot);
    name = stateId.slice(dot + 1);
    if (ZONE_PREFIX[zone] === undefined || zone === "main") {
      return undefined;
    }
  }
  const mapping = YXC_STATE_MAPPINGS[name];
  if (!mapping) {
    return undefined;
  }
  return { method: mapping.method, zone, value: mapping.toYxc(value) };
}
