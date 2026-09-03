"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var object_mapper_exports = {};
__export(object_mapper_exports, {
  mapYxcToObjects: () => mapYxcToObjects
});
module.exports = __toCommonJS(object_mapper_exports);
var import_types = require("../catalog/types");
var import_i18n = require("../i18n");
var import_zones = require("./zones");
var import_catalog = require("./catalog");
var import_command_mapper = require("./command-mapper");
function selfMap(values) {
  return Object.fromEntries(values.map((value) => [value, value]));
}
const ZONES = import_zones.YXC_ZONE_IDS.map((id) => ({ id, prefix: (0, import_zones.zonePrefix)(id) }));
const PLAYER_STATES = [
  {
    // What the zone is playing (the netusb source name, or `cd`) — read-only display;
    // switching happens over the zone's `input` state.
    state: "source",
    common: { nameKey: "Playing source", type: "string", role: "text", read: true, write: false }
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
      states: { 0: "Play", 1: "Stop", 2: "Pause" }
    }
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
      states: { 0: "Off", 1: "Single", 2: "All" }
    }
  },
  {
    state: "shuffle",
    common: { nameKey: "Shuffle", type: "boolean", role: "media.mode.shuffle", read: true, write: false }
  },
  // Both forms of each time, from the one value the device reports: the seconds fill the
  // type detector's media-player slot (it takes nothing else), the text is what a
  // visualisation shows. The YNCA side publishes exactly the same pair, converted the other
  // way round — so the datapoints mean the same thing on every device.
  {
    state: "elapsedTime",
    common: { nameKey: "Elapsed time", type: "number", unit: "s", role: "media.elapsed", read: true, write: false }
  },
  {
    state: "elapsedTimeText",
    common: {
      nameKey: "Elapsed time (readable)",
      type: "string",
      role: "media.elapsed.text",
      read: true,
      write: false
    }
  },
  {
    state: "totalTime",
    common: { nameKey: "Total time", type: "number", unit: "s", role: "media.duration", read: true, write: false }
  },
  {
    state: "totalTimeText",
    common: { nameKey: "Total time (readable)", type: "string", role: "media.duration.text", read: true, write: false }
  },
  {
    state: "albumArt",
    common: { nameKey: "Album art", type: "string", role: "media.cover", read: true, write: false }
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
    common: { nameKey: "Toggle repeat", type: "boolean", role: "button", read: false, write: true }
  },
  {
    state: "shuffleToggle",
    common: { nameKey: "Toggle shuffle", type: "boolean", role: "button", read: false, write: true }
  }
];
function pushPlayerBlock(objects, prefix, channelName) {
  objects.push({ id: prefix, type: "channel", common: { name: channelName } });
  for (const player of PLAYER_STATES) {
    const { nameKey: playerNameKey, ...playerCommon } = player.common;
    objects.push({
      id: `${prefix}.${player.state}`,
      type: "state",
      common: { ...playerCommon, name: (0, import_i18n.tName)(playerNameKey) }
    });
  }
}
function mapYxcToObjects(capabilities) {
  var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j;
  const objects = [];
  const channels = /* @__PURE__ */ new Set();
  for (const zoneDef of ZONES) {
    const zone = capabilities.zones.find((z) => z.id === zoneDef.id);
    if (!zone) {
      continue;
    }
    const hasInput = zone.inputs.length > 0;
    const entries = import_catalog.YXC_AMP_CATALOG.filter((entry) => {
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
    if (!entries.some((entry) => entry.create.kind !== "always")) {
      continue;
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
            common: {
              name: import_types.CHANNEL_NAME_KEYS[segment] ? (0, import_i18n.tName)(import_types.CHANNEL_NAME_KEYS[segment]) : segment.charAt(0).toUpperCase() + segment.slice(1)
            }
          });
        }
      }
      const { nameKey: entryNameKey, ...entryRest } = entry.common;
      const common = { ...entryRest, name: (0, import_i18n.tName)(entryNameKey) };
      if (entry.state === "volume" && zone.volumeRange) {
        common.min = zone.volumeRange.min;
        common.max = zone.volumeRange.max;
        common.step = zone.volumeRange.step;
      }
      if (entry.state === "input" && zone.inputs.length > 0) {
        common.states = selfMap(zone.inputs);
      }
      const valueList = (_a = zone.valueLists) == null ? void 0 : _a[entry.state];
      if (valueList) {
        common.states = selfMap(valueList);
      }
      objects.push({ id: fullId, type: "state", common });
    }
    const zoneChannelHelper = (id, name) => {
      if (!channels.has(id)) {
        channels.add(id);
        objects.push({ id, type: "channel", common: { name } });
      }
    };
    if (zone.funcs.includes("scene") && zone.sceneNum && zone.sceneNum > 0) {
      zoneChannelHelper(`${zoneDef.prefix}scene`, (0, import_i18n.tName)((_b = import_types.CHANNEL_NAME_KEYS.scene) != null ? _b : "Scenes"));
      objects.push({
        id: `${zoneDef.prefix}scene.recall`,
        type: "state",
        common: {
          name: (0, import_i18n.tName)("Recall scene"),
          type: "number",
          role: "level",
          read: true,
          write: true,
          min: 1,
          max: zone.sceneNum,
          step: 1
        }
      });
    }
    if (zone.funcs.includes("cursor") || zone.funcs.includes("menu")) {
      zoneChannelHelper(`${zoneDef.prefix}remote`, (0, import_i18n.tName)((_c = import_types.CHANNEL_NAME_KEYS.remote) != null ? _c : "Remote control"));
      if (zone.funcs.includes("cursor")) {
        objects.push({
          id: `${zoneDef.prefix}remote.cursor`,
          type: "state",
          common: {
            name: (0, import_i18n.tName)("Cursor pad"),
            type: "string",
            role: "state",
            read: false,
            write: true,
            states: selfMap(["up", "down", "left", "right", "select", "return"])
          }
        });
      }
      if (zone.funcs.includes("menu")) {
        objects.push({
          id: `${zoneDef.prefix}remote.menu`,
          type: "state",
          common: {
            name: (0, import_i18n.tName)("Menu key"),
            type: "string",
            role: "state",
            read: false,
            write: true,
            states: selfMap(["on_screen", "top_menu", "menu", "option", "display", "home"])
          }
        });
      }
    }
    if (zone.funcs.includes("signal_info")) {
      zoneChannelHelper(`${zoneDef.prefix}sound`, (0, import_i18n.tName)((_d = import_types.CHANNEL_NAME_KEYS.sound) != null ? _d : "Sound"));
      zoneChannelHelper(`${zoneDef.prefix}sound.signal`, (0, import_i18n.tName)((_e = import_types.CHANNEL_NAME_KEYS.signal) != null ? _e : "Audio signal"));
      const signal = (id, name, type, role) => {
        objects.push({
          id: `${zoneDef.prefix}sound.signal.${id}`,
          type: "state",
          common: { name, type, role, read: true, write: false }
        });
      };
      signal("format", (0, import_i18n.tName)("Audio signal format"), "string", "text");
      signal("sampling", (0, import_i18n.tName)("Audio sampling rate"), "string", "text");
      signal("bits", (0, import_i18n.tName)("Audio bit depth"), "string", "text");
      signal("bitrate", (0, import_i18n.tName)("Audio bitrate"), "number", "value");
    }
  }
  if (capabilities.media.includes("netusb") || capabilities.media.includes("cd")) {
    pushPlayerBlock(objects, "player", (0, import_i18n.tName)("Media player"));
    for (const zone of capabilities.zones) {
      if (zone.id !== "main") {
        pushPlayerBlock(objects, `${(0, import_zones.zonePrefix)(zone.id)}player`, (0, import_i18n.tName)("Media player"));
      }
    }
  }
  if (capabilities.media.includes("netusb")) {
    objects.push({ id: "player.netPlayer", type: "channel", common: { name: (0, import_i18n.tName)("Network player") } });
    objects.push({
      id: "player.netPlayer.preset",
      type: "state",
      common: { name: (0, import_i18n.tName)("Recall preset"), type: "number", role: "level", read: true, write: true, min: 1 }
    });
    objects.push({
      id: "player.netPlayer.presets",
      type: "state",
      common: { name: (0, import_i18n.tName)("Favourites (stored presets)"), type: "string", role: "json", read: true, write: false }
    });
    objects.push({
      id: "player.netPlayer.recent",
      type: "state",
      common: { name: (0, import_i18n.tName)("Recently played"), type: "string", role: "json", read: true, write: false }
    });
    objects.push({
      id: "player.netPlayer.recallRecent",
      type: "state",
      common: {
        name: (0, import_i18n.tName)("Recall recently played (number)"),
        type: "number",
        role: "level",
        read: true,
        write: true,
        min: 1
      }
    });
    if ((_f = capabilities.netusbFuncs) == null ? void 0 : _f.includes("mc_playlist")) {
      objects.push({
        id: "player.netPlayer.playlists",
        type: "state",
        common: { name: (0, import_i18n.tName)("MusicCast playlists"), type: "string", role: "json", read: true, write: false }
      });
    }
    if ((_g = capabilities.netusbFuncs) == null ? void 0 : _g.includes("play_queue")) {
      objects.push({
        id: "player.netPlayer.queue",
        type: "state",
        common: { name: (0, import_i18n.tName)("Play queue"), type: "string", role: "json", read: true, write: false }
      });
    }
  }
  if (capabilities.media.includes("cd")) {
    objects.push({ id: "player.cd", type: "channel", common: { name: (0, import_i18n.tName)("CD") } });
    objects.push({
      id: "player.cd.tray",
      type: "state",
      common: { name: (0, import_i18n.tName)("Toggle tray"), type: "boolean", role: "button", read: false, write: true }
    });
    objects.push({
      id: "player.cd.trackNumber",
      type: "state",
      common: { name: (0, import_i18n.tName)("Track number"), type: "number", role: "value", read: true, write: false }
    });
    objects.push({
      id: "player.cd.totalTracks",
      type: "state",
      common: { name: (0, import_i18n.tName)("Total tracks"), type: "number", role: "value", read: true, write: false }
    });
    objects.push({
      id: "player.cd.discTime",
      type: "state",
      common: { name: (0, import_i18n.tName)("Disc time"), type: "number", unit: "s", role: "value", read: true, write: false }
    });
    objects.push({
      id: "player.cd.deviceStatus",
      type: "state",
      common: { name: (0, import_i18n.tName)("Drive status"), type: "string", role: "state", read: true, write: false }
    });
  }
  if (capabilities.media.includes("tuner")) {
    objects.push({ id: "tuner", type: "channel", common: { name: (0, import_i18n.tName)("Tuner") } });
    const bandCommon = {
      name: (0, import_i18n.tName)("Band"),
      type: "string",
      role: "state",
      read: true,
      write: true
    };
    const bands = (_i = (_h = capabilities.tuner) == null ? void 0 : _h.bands) != null ? _i : [];
    if (bands.length > 0) {
      bandCommon.states = selfMap(bands);
    }
    objects.push({ id: "tuner.band", type: "state", common: bandCommon });
    objects.push({
      id: "tuner.frequency",
      type: "state",
      common: { name: (0, import_i18n.tName)("Frequency"), type: "number", unit: "kHz", role: "level", read: true, write: true }
    });
    objects.push({
      id: "tuner.rdsText",
      type: "state",
      common: { name: (0, import_i18n.tName)("RDS text"), type: "string", role: "text", read: true, write: false }
    });
    objects.push({
      id: "tuner.rdsTextB",
      type: "state",
      common: { name: (0, import_i18n.tName)("RDS text B"), type: "string", role: "text", read: true, write: false }
    });
    objects.push({
      id: "tuner.rdsService",
      type: "state",
      common: { name: (0, import_i18n.tName)("RDS station"), type: "string", role: "text", read: true, write: false }
    });
    objects.push({
      id: "tuner.rdsProgramType",
      type: "state",
      common: { name: (0, import_i18n.tName)("RDS programme type"), type: "string", role: "text", read: true, write: false }
    });
    const presetCommon = {
      name: (0, import_i18n.tName)("Preset (recall by number)"),
      type: "number",
      role: "level",
      read: true,
      write: true,
      min: 0
    };
    if ((_j = capabilities.tuner) == null ? void 0 : _j.presetNum) {
      presetCommon.max = capabilities.tuner.presetNum;
    }
    objects.push({ id: "tuner.preset", type: "state", common: presetCommon });
    objects.push({
      id: "tuner.presetUp",
      type: "state",
      common: { name: (0, import_i18n.tName)("Next preset"), type: "boolean", role: "button", read: false, write: true }
    });
    objects.push({
      id: "tuner.presetDown",
      type: "state",
      common: { name: (0, import_i18n.tName)("Previous preset"), type: "boolean", role: "button", read: false, write: true }
    });
    objects.push({
      id: "tuner.presets",
      type: "state",
      common: { name: (0, import_i18n.tName)("Stored presets"), type: "string", role: "json", read: true, write: false }
    });
    objects.push({
      id: "tuner.tuned",
      type: "state",
      common: { name: (0, import_i18n.tName)("Tuned"), type: "boolean", role: "indicator", read: true, write: false }
    });
    objects.push({
      id: "tuner.audioMode",
      type: "state",
      common: { name: (0, import_i18n.tName)("Audio mode"), type: "string", role: "state", read: true, write: false }
    });
    if (bands.includes("dab")) {
      objects.push({ id: "tuner.dab", type: "channel", common: { name: (0, import_i18n.tName)("DAB") } });
      for (const field of import_command_mapper.DAB_FIELDS) {
        objects.push({
          id: field.id,
          type: "state",
          common: {
            name: (0, import_i18n.tName)(field.nameKey),
            type: field.type,
            role: field.type === "boolean" ? "indicator" : field.type === "number" ? "value" : "text",
            read: true,
            write: false
          }
        });
      }
    }
  }
  if (capabilities.clock) {
    objects.push({ id: "clock", type: "channel", common: { name: (0, import_i18n.tName)("Clock & alarm") } });
    objects.push({
      id: "clock.autoSync",
      type: "state",
      common: { name: (0, import_i18n.tName)("Automatic time sync"), type: "boolean", role: "indicator", read: true, write: false }
    });
    objects.push({
      id: "clock.format",
      type: "state",
      common: { name: (0, import_i18n.tName)("Clock format"), type: "string", role: "state", read: true, write: false }
    });
    objects.push({ id: "clock.alarm", type: "channel", common: { name: (0, import_i18n.tName)("Alarm") } });
    objects.push({
      id: "clock.alarm.on",
      type: "state",
      common: { name: (0, import_i18n.tName)("Alarm armed"), type: "boolean", role: "indicator", read: true, write: false }
    });
    const volumeCommon = {
      name: (0, import_i18n.tName)("Alarm volume"),
      type: "number",
      role: "value",
      read: true,
      write: false
    };
    if (capabilities.clock.alarmVolumeRange) {
      volumeCommon.min = capabilities.clock.alarmVolumeRange.min;
      volumeCommon.max = capabilities.clock.alarmVolumeRange.max;
    }
    objects.push({ id: "clock.alarm.volume", type: "state", common: volumeCommon });
    objects.push({
      id: "clock.alarm.fadeInterval",
      type: "state",
      common: { name: (0, import_i18n.tName)("Fade-in time"), type: "number", unit: "s", role: "value", read: true, write: false }
    });
    objects.push({
      id: "clock.alarm.fadeType",
      type: "state",
      common: { name: (0, import_i18n.tName)("Fade type"), type: "number", role: "value", read: true, write: false }
    });
    objects.push({
      id: "clock.alarm.mode",
      type: "state",
      common: { name: (0, import_i18n.tName)("Alarm mode"), type: "string", role: "state", read: true, write: false }
    });
    objects.push({
      id: "clock.alarm.repeat",
      type: "state",
      common: { name: (0, import_i18n.tName)("Repeat (snooze)"), type: "boolean", role: "indicator", read: true, write: false }
    });
    const detailChannels = ["oneday", ...capabilities.clock.alarmModes.includes("weekly") ? import_command_mapper.ALARM_DAYS : []];
    for (const channel of detailChannels) {
      const label = channel === "oneday" ? (0, import_i18n.tName)("One-day alarm") : channel.charAt(0).toUpperCase() + channel.slice(1);
      objects.push({ id: `clock.alarm.${channel}`, type: "channel", common: { name: label } });
      const detail = (id, name, type, role) => {
        objects.push({
          id: `clock.alarm.${channel}.${id}`,
          type: "state",
          common: { name, type, role, read: true, write: false }
        });
      };
      detail("enable", (0, import_i18n.tName)("Enabled"), "boolean", "indicator");
      detail("time", (0, import_i18n.tName)("Alarm time"), "string", "text");
      detail("beep", (0, import_i18n.tName)("Beep"), "boolean", "indicator");
      detail("playbackType", (0, import_i18n.tName)("Playback type"), "string", "state");
      detail("resumeInput", (0, import_i18n.tName)("Resume input"), "string", "state");
      detail("presetType", (0, import_i18n.tName)("Preset type"), "string", "state");
      detail("presetNumber", (0, import_i18n.tName)("Preset number"), "number", "value");
      detail("presetInput", (0, import_i18n.tName)("Preset source"), "string", "state");
    }
  }
  if (capabilities.hasDistribution) {
    const distState = (id, name, role) => {
      objects.push({
        id: `multiroom.group.${id}`,
        type: "state",
        common: { name, type: "string", role, read: true, write: false }
      });
    };
    distState("role", (0, import_i18n.tName)("Role (server/client)"), "state");
    distState("id", (0, import_i18n.tName)("Group ID"), "text");
    distState("name", (0, import_i18n.tName)("Group name"), "text");
    distState("serverZone", (0, import_i18n.tName)("Server zone (feeds the group)"), "text");
    distState("linkedDevices", (0, import_i18n.tName)("Linked devices"), "json");
    objects.push({
      id: "multiroom.group.leave",
      type: "state",
      common: { name: (0, import_i18n.tName)("Leave group"), type: "boolean", role: "button", read: false, write: true }
    });
    objects.push({
      id: "multiroom.group.linkDevice",
      type: "state",
      common: { name: (0, import_i18n.tName)("Link a device (its IP)"), type: "string", role: "text", read: false, write: true }
    });
  }
  return objects;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  mapYxcToObjects
});
//# sourceMappingURL=object-mapper.js.map
