import { CHANNEL_NAMES, type ObjectDef } from "../catalog/types";
import type { YxcCapabilities } from "./capability";
import { YXC_AMP_CATALOG } from "./catalog";
import { ALARM_DAYS, DAB_FIELDS } from "./command-mapper";

/**
 * Build a value → label dropdown map from a device-reported value list.
 *
 * @param values the allowed values
 * @returns the states map
 */
function selfMap(values: readonly string[]): Record<string, string> {
  return Object.fromEntries(values.map(value => [value, value]));
}

/** The zones the adapter maps: main flat, zone2-4 each under multiroom. */
const ZONES: Array<{ id: string; prefix: string; channel?: string; channelName?: string }> = [
  { id: "main", prefix: "" },
  { id: "zone2", prefix: "multiroom.zone2.", channel: "multiroom.zone2", channelName: "Zone 2" },
  { id: "zone3", prefix: "multiroom.zone3.", channel: "multiroom.zone3", channelName: "Zone 3" },
  { id: "zone4", prefix: "multiroom.zone4.", channel: "multiroom.zone4", channelName: "Zone 4" },
];

/** Media-player states shared by every player source (netusb, cd): read metadata + transport buttons. */
const PLAYER_STATES: Array<{ state: string; common: ObjectDef["common"] }> = [
  {
    state: "playback",
    common: {
      // media.state is a number in the type-detector; the same 0/1/2 coding as the YNCA player.
      name: "Playback",
      type: "number",
      role: "media.state",
      read: true,
      write: false,
      states: { 0: "Play", 1: "Stop", 2: "Pause" },
    },
  },
  { state: "artist", common: { name: "Artist", type: "string", role: "media.artist", read: true, write: false } },
  { state: "album", common: { name: "Album", type: "string", role: "media.album", read: true, write: false } },
  { state: "track", common: { name: "Track", type: "string", role: "media.title", read: true, write: false } },
  // Read-only playback metadata, typed exactly like the YNCA sources so both players
  // present the same shape on one device: repeat as the media.mode.repeat number code
  // (wire off/one/all, captures-verified), shuffle as a media.mode.shuffle boolean
  // (wire knows only off/on). Writing stays with the toggle buttons — YXC has no setter.
  {
    state: "repeat",
    common: {
      name: "Repeat",
      type: "number",
      role: "media.mode.repeat",
      read: true,
      write: false,
      states: { 0: "Off", 1: "Single", 2: "All" },
    },
  },
  {
    state: "shuffle",
    common: { name: "Shuffle", type: "boolean", role: "media.mode.shuffle", read: true, write: false },
  },
  {
    state: "elapsedTime",
    common: { name: "Elapsed time", type: "number", unit: "s", role: "media.elapsed", read: true, write: false },
  },
  {
    state: "totalTime",
    common: { name: "Total time", type: "number", unit: "s", role: "media.duration", read: true, write: false },
  },
  { state: "albumArt", common: { name: "Album art", type: "string", role: "media.cover", read: true, write: false } },
  // Transport buttons carry the type-detector media-player roles so a MusicCast player's
  // controls are recognised as play/pause/stop/next/prev, not generic buttons.
  { state: "play", common: { name: "Play", type: "boolean", role: "button.play", read: false, write: true } },
  { state: "pause", common: { name: "Pause", type: "boolean", role: "button.pause", read: false, write: true } },
  { state: "stop", common: { name: "Stop", type: "boolean", role: "button.stop", read: false, write: true } },
  { state: "next", common: { name: "Next", type: "boolean", role: "button.next", read: false, write: true } },
  { state: "prev", common: { name: "Previous", type: "boolean", role: "button.prev", read: false, write: true } },
  {
    state: "repeatToggle",
    common: { name: "Toggle repeat", type: "boolean", role: "button", read: false, write: true },
  },
  {
    state: "shuffleToggle",
    common: { name: "Toggle shuffle", type: "boolean", role: "button", read: false, write: true },
  },
];

/**
 * Append a media-player block (channel + the shared player states) under a
 * dotted prefix. Used for every player source the device reports.
 *
 * @param objects the object list to append to
 * @param prefix the channel/state prefix (e.g. `netPlayer`, `cd`)
 * @param channelName the human-readable channel name
 */
function pushPlayerBlock(objects: ObjectDef[], prefix: string, channelName: string): void {
  objects.push({ id: prefix, type: "channel", common: { name: channelName } });
  for (const player of PLAYER_STATES) {
    objects.push({ id: `${prefix}.${player.state}`, type: "state", common: { ...player.common } });
  }
}

/**
 * Turn YXC capabilities into the unified object tree: main's functions as
 * top-level states, each additional zone as a channel with its own states. An
 * input state is added when the zone offers inputs. Player sources (netusb, cd)
 * and the tuner get their own channel. Only reported functions are created,
 * parents before children. States and their common come from {@link YXC_AMP_CATALOG}.
 *
 * @param capabilities the parsed YXC capabilities
 * @returns the object definitions to create
 */
export function mapYxcToObjects(capabilities: YxcCapabilities): ObjectDef[] {
  const objects: ObjectDef[] = [];
  const channels = new Set<string>();
  for (const zoneDef of ZONES) {
    const zone = capabilities.zones.find(z => z.id === zoneDef.id);
    if (!zone) {
      continue;
    }
    const hasInput = zone.inputs.length > 0;
    const entries = YXC_AMP_CATALOG.filter(entry => {
      // Device-global entries (id under multiroom.) exist once — never as a per-zone copy.
      if (zoneDef.id !== "main" && entry.state.startsWith("multiroom.")) {
        return false;
      }
      if (entry.create.kind === "always") {
        return true;
      }
      if (entry.create.kind === "input") {
        return hasInput;
      }
      return zone.funcs.includes(entry.create.func);
    });
    // A zone needs an advertised function or an input to exist — the "always" status
    // fields alone (which every entry set contains) do not create a zone.
    if (!entries.some(entry => entry.create.kind !== "always")) {
      continue;
    }
    if (zoneDef.channel) {
      const chSegments = zoneDef.channel.split(".");
      for (let i = 1; i < chSegments.length; i++) {
        const parentId = chSegments.slice(0, i).join(".");
        if (!channels.has(parentId)) {
          channels.add(parentId);
          const seg = chSegments[i - 1];
          objects.push({
            id: parentId,
            type: "channel",
            common: { name: CHANNEL_NAMES[seg] ?? seg.charAt(0).toUpperCase() + seg.slice(1) },
          });
        }
      }
      channels.add(zoneDef.channel);
      objects.push({ id: zoneDef.channel, type: "channel", common: { name: zoneDef.channelName ?? zoneDef.channel } });
    }
    for (const entry of entries) {
      const fullId = `${zoneDef.prefix}${entry.state}`;
      const segments = fullId.split(".");
      for (let i = 1; i < segments.length; i++) {
        const channelId = segments.slice(0, i).join(".");
        if (!channels.has(channelId)) {
          channels.add(channelId);
          const segment = segments[i - 1];
          objects.push({
            id: channelId,
            type: "channel",
            common: { name: CHANNEL_NAMES[segment] ?? segment.charAt(0).toUpperCase() + segment.slice(1) },
          });
        }
      }
      const common = { ...entry.common };
      if (entry.state === "volume" && zone.volumeRange) {
        common.min = zone.volumeRange.min;
        common.max = zone.volumeRange.max;
        common.step = zone.volumeRange.step;
      }
      // The device's own allowed-value lists (getFeatures) become dropdowns: the zone's
      // inputs on the input state, sound_program_list & co on their states. On a device
      // that also speaks YNCA the YNCA-owned dropdown wins via the owner policy — these
      // matter on MusicCast-only devices, where the raw string was the old poverty.
      if (entry.state === "input" && zone.inputs.length > 0) {
        common.states = selfMap(zone.inputs);
      }
      const valueList = zone.valueLists?.[entry.state];
      if (valueList) {
        common.states = selfMap(valueList);
      }
      objects.push({ id: fullId, type: "state", common });
    }
  }
  if (capabilities.media.includes("netusb") || capabilities.media.includes("cd")) {
    objects.push({ id: "player", type: "channel", common: { name: "Media player" } });
  }
  if (capabilities.media.includes("netusb")) {
    pushPlayerBlock(objects, "player.netPlayer", "Network player");
    objects.push({
      id: "player.netPlayer.preset",
      type: "state",
      common: { name: "Recall preset", type: "number", role: "level", read: true, write: true, min: 1 },
    });
    // The favourites and recently-played lists (names included) plus the recall-by-number
    // for recents — the musiccast adapter's selection surface, on our tree.
    objects.push({
      id: "player.netPlayer.presets",
      type: "state",
      common: { name: "Favourites (stored presets)", type: "string", role: "json", read: true, write: false },
    });
    objects.push({
      id: "player.netPlayer.recent",
      type: "state",
      common: { name: "Recently played", type: "string", role: "json", read: true, write: false },
    });
    objects.push({
      id: "player.netPlayer.recallRecent",
      type: "state",
      common: {
        name: "Recall recently played (number)",
        type: "number",
        role: "level",
        read: true,
        write: true,
        min: 1,
      },
    });
    objects.push({
      id: "player.netPlayer.source",
      type: "state",
      common: { name: "Active network source", type: "string", role: "text", read: true, write: false },
    });
  }
  if (capabilities.media.includes("cd")) {
    pushPlayerBlock(objects, "player.cd", "CD");
    objects.push({
      id: "player.cd.tray",
      type: "state",
      common: { name: "Toggle tray", type: "boolean", role: "button", read: false, write: true },
    });
    objects.push({
      id: "player.cd.trackNumber",
      type: "state",
      common: { name: "Track number", type: "number", role: "value", read: true, write: false },
    });
    objects.push({
      id: "player.cd.totalTracks",
      type: "state",
      common: { name: "Total tracks", type: "number", role: "value", read: true, write: false },
    });
    objects.push({
      id: "player.cd.discTime",
      type: "state",
      common: { name: "Disc time", type: "number", unit: "s", role: "value", read: true, write: false },
    });
    objects.push({
      id: "player.cd.deviceStatus",
      type: "state",
      common: { name: "Drive status", type: "string", role: "state", read: true, write: false },
    });
  }
  if (capabilities.media.includes("tuner")) {
    objects.push({ id: "tuner", type: "channel", common: { name: "Tuner" } });
    const bandCommon: ObjectDef["common"] = { name: "Band", type: "string", role: "state", read: true, write: true };
    const bands = capabilities.tuner?.bands ?? [];
    if (bands.length > 0) {
      bandCommon.states = selfMap(bands);
    }
    objects.push({ id: "tuner.band", type: "state", common: bandCommon });
    // Frequency in kHz — FM/AM/DAB all report kHz in getPlayInfo (FM 100900 =
    // 100.9 MHz, AM 1080, DAB 180064), verified against real device captures.
    objects.push({
      id: "tuner.frequency",
      type: "state",
      common: { name: "Frequency", type: "number", unit: "kHz", role: "level", read: true, write: true },
    });
    objects.push({
      id: "tuner.rdsText",
      type: "state",
      common: { name: "RDS text", type: "string", role: "text", read: true, write: false },
    });
    objects.push({
      id: "tuner.rdsTextB",
      type: "state",
      common: { name: "RDS text B", type: "string", role: "text", read: true, write: false },
    });
    objects.push({
      id: "tuner.rdsService",
      type: "state",
      common: { name: "RDS station", type: "string", role: "text", read: true, write: false },
    });
    objects.push({
      id: "tuner.rdsProgramType",
      type: "state",
      common: { name: "RDS programme type", type: "string", role: "text", read: true, write: false },
    });
    // The stored-station surface: recall by number (writable), the active slot read back
    // from play info, up/down stepping, and the stored lists (with what the device knows
    // about each slot) as JSON — the selection surface the musiccast adapter offered.
    const presetCommon: ObjectDef["common"] = {
      name: "Preset (recall by number)",
      type: "number",
      role: "level",
      read: true,
      write: true,
      min: 0,
    };
    if (capabilities.tuner?.presetNum) {
      presetCommon.max = capabilities.tuner.presetNum;
    }
    objects.push({ id: "tuner.preset", type: "state", common: presetCommon });
    objects.push({
      id: "tuner.presetUp",
      type: "state",
      common: { name: "Next preset", type: "boolean", role: "button", read: false, write: true },
    });
    objects.push({
      id: "tuner.presetDown",
      type: "state",
      common: { name: "Previous preset", type: "boolean", role: "button", read: false, write: true },
    });
    objects.push({
      id: "tuner.presets",
      type: "state",
      common: { name: "Stored presets", type: "string", role: "json", read: true, write: false },
    });
    objects.push({
      id: "tuner.tuned",
      type: "state",
      common: { name: "Tuned", type: "boolean", role: "indicator", read: true, write: false },
    });
    objects.push({
      id: "tuner.audioMode",
      type: "state",
      common: { name: "Audio mode", type: "string", role: "state", read: true, write: false },
    });
    if (bands.includes("dab")) {
      objects.push({ id: "tuner.dab", type: "channel", common: { name: "DAB" } });
      for (const field of DAB_FIELDS) {
        objects.push({
          id: field.id,
          type: "state",
          common: {
            name: field.name,
            type: field.type,
            role: field.type === "boolean" ? "indicator" : field.type === "number" ? "value" : "text",
            read: true,
            write: false,
          },
        });
      }
    }
  }
  if (capabilities.clock) {
    // The clock/alarm block, as the musiccast adapter showed it — read-only display
    // (the predecessor's clock datapoints had no working write path either); the
    // devices that report it are the desk-audio/clock models.
    objects.push({ id: "clock", type: "channel", common: { name: "Clock & alarm" } });
    objects.push({
      id: "clock.autoSync",
      type: "state",
      common: { name: "Automatic time sync", type: "boolean", role: "indicator", read: true, write: false },
    });
    objects.push({
      id: "clock.format",
      type: "state",
      common: { name: "Clock format", type: "string", role: "state", read: true, write: false },
    });
    objects.push({ id: "clock.alarm", type: "channel", common: { name: "Alarm" } });
    objects.push({
      id: "clock.alarm.on",
      type: "state",
      common: { name: "Alarm armed", type: "boolean", role: "indicator", read: true, write: false },
    });
    const volumeCommon: ObjectDef["common"] = {
      name: "Alarm volume",
      type: "number",
      role: "value",
      read: true,
      write: false,
    };
    if (capabilities.clock.alarmVolumeRange) {
      volumeCommon.min = capabilities.clock.alarmVolumeRange.min;
      volumeCommon.max = capabilities.clock.alarmVolumeRange.max;
    }
    objects.push({ id: "clock.alarm.volume", type: "state", common: volumeCommon });
    objects.push({
      id: "clock.alarm.fadeInterval",
      type: "state",
      common: { name: "Fade-in time", type: "number", unit: "s", role: "value", read: true, write: false },
    });
    objects.push({
      id: "clock.alarm.fadeType",
      type: "state",
      common: { name: "Fade type", type: "number", role: "value", read: true, write: false },
    });
    objects.push({
      id: "clock.alarm.mode",
      type: "state",
      common: { name: "Alarm mode", type: "string", role: "state", read: true, write: false },
    });
    objects.push({
      id: "clock.alarm.repeat",
      type: "state",
      common: { name: "Repeat (snooze)", type: "boolean", role: "indicator", read: true, write: false },
    });
    const detailChannels = ["oneday", ...(capabilities.clock.alarmModes.includes("weekly") ? ALARM_DAYS : [])];
    for (const channel of detailChannels) {
      const label = channel === "oneday" ? "One-day alarm" : channel.charAt(0).toUpperCase() + channel.slice(1);
      objects.push({ id: `clock.alarm.${channel}`, type: "channel", common: { name: label } });
      const detail = (id: string, name: string, type: "boolean" | "number" | "string", role: string): void => {
        objects.push({
          id: `clock.alarm.${channel}.${id}`,
          type: "state",
          common: { name, type, role, read: true, write: false },
        });
      };
      detail("enable", "Enabled", "boolean", "indicator");
      detail("time", "Alarm time", "string", "text");
      detail("beep", "Beep", "boolean", "indicator");
      detail("playbackType", "Playback type", "string", "state");
      detail("resumeInput", "Resume input", "string", "state");
      detail("presetType", "Preset type", "string", "state");
      detail("presetNumber", "Preset number", "number", "value");
      detail("presetInput", "Preset source", "string", "state");
    }
  }
  if (capabilities.hasDistribution) {
    if (!channels.has("multiroom")) {
      channels.add("multiroom");
      objects.push({ id: "multiroom", type: "channel", common: { name: "Multiroom" } });
    }
    // The MusicCast-Link states get their own folder so the tree itself tells the scope:
    // directly under multiroom = all zones of this device, group = linked devices.
    // (Unobservable today: the zone catalog carries multiroom.group.streamingEnabled,
    // so the generic parent loop above already created this channel — with the same
    // CHANNEL_NAMES.group name. Kept as the declaration; the loop is a derivation.)
    if (!channels.has("multiroom.group")) {
      channels.add("multiroom.group");
      objects.push({ id: "multiroom.group", type: "channel", common: { name: CHANNEL_NAMES.group } });
    }
    const distState = (id: string, name: string, role: string): void => {
      objects.push({
        id: `multiroom.group.${id}`,
        type: "state",
        common: { name, type: "string", role, read: true, write: false },
      });
    };
    distState("role", "Role (server/client)", "state");
    distState("id", "Group ID", "text");
    distState("name", "Group name", "text");
    distState("serverZone", "Server zone (feeds the group)", "text");
    distState("linkedDevices", "Linked devices", "json");
    objects.push({
      id: "multiroom.group.leave",
      type: "state",
      common: { name: "Leave group", type: "boolean", role: "button", read: false, write: true },
    });
    objects.push({
      id: "multiroom.group.linkDevice",
      type: "state",
      common: { name: "Link a device (its IP)", type: "string", role: "text", read: false, write: true },
    });
  }
  return objects;
}
