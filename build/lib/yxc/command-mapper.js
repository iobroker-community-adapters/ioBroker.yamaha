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
var command_mapper_exports = {};
__export(command_mapper_exports, {
  parseYxcDistribution: () => parseYxcDistribution,
  parseYxcPlayInfo: () => parseYxcPlayInfo,
  parseYxcStatus: () => parseYxcStatus,
  parseYxcTunerInfo: () => parseYxcTunerInfo,
  stateToYxc: () => stateToYxc
});
module.exports = __toCommonJS(command_mapper_exports);
var import_value_coerce = require("../catalog/value-coerce");
var import_catalog = require("./catalog");
function readStatusField(status, read) {
  if ("path" in read) {
    let value = status;
    for (const key of read.path) {
      if (typeof value !== "object" || value === null) {
        return void 0;
      }
      value = value[key];
    }
    return value;
  }
  return status[read.field];
}
const NETUSB_TRANSPORT = {
  "netPlayer.play": "playNet",
  "netPlayer.pause": "pauseNet",
  "netPlayer.stop": "stopNet",
  "netPlayer.next": "nextNet",
  "netPlayer.prev": "prevNet"
};
const CD_TRANSPORT = {
  "cd.play": "play",
  "cd.pause": "pause",
  "cd.stop": "stop",
  "cd.next": "next",
  "cd.prev": "previous"
};
const TOGGLE_ACTIONS = {
  "netPlayer.repeatToggle": "toggleNetRepeat",
  "netPlayer.shuffleToggle": "toggleNetShuffle",
  "cd.repeatToggle": "toggleCDRepeat",
  "cd.shuffleToggle": "toggleCDShuffle",
  "cd.tray": "toggleTray"
};
const EQ_CHANNELS = { equalizerLow: "Low", equalizerMid: "Mid", equalizerHigh: "High" };
const ZONE_PREFIX = { main: "", zone2: "zone2.", zone3: "zone3.", zone4: "zone4." };
function parseYxcStatus(zoneStatus, zone) {
  if (typeof zoneStatus !== "object" || zoneStatus === null) {
    return [];
  }
  const prefix = ZONE_PREFIX[zone];
  if (prefix === void 0) {
    return [];
  }
  const status = zoneStatus;
  const updates = [];
  for (const entry of import_catalog.YXC_AMP_CATALOG) {
    const raw = readStatusField(status, entry.read);
    if (raw !== void 0) {
      updates.push({ id: `${prefix}${entry.state}`, value: entry.fromStatus(raw) });
    }
  }
  return updates;
}
function stateToYxc(stateId, value) {
  const transport = NETUSB_TRANSPORT[stateId];
  if (transport) {
    return { method: transport, zone: "netusb", value: true };
  }
  const cdAction = CD_TRANSPORT[stateId];
  if (cdAction) {
    return { method: "setCDPlayback", zone: "cd", value: cdAction };
  }
  const toggle = TOGGLE_ACTIONS[stateId];
  if (toggle) {
    return { method: toggle, zone: "netusb", value: true };
  }
  if (stateId === "tuner.band" && (0, import_value_coerce.isWritableValue)(value, false)) {
    return { method: "setBand", zone: "tuner", value: String(value) };
  }
  if (stateId === "tuner.frequency" && (0, import_value_coerce.isWritableValue)(value, true)) {
    return { method: "setFreq", zone: "tuner", value: Number(value) };
  }
  if (stateId === "netPlayer.preset" && (0, import_value_coerce.isWritableValue)(value, true)) {
    return { method: "recallPreset", zone: "netusb", value: Number(value) };
  }
  let zone = "main";
  let name = stateId;
  const dot = stateId.indexOf(".");
  if (dot > 0) {
    zone = stateId.slice(0, dot);
    name = stateId.slice(dot + 1);
    if (ZONE_PREFIX[zone] === void 0 || zone === "main") {
      return void 0;
    }
  }
  const eqBand = EQ_CHANNELS[name];
  if (eqBand && (0, import_value_coerce.isWritableValue)(value, true)) {
    return { method: `setEqualizer${eqBand}`, zone, value: Number(value) };
  }
  const entry = import_catalog.YXC_AMP_CATALOG.find((e) => e.state === name);
  if (!(entry == null ? void 0 : entry.write) || !(0, import_value_coerce.isWritableValue)(value, entry.common.type === "number")) {
    return void 0;
  }
  return { method: entry.write.method, zone, value: entry.write.toYxc(value) };
}
function parseYxcDistribution(info) {
  if (typeof info !== "object" || info === null) {
    return [];
  }
  const d = info;
  const updates = [];
  if (typeof d.role === "string") {
    updates.push({ id: "dist.role", value: d.role });
  }
  if (typeof d.group_id === "string") {
    updates.push({ id: "dist.groupId", value: d.group_id });
  }
  if (typeof d.group_name === "string") {
    updates.push({ id: "dist.groupName", value: d.group_name });
  }
  if (typeof d.server_zone === "string") {
    updates.push({ id: "dist.serverZone", value: d.server_zone });
  }
  if (Array.isArray(d.client_list)) {
    updates.push({ id: "dist.clientList", value: JSON.stringify(d.client_list) });
  }
  return updates;
}
function parseYxcPlayInfo(playInfo, prefix = "netPlayer") {
  if (typeof playInfo !== "object" || playInfo === null) {
    return [];
  }
  const info = playInfo;
  const updates = [];
  for (const field of ["playback", "artist", "album", "track", "repeat", "shuffle"]) {
    const value = info[field];
    if (typeof value === "string") {
      updates.push({ id: `${prefix}.${field}`, value });
    }
  }
  const albumArt = info.albumart_url;
  if (typeof albumArt === "string") {
    updates.push({ id: `${prefix}.albumArt`, value: albumArt });
  }
  const elapsed = info.play_time;
  if (typeof elapsed === "number") {
    updates.push({ id: `${prefix}.elapsedTime`, value: elapsed });
  }
  const total = info.total_time;
  if (typeof total === "number") {
    updates.push({ id: `${prefix}.totalTime`, value: total });
  }
  return updates;
}
function parseYxcTunerInfo(tunerInfo) {
  if (typeof tunerInfo !== "object" || tunerInfo === null) {
    return [];
  }
  const info = tunerInfo;
  const updates = [];
  const band = info.band;
  if (typeof band === "string") {
    updates.push({ id: "tuner.band", value: band });
    const bandInfo = info[band];
    if (typeof bandInfo === "object" && bandInfo !== null) {
      const freq = bandInfo.freq;
      if (typeof freq === "number") {
        updates.push({ id: "tuner.frequency", value: freq });
      }
    }
  }
  const rds = info.rds;
  if (typeof rds === "object" && rds !== null) {
    const text = rds.radio_text_a;
    if (typeof text === "string") {
      updates.push({ id: "tuner.rdsText", value: text });
    }
  }
  return updates;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  parseYxcDistribution,
  parseYxcPlayInfo,
  parseYxcStatus,
  parseYxcTunerInfo,
  stateToYxc
});
//# sourceMappingURL=command-mapper.js.map
