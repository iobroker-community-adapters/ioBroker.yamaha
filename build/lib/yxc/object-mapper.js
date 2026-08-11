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
      name: "Playback",
      type: "string",
      role: "media.state",
      read: true,
      write: false,
      states: { play: "play", pause: "pause", stop: "stop" }
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
  { state: "play", common: { name: "Play", type: "boolean", role: "button", read: false, write: true } },
  { state: "pause", common: { name: "Pause", type: "boolean", role: "button", read: false, write: true } },
  { state: "stop", common: { name: "Stop", type: "boolean", role: "button", read: false, write: true } },
  { state: "next", common: { name: "Next", type: "boolean", role: "button", read: false, write: true } },
  { state: "prev", common: { name: "Previous", type: "boolean", role: "button", read: false, write: true } }
];
function pushPlayerBlock(objects, prefix, channelName) {
  objects.push({ id: prefix, type: "channel", common: { name: channelName } });
  for (const player of PLAYER_STATES) {
    objects.push({ id: `${prefix}.${player.state}`, type: "state", common: { ...player.common } });
  }
}
function mapYxcToObjects(capabilities) {
  var _a;
  const objects = [];
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
      objects.push({ id: zoneDef.channel, type: "channel", common: { name: (_a = zoneDef.channelName) != null ? _a : zoneDef.channel } });
    }
    for (const entry of entries) {
      const common = { ...entry.common };
      if (entry.state === "volume" && zone.volumeRange) {
        common.min = zone.volumeRange.min;
        common.max = zone.volumeRange.max;
        common.step = zone.volumeRange.step;
      }
      objects.push({ id: `${zoneDef.prefix}${entry.state}`, type: "state", common });
    }
  }
  if (capabilities.media.includes("netusb")) {
    pushPlayerBlock(objects, "netPlayer", "Network player");
  }
  if (capabilities.media.includes("cd")) {
    pushPlayerBlock(objects, "cd", "CD");
  }
  if (capabilities.media.includes("tuner")) {
    objects.push({ id: "tuner", type: "channel", common: { name: "Tuner" } });
    objects.push({
      id: "tuner.band",
      type: "state",
      common: { name: "Band", type: "string", role: "state", read: true, write: false }
    });
    objects.push({
      id: "tuner.frequency",
      type: "state",
      common: { name: "Frequency", type: "number", unit: "kHz", role: "value", read: true, write: false }
    });
    objects.push({
      id: "tuner.rdsText",
      type: "state",
      common: { name: "RDS text", type: "string", role: "text", read: true, write: false }
    });
  }
  return objects;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  mapYxcToObjects
});
//# sourceMappingURL=object-mapper.js.map
