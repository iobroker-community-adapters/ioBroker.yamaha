import type { YncaCapabilities } from "./ynca/capability";

/** An object to create in the device tree: a state or a channel. */
export interface ObjectDef {
  /** Object id relative to the device (e.g. `power`, `zone2`, `zone2.power`). */
  id: string;
  /** Object kind. */
  type: "state" | "channel";
  /** ioBroker common part. */
  common: {
    name: string;
    type?: "boolean" | "number" | "string";
    role?: string;
    read?: boolean;
    write?: boolean;
    unit?: string;
    min?: number;
    max?: number;
    step?: number;
  };
}

/** Amplifier functions shared by MAIN and the zones, mapped to unified states. */
const AMP_STATES: Array<{ func: string; state: string; common: ObjectDef["common"] }> = [
  {
    func: "PWR",
    state: "power",
    common: { name: "Power", type: "boolean", role: "switch.power", read: true, write: true },
  },
  {
    func: "VOL",
    state: "volume",
    common: { name: "Volume", type: "number", role: "level.volume", read: true, write: true, unit: "dB" },
  },
  {
    func: "MUTE",
    state: "mute",
    common: { name: "Mute", type: "boolean", role: "media.mute", read: true, write: true },
  },
  {
    func: "INP",
    state: "input",
    common: { name: "Input", type: "string", role: "media.input", read: true, write: true },
  },
  {
    func: "SOUNDPRG",
    state: "soundProgram",
    common: { name: "Sound program", type: "string", role: "state", read: true, write: true },
  },
];

/** The zones the adapter maps: MAIN flat, ZONE2-4 each under their own channel. */
const ZONES: Array<{ subunit: string; prefix: string; channel?: string; channelName?: string }> = [
  { subunit: "MAIN", prefix: "" },
  { subunit: "ZONE2", prefix: "zone2.", channel: "zone2", channelName: "Zone 2" },
  { subunit: "ZONE3", prefix: "zone3.", channel: "zone3", channelName: "Zone 3" },
  { subunit: "ZONE4", prefix: "zone4.", channel: "zone4", channelName: "Zone 4" },
];

/**
 * Turn a YNCA capability report into the unified object tree: MAIN's amplifier
 * functions as top-level states, each additional zone as a channel with its own
 * states. Only functions the device actually reported are included, parents first.
 *
 * @param capabilities the parsed YNCA capabilities
 * @returns the object definitions to create
 */
export function mapYncaToObjects(capabilities: YncaCapabilities): ObjectDef[] {
  const objects: ObjectDef[] = [];
  for (const zone of ZONES) {
    const funcs = capabilities.subunits[zone.subunit];
    if (!funcs) {
      continue;
    }
    const applicable = AMP_STATES.filter(def => def.func in funcs);
    if (applicable.length === 0) {
      continue;
    }
    if (zone.channel) {
      objects.push({ id: zone.channel, type: "channel", common: { name: zone.channelName ?? zone.channel } });
    }
    for (const def of applicable) {
      objects.push({ id: `${zone.prefix}${def.state}`, type: "state", common: { ...def.common } });
    }
  }
  return objects;
}
