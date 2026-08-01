import type { ObjectDef } from "../capability-mapper";
import type { YxcCapabilities } from "./capability";

// NOTE: the state commons here mirror the YNCA mapper's amp states (same roles/
// types). A shared unified-state catalog is a deliberate cleanup for hardening.

/** YXC function → unified state with its common. */
const YXC_STATES: Array<{ func: string; state: string; common: ObjectDef["common"] }> = [
  {
    func: "power",
    state: "power",
    common: { name: "Power", type: "boolean", role: "switch.power", read: true, write: true },
  },
  {
    func: "volume",
    state: "volume",
    common: { name: "Volume", type: "number", role: "level.volume", read: true, write: true },
  },
  {
    func: "mute",
    state: "mute",
    common: { name: "Mute", type: "boolean", role: "media.mute", read: true, write: true },
  },
  {
    func: "sound_program",
    state: "soundProgram",
    common: { name: "Sound program", type: "string", role: "state", read: true, write: true },
  },
];

/** Input is derived from the zone's input_list, not from func_list. */
const INPUT_COMMON: ObjectDef["common"] = {
  name: "Input",
  type: "string",
  role: "media.input",
  read: true,
  write: true,
};

/** The zones the adapter maps: main flat, zone2-4 each under their own channel. */
const ZONES: Array<{ id: string; prefix: string; channel?: string; channelName?: string }> = [
  { id: "main", prefix: "" },
  { id: "zone2", prefix: "zone2.", channel: "zone2", channelName: "Zone 2" },
  { id: "zone3", prefix: "zone3.", channel: "zone3", channelName: "Zone 3" },
  { id: "zone4", prefix: "zone4.", channel: "zone4", channelName: "Zone 4" },
];

/**
 * Turn YXC capabilities into the unified object tree: main's functions as
 * top-level states, each additional zone as a channel with its own states. An
 * input state is added when the zone offers inputs. Only reported functions are
 * created, parents before children.
 *
 * @param capabilities the parsed YXC capabilities
 * @returns the object definitions to create
 */
export function mapYxcToObjects(capabilities: YxcCapabilities): ObjectDef[] {
  const objects: ObjectDef[] = [];
  for (const zoneDef of ZONES) {
    const zone = capabilities.zones.find(z => z.id === zoneDef.id);
    if (!zone) {
      continue;
    }
    const states = YXC_STATES.filter(state => zone.funcs.includes(state.func));
    const hasInput = zone.inputs.length > 0;
    if (states.length === 0 && !hasInput) {
      continue;
    }
    if (zoneDef.channel) {
      objects.push({ id: zoneDef.channel, type: "channel", common: { name: zoneDef.channelName ?? zoneDef.channel } });
    }
    for (const state of states) {
      const common = { ...state.common };
      if (state.state === "volume" && zone.volumeRange) {
        common.min = zone.volumeRange.min;
        common.max = zone.volumeRange.max;
        common.step = zone.volumeRange.step;
      }
      objects.push({ id: `${zoneDef.prefix}${state.state}`, type: "state", common });
    }
    if (hasInput) {
      objects.push({ id: `${zoneDef.prefix}input`, type: "state", common: { ...INPUT_COMMON } });
    }
  }
  return objects;
}
