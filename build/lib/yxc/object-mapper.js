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
var import_catalog = require("./catalog");
const ZONES = [
  { id: "main", prefix: "" },
  { id: "zone2", prefix: "zone2.", channel: "zone2", channelName: "Zone 2" },
  { id: "zone3", prefix: "zone3.", channel: "zone3", channelName: "Zone 3" },
  { id: "zone4", prefix: "zone4.", channel: "zone4", channelName: "Zone 4" }
];
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
  // Read-only playback metadata to match what YNCA sources expose (audit finding F2).
  { state: "repeat", common: { name: "Repeat", type: "string", role: "state", read: true, write: false } },
  { state: "shuffle", common: { name: "Shuffle", type: "string", role: "state", read: true, write: false } },
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
  var _a, _b;
  const objects = [];
  const channels = /* @__PURE__ */ new Set();
  for (const zoneDef of ZONES) {
    const zone = capabilities.zones.find((z) => z.id === zoneDef.id);
    if (!zone) {
      continue;
    }
    const hasInput = zone.inputs.length > 0;
    const entries = import_catalog.YXC_AMP_CATALOG.filter((entry) => {
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
      channels.add(zoneDef.channel);
      objects.push({ id: zoneDef.channel, type: "channel", common: { name: (_a = zoneDef.channelName) != null ? _a : zoneDef.channel } });
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
            common: { name: (_b = import_types.CHANNEL_NAMES[segment]) != null ? _b : segment.charAt(0).toUpperCase() + segment.slice(1) }
          });
        }
      }
      const common = { ...entry.common };
      if (entry.state === "volume" && zone.volumeRange) {
        common.min = zone.volumeRange.min;
        common.max = zone.volumeRange.max;
        common.step = zone.volumeRange.step;
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
      common: { name: "Recall preset", type: "number", role: "level", read: true, write: true, min: 1 }
    });
  }
  if (capabilities.media.includes("cd")) {
    pushPlayerBlock(objects, "player.cd", "CD");
    objects.push({
      id: "player.cd.tray",
      type: "state",
      common: { name: "Toggle tray", type: "boolean", role: "button", read: false, write: true }
    });
  }
  if (capabilities.media.includes("tuner")) {
    objects.push({ id: "tuner", type: "channel", common: { name: "Tuner" } });
    objects.push({
      id: "tuner.band",
      type: "state",
      common: { name: "Band", type: "string", role: "state", read: true, write: true }
    });
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
  }
  if (capabilities.hasDistribution) {
    objects.push({ id: "multiroom", type: "channel", common: { name: "Multiroom" } });
    const distState = (id, name, role) => {
      objects.push({
        id: `multiroom.${id}`,
        type: "state",
        common: { name, type: "string", role, read: true, write: false }
      });
    };
    distState("role", "Role", "state");
    distState("groupId", "Group ID", "text");
    distState("groupName", "Group name", "text");
    distState("serverZone", "Server zone", "text");
    distState("clientList", "Client list", "json");
    objects.push({
      id: "multiroom.leaveGroup",
      type: "state",
      common: { name: "Leave group", type: "boolean", role: "button", read: false, write: true }
    });
    objects.push({
      id: "multiroom.linkClient",
      type: "state",
      common: { name: "Link a client (its IP)", type: "string", role: "text", read: false, write: true }
    });
  }
  return objects;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  mapYxcToObjects
});
//# sourceMappingURL=object-mapper.js.map
