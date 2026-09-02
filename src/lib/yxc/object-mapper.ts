import { CHANNEL_NAME_KEYS, type ObjectDef } from "../catalog/types";
import { tName, type I18nKey } from "../i18n";
import { YXC_ZONE_IDS, zonePrefix } from "./zones";
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
const ZONES: Array<{ id: string; prefix: string }> = YXC_ZONE_IDS.map(id => ({ id, prefix: zonePrefix(id) }));

/** The "now playing" block's states (v2.0.0, one per zone): read metadata + transport buttons. */
const PLAYER_STATES: Array<{ state: string; common: Omit<ObjectDef["common"], "name"> & { nameKey: I18nKey } }> = [
  {
    // What the zone is playing (the netusb source name, or `cd`) — read-only display;
    // switching happens over the zone's `input` state.
    state: "source",
    common: { nameKey: "Playing source", type: "string", role: "text", read: true, write: false },
  },
  {
    state: "playback",
    common: {
      // media.state is a number in the type-detector; the same 0/1/2 coding as the YNCA player.
      nameKey: "Playback",
      type: "number",
      role: "media.state",
      read: true,
      write: false,
      states: { 0: "Play", 1: "Stop", 2: "Pause" },
    },
  },
  { state: "artist", common: { nameKey: "Artist", type: "string", role: "media.artist", read: true, write: false } },
  { state: "album", common: { nameKey: "Album", type: "string", role: "media.album", read: true, write: false } },
  { state: "track", common: { nameKey: "Track", type: "string", role: "media.title", read: true, write: false } },
  // Read-only playback metadata, typed exactly like the YNCA sources so both players
  // present the same shape on one device: repeat as the media.mode.repeat number code
  // (wire off/one/all, captures-verified), shuffle as a media.mode.shuffle boolean
  // (wire knows only off/on). Writing stays with the toggle buttons — YXC has no setter.
  {
    state: "repeat",
    common: {
      nameKey: "Repeat",
      type: "number",
      role: "media.mode.repeat",
      read: true,
      write: false,
      states: { 0: "Off", 1: "Single", 2: "All" },
    },
  },
  {
    state: "shuffle",
    common: { nameKey: "Shuffle", type: "boolean", role: "media.mode.shuffle", read: true, write: false },
  },
  {
    state: "elapsedTime",
    common: { nameKey: "Elapsed time", type: "number", unit: "s", role: "media.elapsed", read: true, write: false },
  },
  {
    state: "totalTime",
    common: { nameKey: "Total time", type: "number", unit: "s", role: "media.duration", read: true, write: false },
  },
  {
    state: "albumArt",
    common: { nameKey: "Album art", type: "string", role: "media.cover", read: true, write: false },
  },
  // Transport buttons carry the type-detector media-player roles so a MusicCast player's
  // controls are recognised as play/pause/stop/next/prev, not generic buttons.
  { state: "play", common: { nameKey: "Play", type: "boolean", role: "button.play", read: false, write: true } },
  { state: "pause", common: { nameKey: "Pause", type: "boolean", role: "button.pause", read: false, write: true } },
  { state: "stop", common: { nameKey: "Stop", type: "boolean", role: "button.stop", read: false, write: true } },
  { state: "next", common: { nameKey: "Next", type: "boolean", role: "button.next", read: false, write: true } },
  { state: "prev", common: { nameKey: "Previous", type: "boolean", role: "button.prev", read: false, write: true } },
  {
    state: "repeatToggle",
    common: { nameKey: "Toggle repeat", type: "boolean", role: "button", read: false, write: true },
  },
  {
    state: "shuffleToggle",
    common: { nameKey: "Toggle shuffle", type: "boolean", role: "button", read: false, write: true },
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
function pushPlayerBlock(objects: ObjectDef[], prefix: string, channelName: ioBroker.StringOrTranslated): void {
  objects.push({ id: prefix, type: "channel", common: { name: channelName } });
  for (const player of PLAYER_STATES) {
    const { nameKey: playerNameKey, ...playerCommon } = player.common;
    objects.push({
      id: `${prefix}.${player.state}`,
      type: "state",
      common: { ...playerCommon, name: tName(playerNameKey) },
    });
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
    // Every parent — the zone channel included — is created by the per-state loop and
    // named from the shared CHANNEL_NAMES table (a zone exists only with an entry).
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
            common: {
              name: CHANNEL_NAME_KEYS[segment]
                ? tName(CHANNEL_NAME_KEYS[segment])
                : segment.charAt(0).toUpperCase() + segment.slice(1),
            },
          });
        }
      }
      const { nameKey: entryNameKey, ...entryRest } = entry.common;
      const common: ObjectDef["common"] = { ...entryRest, name: tName(entryNameKey) };
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
    const zoneChannelHelper = (id: string, name: ioBroker.StringOrTranslated): void => {
      if (!channels.has(id)) {
        channels.add(id);
        objects.push({ id, type: "channel", common: { name } });
      }
    };
    // Scene recall (#615): the zone declares `scene` + scene_num — per zone, so a
    // Zone-2 scene is first-class (the RX-V6A declares 8 for main AND zone2).
    if (zone.funcs.includes("scene") && zone.sceneNum && zone.sceneNum > 0) {
      zoneChannelHelper(`${zoneDef.prefix}scene`, tName(CHANNEL_NAME_KEYS.scene ?? "Scenes"));
      objects.push({
        id: `${zoneDef.prefix}scene.recall`,
        type: "state",
        common: {
          name: tName("Recall scene"),
          type: "number",
          role: "level",
          read: true,
          write: true,
          min: 1,
          max: zone.sceneNum,
          step: 1,
        },
      });
    }
    // The on-screen remote (cursor pad + menu keys) — declared as zone functions
    // `cursor`/`menu`; the endpoints and their vocabulary are device-verified.
    if (zone.funcs.includes("cursor") || zone.funcs.includes("menu")) {
      zoneChannelHelper(`${zoneDef.prefix}remote`, tName(CHANNEL_NAME_KEYS.remote ?? "Remote control"));
      if (zone.funcs.includes("cursor")) {
        objects.push({
          id: `${zoneDef.prefix}remote.cursor`,
          type: "state",
          common: {
            name: tName("Cursor pad"),
            type: "string",
            role: "state",
            read: false,
            write: true,
            states: selfMap(["up", "down", "left", "right", "select", "return"]),
          },
        });
      }
      if (zone.funcs.includes("menu")) {
        objects.push({
          id: `${zoneDef.prefix}remote.menu`,
          type: "state",
          common: {
            name: tName("Menu key"),
            type: "string",
            role: "state",
            read: false,
            write: true,
            states: selfMap(["on_screen", "top_menu", "menu", "option", "display", "home"]),
          },
        });
      }
    }
    // The audio-signal info (own endpoint, declared as `signal_info`): what the zone
    // currently decodes — format, sampling rate, bit depth, bitrate.
    if (zone.funcs.includes("signal_info")) {
      zoneChannelHelper(`${zoneDef.prefix}sound`, tName(CHANNEL_NAME_KEYS.sound ?? "Sound"));
      zoneChannelHelper(`${zoneDef.prefix}sound.signal`, tName(CHANNEL_NAME_KEYS.signal ?? "Audio signal"));
      const signal = (
        id: string,
        name: ioBroker.StringOrTranslated,
        type: "string" | "number",
        role: "text" | "value",
      ): void => {
        objects.push({
          id: `${zoneDef.prefix}sound.signal.${id}`,
          type: "state",
          common: { name, type, role, read: true, write: false },
        });
      };
      signal("format", tName("Audio signal format"), "string", "text");
      signal("sampling", tName("Audio sampling rate"), "string", "text");
      signal("bits", tName("Audio bit depth"), "string", "text");
      signal("bitrate", tName("Audio bitrate"), "number", "value");
    }
  }
  if (capabilities.media.includes("netusb") || capabilities.media.includes("cd")) {
    // ONE "now playing" block per zone (v2.0.0): the controller feeds it from
    // whichever source the zone is listening to (netusb or cd) and clears it on a
    // source switch. The source folders below keep only their genuinely own states.
    pushPlayerBlock(objects, "player", tName("Media player"));
    for (const zone of capabilities.zones) {
      if (zone.id !== "main") {
        pushPlayerBlock(objects, `${zonePrefix(zone.id)}player`, tName("Media player"));
      }
    }
  }
  if (capabilities.media.includes("netusb")) {
    objects.push({ id: "player.netPlayer", type: "channel", common: { name: tName("Network player") } });
    objects.push({
      id: "player.netPlayer.preset",
      type: "state",
      common: { name: tName("Recall preset"), type: "number", role: "level", read: true, write: true, min: 1 },
    });
    // The favourites and recently-played lists (names included) plus the recall-by-number
    // for recents — the musiccast adapter's selection surface, on our tree.
    objects.push({
      id: "player.netPlayer.presets",
      type: "state",
      common: { name: tName("Favourites (stored presets)"), type: "string", role: "json", read: true, write: false },
    });
    objects.push({
      id: "player.netPlayer.recent",
      type: "state",
      common: { name: tName("Recently played"), type: "string", role: "json", read: true, write: false },
    });
    objects.push({
      id: "player.netPlayer.recallRecent",
      type: "state",
      common: {
        name: tName("Recall recently played (number)"),
        type: "number",
        role: "level",
        read: true,
        write: true,
        min: 1,
      },
    });
    // MusicCast playlists and the play queue — declared in the netusb func_list.
    // Read-only surfaces: no write path for them is documented anywhere, and blind
    // writes are exactly what this adapter no longer does.
    if (capabilities.netusbFuncs?.includes("mc_playlist")) {
      objects.push({
        id: "player.netPlayer.playlists",
        type: "state",
        common: { name: tName("MusicCast playlists"), type: "string", role: "json", read: true, write: false },
      });
    }
    if (capabilities.netusbFuncs?.includes("play_queue")) {
      objects.push({
        id: "player.netPlayer.queue",
        type: "state",
        common: { name: tName("Play queue"), type: "string", role: "json", read: true, write: false },
      });
    }
  }
  if (capabilities.media.includes("cd")) {
    // Drive-own states only — what the disc is PLAYING shows in the flat block above.
    objects.push({ id: "player.cd", type: "channel", common: { name: tName("CD") } });
    objects.push({
      id: "player.cd.tray",
      type: "state",
      common: { name: tName("Toggle tray"), type: "boolean", role: "button", read: false, write: true },
    });
    objects.push({
      id: "player.cd.trackNumber",
      type: "state",
      common: { name: tName("Track number"), type: "number", role: "value", read: true, write: false },
    });
    objects.push({
      id: "player.cd.totalTracks",
      type: "state",
      common: { name: tName("Total tracks"), type: "number", role: "value", read: true, write: false },
    });
    objects.push({
      id: "player.cd.discTime",
      type: "state",
      common: { name: tName("Disc time"), type: "number", unit: "s", role: "value", read: true, write: false },
    });
    objects.push({
      id: "player.cd.deviceStatus",
      type: "state",
      common: { name: tName("Drive status"), type: "string", role: "state", read: true, write: false },
    });
  }
  if (capabilities.media.includes("tuner")) {
    objects.push({ id: "tuner", type: "channel", common: { name: tName("Tuner") } });
    const bandCommon: ObjectDef["common"] = {
      name: tName("Band"),
      type: "string",
      role: "state",
      read: true,
      write: true,
    };
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
      common: { name: tName("Frequency"), type: "number", unit: "kHz", role: "level", read: true, write: true },
    });
    objects.push({
      id: "tuner.rdsText",
      type: "state",
      common: { name: tName("RDS text"), type: "string", role: "text", read: true, write: false },
    });
    objects.push({
      id: "tuner.rdsTextB",
      type: "state",
      common: { name: tName("RDS text B"), type: "string", role: "text", read: true, write: false },
    });
    objects.push({
      id: "tuner.rdsService",
      type: "state",
      common: { name: tName("RDS station"), type: "string", role: "text", read: true, write: false },
    });
    objects.push({
      id: "tuner.rdsProgramType",
      type: "state",
      common: { name: tName("RDS programme type"), type: "string", role: "text", read: true, write: false },
    });
    // The stored-station surface: recall by number (writable), the active slot read back
    // from play info, up/down stepping, and the stored lists (with what the device knows
    // about each slot) as JSON — the selection surface the musiccast adapter offered.
    const presetCommon: ObjectDef["common"] = {
      name: tName("Preset (recall by number)"),
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
      common: { name: tName("Next preset"), type: "boolean", role: "button", read: false, write: true },
    });
    objects.push({
      id: "tuner.presetDown",
      type: "state",
      common: { name: tName("Previous preset"), type: "boolean", role: "button", read: false, write: true },
    });
    objects.push({
      id: "tuner.presets",
      type: "state",
      common: { name: tName("Stored presets"), type: "string", role: "json", read: true, write: false },
    });
    objects.push({
      id: "tuner.tuned",
      type: "state",
      common: { name: tName("Tuned"), type: "boolean", role: "indicator", read: true, write: false },
    });
    objects.push({
      id: "tuner.audioMode",
      type: "state",
      common: { name: tName("Audio mode"), type: "string", role: "state", read: true, write: false },
    });
    if (bands.includes("dab")) {
      objects.push({ id: "tuner.dab", type: "channel", common: { name: tName("DAB") } });
      for (const field of DAB_FIELDS) {
        objects.push({
          id: field.id,
          type: "state",
          common: {
            name: tName(field.nameKey),
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
    objects.push({ id: "clock", type: "channel", common: { name: tName("Clock & alarm") } });
    objects.push({
      id: "clock.autoSync",
      type: "state",
      common: { name: tName("Automatic time sync"), type: "boolean", role: "indicator", read: true, write: false },
    });
    objects.push({
      id: "clock.format",
      type: "state",
      common: { name: tName("Clock format"), type: "string", role: "state", read: true, write: false },
    });
    objects.push({ id: "clock.alarm", type: "channel", common: { name: tName("Alarm") } });
    objects.push({
      id: "clock.alarm.on",
      type: "state",
      common: { name: tName("Alarm armed"), type: "boolean", role: "indicator", read: true, write: false },
    });
    const volumeCommon: ObjectDef["common"] = {
      name: tName("Alarm volume"),
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
      common: { name: tName("Fade-in time"), type: "number", unit: "s", role: "value", read: true, write: false },
    });
    objects.push({
      id: "clock.alarm.fadeType",
      type: "state",
      common: { name: tName("Fade type"), type: "number", role: "value", read: true, write: false },
    });
    objects.push({
      id: "clock.alarm.mode",
      type: "state",
      common: { name: tName("Alarm mode"), type: "string", role: "state", read: true, write: false },
    });
    objects.push({
      id: "clock.alarm.repeat",
      type: "state",
      common: { name: tName("Repeat (snooze)"), type: "boolean", role: "indicator", read: true, write: false },
    });
    const detailChannels = ["oneday", ...(capabilities.clock.alarmModes.includes("weekly") ? ALARM_DAYS : [])];
    for (const channel of detailChannels) {
      // The weekday channels are named by the device; only the fixed one-day channel translates.
      const label: ioBroker.StringOrTranslated =
        channel === "oneday" ? tName("One-day alarm") : channel.charAt(0).toUpperCase() + channel.slice(1);
      objects.push({ id: `clock.alarm.${channel}`, type: "channel", common: { name: label } });
      const detail = (
        id: string,
        name: ioBroker.StringOrTranslated,
        type: "boolean" | "number" | "string",
        role: string,
      ): void => {
        objects.push({
          id: `clock.alarm.${channel}.${id}`,
          type: "state",
          common: { name, type, role, read: true, write: false },
        });
      };
      detail("enable", tName("Enabled"), "boolean", "indicator");
      detail("time", tName("Alarm time"), "string", "text");
      detail("beep", tName("Beep"), "boolean", "indicator");
      detail("playbackType", tName("Playback type"), "string", "state");
      detail("resumeInput", tName("Resume input"), "string", "state");
      detail("presetType", tName("Preset type"), "string", "state");
      detail("presetNumber", tName("Preset number"), "number", "value");
      detail("presetInput", tName("Preset source"), "string", "state");
    }
  }
  if (capabilities.hasDistribution) {
    // The MusicCast-Link states live in their own folder so the tree itself tells the
    // scope: directly under multiroom = all zones of this device, group = linked devices.
    // Both channels already exist: the main zone's always-created
    // multiroom.group.streamingEnabled state brought them in through the parent loop.
    const distState = (id: string, name: ioBroker.StringOrTranslated, role: string): void => {
      objects.push({
        id: `multiroom.group.${id}`,
        type: "state",
        common: { name, type: "string", role, read: true, write: false },
      });
    };
    distState("role", tName("Role (server/client)"), "state");
    distState("id", tName("Group ID"), "text");
    distState("name", tName("Group name"), "text");
    distState("serverZone", tName("Server zone (feeds the group)"), "text");
    distState("linkedDevices", tName("Linked devices"), "json");
    objects.push({
      id: "multiroom.group.leave",
      type: "state",
      common: { name: tName("Leave group"), type: "boolean", role: "button", read: false, write: true },
    });
    objects.push({
      id: "multiroom.group.linkDevice",
      type: "state",
      common: { name: tName("Link a device (its IP)"), type: "string", role: "text", read: false, write: true },
    });
  }
  return objects;
}
