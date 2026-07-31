/** A YNCA subunit/function/value triple. */
export interface YncaTriple {
  /** Target subunit (e.g. `MAIN`, `ZONE2`). */
  subunit: string;
  /** Function name (e.g. `PWR`, `VOL`). */
  func: string;
  /** Wire value. */
  value: string;
}

/** A unified state id and its typed value. */
export interface StateValue {
  /** State id relative to the device (e.g. `power`, `zone2.volume`). */
  id: string;
  /** Typed value for the state. */
  value: boolean | number | string;
}

interface StateMapping {
  func: string;
  toYnca: (value: unknown) => string;
  fromYnca: (value: string) => boolean | number | string;
}

/** Unified state name → YNCA function plus value conversion in both directions. */
const STATE_MAPPINGS: Record<string, StateMapping> = {
  power: { func: "PWR", toYnca: value => (value ? "On" : "Standby"), fromYnca: value => value === "On" },
  volume: { func: "VOL", toYnca: value => Number(value).toFixed(1), fromYnca: value => Number.parseFloat(value) },
  mute: { func: "MUTE", toYnca: value => (value ? "On" : "Off"), fromYnca: value => value === "On" },
  input: { func: "INP", toYnca: value => String(value), fromYnca: value => value },
  soundProgram: { func: "SOUNDPRG", toYnca: value => String(value), fromYnca: value => value },
};

const ZONE_TO_SUBUNIT: Record<string, string> = { zone2: "ZONE2", zone3: "ZONE3", zone4: "ZONE4" };
const SUBUNIT_TO_PREFIX: Record<string, string> = { MAIN: "", ZONE2: "zone2.", ZONE3: "zone3.", ZONE4: "zone4." };

/**
 * Map a unified state write to a YNCA command.
 *
 * @param stateId the state id (e.g. `power`, `zone2.volume`)
 * @param value the value written to the state
 * @returns the YNCA triple to send, or undefined if the state is not mapped
 */
export function stateToYnca(stateId: string, value: unknown): YncaTriple | undefined {
  let subunit = "MAIN";
  let name = stateId;
  const dot = stateId.indexOf(".");
  if (dot > 0) {
    const zone = ZONE_TO_SUBUNIT[stateId.slice(0, dot)];
    if (!zone) {
      return undefined;
    }
    subunit = zone;
    name = stateId.slice(dot + 1);
  }
  const mapping = STATE_MAPPINGS[name];
  if (!mapping) {
    return undefined;
  }
  return { subunit, func: mapping.func, value: mapping.toYnca(value) };
}

/**
 * Map a YNCA message to a unified state update.
 *
 * @param message the decoded YNCA message
 * @returns the state id and typed value, or undefined if not mapped
 */
export function yncaToState(message: YncaTriple): StateValue | undefined {
  const prefix = SUBUNIT_TO_PREFIX[message.subunit];
  if (prefix === undefined) {
    return undefined;
  }
  for (const [name, mapping] of Object.entries(STATE_MAPPINGS)) {
    if (mapping.func === message.func) {
      return { id: `${prefix}${name}`, value: mapping.fromYnca(message.value) };
    }
  }
  return undefined;
}
