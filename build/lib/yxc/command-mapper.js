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
const BUTTON_ACTIONS = {
  "player.netPlayer.play": (client) => client.playNet(),
  "player.netPlayer.pause": (client) => client.pauseNet(),
  "player.netPlayer.stop": (client) => client.stopNet(),
  "player.netPlayer.next": (client) => client.nextNet(),
  "player.netPlayer.prev": (client) => client.prevNet(),
  "player.cd.play": (client) => client.setCDPlayback("play"),
  "player.cd.pause": (client) => client.setCDPlayback("pause"),
  "player.cd.stop": (client) => client.setCDPlayback("stop"),
  "player.cd.next": (client) => client.setCDPlayback("next"),
  "player.cd.prev": (client) => client.setCDPlayback("previous"),
  "player.netPlayer.repeatToggle": (client) => client.toggleNetRepeat(),
  "player.netPlayer.shuffleToggle": (client) => client.toggleNetShuffle(),
  "player.cd.repeatToggle": (client) => client.toggleCDRepeat(),
  "player.cd.shuffleToggle": (client) => client.toggleCDShuffle(),
  "player.cd.tray": (client) => client.toggleTray()
};
const EQ_CHANNELS = {
  "sound.equalizerLow": "low",
  "sound.equalizerMid": "mid",
  "sound.equalizerHigh": "high"
};
const ZONE_PREFIX = {
  main: "",
  zone2: "multiroom.zone2.",
  zone3: "multiroom.zone3.",
  zone4: "multiroom.zone4."
};
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
  const button = BUTTON_ACTIONS[stateId];
  if (button) {
    return { kind: "run", run: button };
  }
  if (stateId === "tuner.band" && (0, import_value_coerce.isWritableValue)(value, false)) {
    const band = String(value);
    return { kind: "run", run: (client) => client.setBand(band) };
  }
  if (stateId === "tuner.frequency" && (0, import_value_coerce.isWritableValue)(value, true)) {
    return { kind: "tunerFreq", value: Number(value) };
  }
  if (stateId === "player.netPlayer.preset" && (0, import_value_coerce.isWritableValue)(value, true)) {
    const preset = Number(value);
    return { kind: "run", run: (client) => client.recallPreset(preset, "main") };
  }
  let zone = "main";
  let name = stateId;
  const zoneMatch = /^multiroom\.(zone[234])\.(.+)$/.exec(stateId);
  if (zoneMatch) {
    zone = zoneMatch[1];
    name = zoneMatch[2];
  }
  const eqBand = EQ_CHANNELS[name];
  if (eqBand && (0, import_value_coerce.isWritableValue)(value, true)) {
    return { kind: "equalizer", zone, band: eqBand, value: Number(value) };
  }
  const entry = import_catalog.YXC_AMP_CATALOG.find((e) => e.state === name);
  if (!(entry == null ? void 0 : entry.write) || !(0, import_value_coerce.isWritableValue)(value, entry.common.type === "number")) {
    return void 0;
  }
  const { apply } = entry.write;
  return { kind: "run", run: (client) => apply(client, value, zone) };
}
function parseYxcDistribution(info) {
  if (typeof info !== "object" || info === null) {
    return [];
  }
  const d = info;
  const updates = [];
  if (typeof d.role === "string") {
    updates.push({ id: "multiroom.role", value: d.role });
  }
  if (typeof d.group_id === "string") {
    updates.push({ id: "multiroom.groupId", value: d.group_id });
  }
  if (typeof d.group_name === "string") {
    updates.push({ id: "multiroom.groupName", value: d.group_name });
  }
  if (typeof d.server_zone === "string") {
    updates.push({ id: "multiroom.serverZone", value: d.server_zone });
  }
  if (Array.isArray(d.client_list)) {
    updates.push({ id: "multiroom.clientList", value: JSON.stringify(d.client_list) });
  }
  return updates;
}
function parseYxcPlayInfo(playInfo, prefix = "player.netPlayer") {
  if (typeof playInfo !== "object" || playInfo === null) {
    return [];
  }
  const info = playInfo;
  const updates = [];
  for (const field of ["artist", "album", "track"]) {
    const value = info[field];
    if (typeof value === "string") {
      updates.push({ id: `${prefix}.${field}`, value });
    }
  }
  const repeatCode = { off: 0, one: 1, all: 2 };
  if (typeof info.repeat === "string" && info.repeat in repeatCode) {
    updates.push({ id: `${prefix}.repeat`, value: repeatCode[info.repeat] });
  }
  if (info.shuffle === "on" || info.shuffle === "off") {
    updates.push({ id: `${prefix}.shuffle`, value: info.shuffle === "on" });
  }
  const playbackCode = { play: 0, stop: 1, pause: 2 };
  if (typeof info.playback === "string" && info.playback in playbackCode) {
    updates.push({ id: `${prefix}.playback`, value: playbackCode[info.playback] });
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
