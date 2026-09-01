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
var import_zones = require("./zones");
var import_catalog = require("./catalog");
var import_command_mapper = require("./command-mapper");
function selfMap(values) {
  return Object.fromEntries(values.map((value) => [value, value]));
}
const ZONES = import_zones.YXC_ZONE_IDS.map((id) => {
  const channel = (0, import_zones.zoneChannel)(id);
  return { id, prefix: (0, import_zones.zonePrefix)(id), ...channel ? { channel: channel.channel, channelName: channel.name } : {} };
});
const PLAYER_STATES = [
  {
    state: "playback",
    common: {
      // media.state is a number in the type-detector; the same 0/1/2 coding as the YNCA player.
      name: "Playback",
      type: "number",
      role: "media.state",
      read: true,
      write: false,
      states: { 0: "Play", 1: "Stop", 2: "Pause" }
    }
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
      states: { 0: "Off", 1: "Single", 2: "All" }
    }
  },
  {
    state: "shuffle",
    common: { name: "Shuffle", type: "boolean", role: "media.mode.shuffle", read: true, write: false }
  },
  {
    state: "elapsedTime",
    common: { name: "Elapsed time", type: "number", unit: "s", role: "media.elapsed", read: true, write: false }
  },
  {
    state: "totalTime",
    common: { name: "Total time", type: "number", unit: "s", role: "media.duration", read: true, write: false }
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
    common: { name: "Toggle repeat", type: "boolean", role: "button", read: false, write: true }
  },
  {
    state: "shuffleToggle",
    common: { name: "Toggle shuffle", type: "boolean", role: "button", read: false, write: true }
  }
];
function pushPlayerBlock(objects, prefix, channelName) {
  objects.push({ id: prefix, type: "channel", common: { name: channelName } });
  for (const player of PLAYER_STATES) {
    objects.push({ id: `${prefix}.${player.state}`, type: "state", common: { ...player.common } });
  }
}
function mapYxcToObjects(capabilities) {
  var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l;
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
            common: { name: (_a = import_types.CHANNEL_NAMES[seg]) != null ? _a : seg.charAt(0).toUpperCase() + seg.slice(1) }
          });
        }
      }
      channels.add(zoneDef.channel);
      objects.push({ id: zoneDef.channel, type: "channel", common: { name: (_b = zoneDef.channelName) != null ? _b : zoneDef.channel } });
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
            common: { name: (_c = import_types.CHANNEL_NAMES[segment]) != null ? _c : segment.charAt(0).toUpperCase() + segment.slice(1) }
          });
        }
      }
      const common = { ...entry.common };
      if (entry.state === "volume" && zone.volumeRange) {
        common.min = zone.volumeRange.min;
        common.max = zone.volumeRange.max;
        common.step = zone.volumeRange.step;
      }
      if (entry.state === "input" && zone.inputs.length > 0) {
        common.states = selfMap(zone.inputs);
      }
      const valueList = (_d = zone.valueLists) == null ? void 0 : _d[entry.state];
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
      zoneChannelHelper(`${zoneDef.prefix}scene`, (_e = import_types.CHANNEL_NAMES.scene) != null ? _e : "Scenes");
      objects.push({
        id: `${zoneDef.prefix}scene.recall`,
        type: "state",
        common: {
          name: "Recall scene",
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
      zoneChannelHelper(`${zoneDef.prefix}remote`, (_f = import_types.CHANNEL_NAMES.remote) != null ? _f : "Remote control");
      if (zone.funcs.includes("cursor")) {
        objects.push({
          id: `${zoneDef.prefix}remote.cursor`,
          type: "state",
          common: {
            name: "Cursor pad",
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
            name: "Menu key",
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
      zoneChannelHelper(`${zoneDef.prefix}sound`, (_g = import_types.CHANNEL_NAMES.sound) != null ? _g : "Sound");
      const signal = (id, name, type, role) => {
        objects.push({
          id: `${zoneDef.prefix}sound.${id}`,
          type: "state",
          common: { name, type, role, read: true, write: false }
        });
      };
      signal("signalFormat", "Audio signal format", "string", "text");
      signal("signalSampling", "Audio sampling rate", "string", "text");
      signal("signalBits", "Audio bit depth", "string", "text");
      signal("signalBitrate", "Audio bitrate", "number", "value");
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
      common: { name: "Recall preset", type: "number", role: "level", read: true, write: true, min: 1 }
    });
    objects.push({
      id: "player.netPlayer.presets",
      type: "state",
      common: { name: "Favourites (stored presets)", type: "string", role: "json", read: true, write: false }
    });
    objects.push({
      id: "player.netPlayer.recent",
      type: "state",
      common: { name: "Recently played", type: "string", role: "json", read: true, write: false }
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
        min: 1
      }
    });
    objects.push({
      id: "player.netPlayer.source",
      type: "state",
      common: { name: "Active network source", type: "string", role: "text", read: true, write: false }
    });
    if ((_h = capabilities.netusbFuncs) == null ? void 0 : _h.includes("mc_playlist")) {
      objects.push({
        id: "player.netPlayer.playlists",
        type: "state",
        common: { name: "MusicCast playlists", type: "string", role: "json", read: true, write: false }
      });
    }
    if ((_i = capabilities.netusbFuncs) == null ? void 0 : _i.includes("play_queue")) {
      objects.push({
        id: "player.netPlayer.queue",
        type: "state",
        common: { name: "Play queue", type: "string", role: "json", read: true, write: false }
      });
    }
  }
  if (capabilities.media.includes("cd")) {
    pushPlayerBlock(objects, "player.cd", "CD");
    objects.push({
      id: "player.cd.tray",
      type: "state",
      common: { name: "Toggle tray", type: "boolean", role: "button", read: false, write: true }
    });
    objects.push({
      id: "player.cd.trackNumber",
      type: "state",
      common: { name: "Track number", type: "number", role: "value", read: true, write: false }
    });
    objects.push({
      id: "player.cd.totalTracks",
      type: "state",
      common: { name: "Total tracks", type: "number", role: "value", read: true, write: false }
    });
    objects.push({
      id: "player.cd.discTime",
      type: "state",
      common: { name: "Disc time", type: "number", unit: "s", role: "value", read: true, write: false }
    });
    objects.push({
      id: "player.cd.deviceStatus",
      type: "state",
      common: { name: "Drive status", type: "string", role: "state", read: true, write: false }
    });
  }
  if (capabilities.media.includes("tuner")) {
    objects.push({ id: "tuner", type: "channel", common: { name: "Tuner" } });
    const bandCommon = { name: "Band", type: "string", role: "state", read: true, write: true };
    const bands = (_k = (_j = capabilities.tuner) == null ? void 0 : _j.bands) != null ? _k : [];
    if (bands.length > 0) {
      bandCommon.states = selfMap(bands);
    }
    objects.push({ id: "tuner.band", type: "state", common: bandCommon });
    objects.push({
      id: "tuner.frequency",
      type: "state",
      common: { name: "Frequency", type: "number", unit: "kHz", role: "level", read: true, write: true }
    });
    objects.push({
      id: "tuner.rdsText",
      type: "state",
      common: { name: "RDS text", type: "string", role: "text", read: true, write: false }
    });
    objects.push({
      id: "tuner.rdsTextB",
      type: "state",
      common: { name: "RDS text B", type: "string", role: "text", read: true, write: false }
    });
    objects.push({
      id: "tuner.rdsService",
      type: "state",
      common: { name: "RDS station", type: "string", role: "text", read: true, write: false }
    });
    objects.push({
      id: "tuner.rdsProgramType",
      type: "state",
      common: { name: "RDS programme type", type: "string", role: "text", read: true, write: false }
    });
    const presetCommon = {
      name: "Preset (recall by number)",
      type: "number",
      role: "level",
      read: true,
      write: true,
      min: 0
    };
    if ((_l = capabilities.tuner) == null ? void 0 : _l.presetNum) {
      presetCommon.max = capabilities.tuner.presetNum;
    }
    objects.push({ id: "tuner.preset", type: "state", common: presetCommon });
    objects.push({
      id: "tuner.presetUp",
      type: "state",
      common: { name: "Next preset", type: "boolean", role: "button", read: false, write: true }
    });
    objects.push({
      id: "tuner.presetDown",
      type: "state",
      common: { name: "Previous preset", type: "boolean", role: "button", read: false, write: true }
    });
    objects.push({
      id: "tuner.presets",
      type: "state",
      common: { name: "Stored presets", type: "string", role: "json", read: true, write: false }
    });
    objects.push({
      id: "tuner.tuned",
      type: "state",
      common: { name: "Tuned", type: "boolean", role: "indicator", read: true, write: false }
    });
    objects.push({
      id: "tuner.audioMode",
      type: "state",
      common: { name: "Audio mode", type: "string", role: "state", read: true, write: false }
    });
    if (bands.includes("dab")) {
      objects.push({ id: "tuner.dab", type: "channel", common: { name: "DAB" } });
      for (const field of import_command_mapper.DAB_FIELDS) {
        objects.push({
          id: field.id,
          type: "state",
          common: {
            name: field.name,
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
    objects.push({ id: "clock", type: "channel", common: { name: "Clock & alarm" } });
    objects.push({
      id: "clock.autoSync",
      type: "state",
      common: { name: "Automatic time sync", type: "boolean", role: "indicator", read: true, write: false }
    });
    objects.push({
      id: "clock.format",
      type: "state",
      common: { name: "Clock format", type: "string", role: "state", read: true, write: false }
    });
    objects.push({ id: "clock.alarm", type: "channel", common: { name: "Alarm" } });
    objects.push({
      id: "clock.alarm.on",
      type: "state",
      common: { name: "Alarm armed", type: "boolean", role: "indicator", read: true, write: false }
    });
    const volumeCommon = {
      name: "Alarm volume",
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
      common: { name: "Fade-in time", type: "number", unit: "s", role: "value", read: true, write: false }
    });
    objects.push({
      id: "clock.alarm.fadeType",
      type: "state",
      common: { name: "Fade type", type: "number", role: "value", read: true, write: false }
    });
    objects.push({
      id: "clock.alarm.mode",
      type: "state",
      common: { name: "Alarm mode", type: "string", role: "state", read: true, write: false }
    });
    objects.push({
      id: "clock.alarm.repeat",
      type: "state",
      common: { name: "Repeat (snooze)", type: "boolean", role: "indicator", read: true, write: false }
    });
    const detailChannels = ["oneday", ...capabilities.clock.alarmModes.includes("weekly") ? import_command_mapper.ALARM_DAYS : []];
    for (const channel of detailChannels) {
      const label = channel === "oneday" ? "One-day alarm" : channel.charAt(0).toUpperCase() + channel.slice(1);
      objects.push({ id: `clock.alarm.${channel}`, type: "channel", common: { name: label } });
      const detail = (id, name, type, role) => {
        objects.push({
          id: `clock.alarm.${channel}.${id}`,
          type: "state",
          common: { name, type, role, read: true, write: false }
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
    if (!channels.has("multiroom.group")) {
      channels.add("multiroom.group");
      objects.push({ id: "multiroom.group", type: "channel", common: { name: import_types.CHANNEL_NAMES.group } });
    }
    const distState = (id, name, role) => {
      objects.push({
        id: `multiroom.group.${id}`,
        type: "state",
        common: { name, type: "string", role, read: true, write: false }
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
      common: { name: "Leave group", type: "boolean", role: "button", read: false, write: true }
    });
    objects.push({
      id: "multiroom.group.linkDevice",
      type: "state",
      common: { name: "Link a device (its IP)", type: "string", role: "text", read: false, write: true }
    });
  }
  return objects;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  mapYxcToObjects
});
//# sourceMappingURL=object-mapper.js.map
