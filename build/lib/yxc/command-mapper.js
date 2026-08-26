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
  ALARM_DAYS: () => ALARM_DAYS,
  DAB_FIELDS: () => DAB_FIELDS,
  parseYxcClock: () => parseYxcClock,
  parseYxcDistribution: () => parseYxcDistribution,
  parseYxcPlayInfo: () => parseYxcPlayInfo,
  parseYxcPresetList: () => parseYxcPresetList,
  parseYxcRecentList: () => parseYxcRecentList,
  parseYxcStatus: () => parseYxcStatus,
  parseYxcTunerInfo: () => parseYxcTunerInfo,
  parseYxcTunerPresetLists: () => parseYxcTunerPresetLists,
  stateToYxc: () => stateToYxc
});
module.exports = __toCommonJS(command_mapper_exports);
var import_zones = require("./zones");
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
function parseYxcStatus(zoneStatus, zone) {
  if (typeof zoneStatus !== "object" || zoneStatus === null) {
    return [];
  }
  const prefix = import_zones.YXC_ZONE_IDS.includes(zone) ? (0, import_zones.zonePrefix)(zone) : void 0;
  if (prefix === void 0) {
    return [];
  }
  const status = zoneStatus;
  const updates = [];
  for (const entry of import_catalog.YXC_AMP_CATALOG) {
    if (zone !== "main" && entry.state.startsWith("multiroom.")) {
      continue;
    }
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
    return { kind: "tunerBand", band: String(value) };
  }
  if (stateId === "tuner.frequency" && (0, import_value_coerce.isWritableValue)(value, true)) {
    return { kind: "tunerFreq", value: Number(value) };
  }
  if (stateId === "player.netPlayer.preset" && (0, import_value_coerce.isWritableValue)(value, true)) {
    const preset = Number(value);
    return { kind: "run", run: (client) => client.recallPreset(preset, "main") };
  }
  if (stateId === "player.netPlayer.recallRecent" && (0, import_value_coerce.isWritableValue)(value, true)) {
    const num = Number(value);
    return { kind: "run", run: (client) => client.recallRecentItem(num, "main") };
  }
  if (stateId === "tuner.preset" && (0, import_value_coerce.isWritableValue)(value, true)) {
    return { kind: "tunerPreset", value: Number(value) };
  }
  if (stateId === "tuner.presetUp") {
    return { kind: "run", run: (client) => client.switchTunerPreset("next") };
  }
  if (stateId === "tuner.presetDown") {
    return { kind: "run", run: (client) => client.switchTunerPreset("previous") };
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
    updates.push({ id: "multiroom.group.role", value: d.role });
  }
  if (typeof d.group_id === "string") {
    updates.push({ id: "multiroom.group.id", value: d.group_id });
  }
  if (typeof d.group_name === "string") {
    updates.push({ id: "multiroom.group.name", value: d.group_name });
  }
  if (typeof d.server_zone === "string") {
    updates.push({ id: "multiroom.group.serverZone", value: d.server_zone });
  }
  if (Array.isArray(d.client_list)) {
    updates.push({ id: "multiroom.group.linkedDevices", value: JSON.stringify(d.client_list) });
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
  if (typeof info.input === "string") {
    updates.push({ id: `${prefix}.source`, value: info.input });
  }
  if (typeof info.track_number === "number") {
    updates.push({ id: `${prefix}.trackNumber`, value: info.track_number });
  }
  if (typeof info.total_tracks === "number") {
    updates.push({ id: `${prefix}.totalTracks`, value: info.total_tracks });
  }
  if (typeof info.disc_time === "number") {
    updates.push({ id: `${prefix}.discTime`, value: info.disc_time });
  }
  if (typeof info.device_status === "string") {
    updates.push({ id: `${prefix}.deviceStatus`, value: info.device_status });
  }
  return updates;
}
const DAB_FIELDS = [
  { field: "service_label", id: "tuner.dab.serviceLabel", type: "string", name: "Service label" },
  { field: "ensemble_label", id: "tuner.dab.ensembleLabel", type: "string", name: "Ensemble label" },
  { field: "ch_label", id: "tuner.dab.channelLabel", type: "string", name: "Channel label" },
  { field: "dls", id: "tuner.dab.dls", type: "string", name: "DLS text" },
  { field: "program_type", id: "tuner.dab.programType", type: "string", name: "Programme type" },
  { field: "preset", id: "tuner.dab.preset", type: "number", name: "DAB preset" },
  { field: "status", id: "tuner.dab.status", type: "string", name: "DAB status" },
  { field: "audio_mode", id: "tuner.dab.audioMode", type: "string", name: "Audio mode" },
  { field: "bit_rate", id: "tuner.dab.bitRate", type: "number", name: "Bit rate" },
  { field: "quality", id: "tuner.dab.quality", type: "number", name: "Signal quality" },
  { field: "off_air", id: "tuner.dab.offAir", type: "boolean", name: "Off air" },
  { field: "dab_plus", id: "tuner.dab.dabPlus", type: "boolean", name: "DAB+" },
  { field: "category", id: "tuner.dab.category", type: "string", name: "Service category" },
  { field: "total_station_num", id: "tuner.dab.totalStations", type: "number", name: "Total stations" },
  { field: "initial_scan_progress", id: "tuner.dab.scanProgress", type: "number", name: "Initial scan progress" },
  { field: "tune_aid", id: "tuner.dab.tuneAid", type: "number", name: "Tune aid level" }
];
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
      const current = bandInfo;
      if (typeof current.freq === "number") {
        updates.push({ id: "tuner.frequency", value: current.freq });
      }
      if (typeof current.preset === "number") {
        updates.push({ id: "tuner.preset", value: current.preset });
      }
      if (typeof current.tuned === "boolean") {
        updates.push({ id: "tuner.tuned", value: current.tuned });
      }
      if (typeof current.audio_mode === "string") {
        updates.push({ id: "tuner.audioMode", value: current.audio_mode });
      }
    }
  }
  const rds = info.rds;
  if (typeof rds === "object" && rds !== null) {
    const r = rds;
    if (typeof r.radio_text_a === "string") {
      updates.push({ id: "tuner.rdsText", value: r.radio_text_a });
    }
    if (typeof r.radio_text_b === "string") {
      updates.push({ id: "tuner.rdsTextB", value: r.radio_text_b });
    }
    if (typeof r.program_service === "string") {
      updates.push({ id: "tuner.rdsService", value: r.program_service });
    }
    if (typeof r.program_type === "string") {
      updates.push({ id: "tuner.rdsProgramType", value: r.program_type });
    }
  }
  const dab = info.dab;
  if (typeof dab === "object" && dab !== null) {
    const d = dab;
    for (const { field, id, type } of DAB_FIELDS) {
      const value = d[field];
      if (typeof value === type) {
        updates.push({ id, value });
      }
    }
  }
  return updates;
}
function parseYxcPresetList(info) {
  const list = info == null ? void 0 : info.preset_info;
  if (!Array.isArray(list)) {
    return void 0;
  }
  const slots = [];
  list.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      return;
    }
    const { input, text } = entry;
    if (typeof input === "string" && input !== "unknown" && typeof text === "string" && text.length > 0) {
      slots.push({ num: index + 1, input, name: text });
    }
  });
  return { id: "player.netPlayer.presets", value: JSON.stringify(slots) };
}
function parseYxcRecentList(info) {
  const list = info == null ? void 0 : info.recent_info;
  if (!Array.isArray(list)) {
    return void 0;
  }
  const items = [];
  list.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      return;
    }
    const e = entry;
    if (typeof e.input !== "string" || typeof e.text !== "string" || e.text.length === 0) {
      return;
    }
    const item = {
      num: index + 1,
      input: e.input,
      name: e.text
    };
    if (typeof e.albumart_url === "string" && e.albumart_url.length > 0) {
      item.albumArt = e.albumart_url;
    }
    if (typeof e.play_count === "number") {
      item.playCount = e.play_count;
    }
    items.push(item);
  });
  return { id: "player.netPlayer.recent", value: JSON.stringify(items) };
}
function parseYxcTunerPresetLists(byBand) {
  const result = {};
  for (const [band, info] of Object.entries(byBand)) {
    const list = info == null ? void 0 : info.preset_info;
    if (!Array.isArray(list)) {
      continue;
    }
    const slots = [];
    list.forEach((entry, index) => {
      if (typeof entry === "object" && entry !== null) {
        slots.push({ num: index + 1, ...entry });
      }
    });
    result[band] = slots;
  }
  if (Object.keys(result).length === 0) {
    return void 0;
  }
  return { id: "tuner.presets", value: JSON.stringify(result) };
}
function formatAlarmTime(time) {
  return /^\d{4}$/.test(time) ? `${time.slice(0, 2)}:${time.slice(2)}` : time;
}
function parseAlarmDetail(prefix, detail) {
  const updates = [];
  if (typeof detail.enable === "boolean") {
    updates.push({ id: `${prefix}.enable`, value: detail.enable });
  }
  if (typeof detail.time === "string") {
    updates.push({ id: `${prefix}.time`, value: formatAlarmTime(detail.time) });
  }
  if (typeof detail.beep === "boolean") {
    updates.push({ id: `${prefix}.beep`, value: detail.beep });
  }
  if (typeof detail.playback_type === "string") {
    updates.push({ id: `${prefix}.playbackType`, value: detail.playback_type });
  }
  const resume = detail.resume;
  if (typeof resume === "object" && resume !== null && typeof resume.input === "string") {
    updates.push({ id: `${prefix}.resumeInput`, value: resume.input });
  }
  const preset = detail.preset;
  if (typeof preset === "object" && preset !== null) {
    const p = preset;
    if (typeof p.type === "string") {
      updates.push({ id: `${prefix}.presetType`, value: p.type });
    }
    if (typeof p.num === "number") {
      updates.push({ id: `${prefix}.presetNumber`, value: p.num });
    }
    if (typeof p.netusb_input === "string") {
      updates.push({ id: `${prefix}.presetInput`, value: p.netusb_input });
    }
  }
  return updates;
}
const ALARM_DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
function parseYxcClock(settings) {
  if (typeof settings !== "object" || settings === null) {
    return [];
  }
  const s = settings;
  const updates = [];
  if (typeof s.auto_sync === "boolean") {
    updates.push({ id: "clock.autoSync", value: s.auto_sync });
  }
  if (typeof s.format === "string") {
    updates.push({ id: "clock.format", value: s.format });
  }
  const alarm = s.alarm;
  if (typeof alarm === "object" && alarm !== null) {
    const a = alarm;
    if (typeof a.alarm_on === "boolean") {
      updates.push({ id: "clock.alarm.on", value: a.alarm_on });
    }
    if (typeof a.volume === "number") {
      updates.push({ id: "clock.alarm.volume", value: a.volume });
    }
    if (typeof a.fade_interval === "number") {
      updates.push({ id: "clock.alarm.fadeInterval", value: a.fade_interval });
    }
    if (typeof a.fade_type === "number") {
      updates.push({ id: "clock.alarm.fadeType", value: a.fade_type });
    }
    if (typeof a.mode === "string") {
      updates.push({ id: "clock.alarm.mode", value: a.mode });
    }
    if (typeof a.repeat === "boolean") {
      updates.push({ id: "clock.alarm.repeat", value: a.repeat });
    }
    const oneday = a.oneday;
    if (typeof oneday === "object" && oneday !== null) {
      updates.push(...parseAlarmDetail("clock.alarm.oneday", oneday));
    }
    for (const day of ALARM_DAYS) {
      const detail = a[day];
      if (typeof detail === "object" && detail !== null) {
        updates.push(...parseAlarmDetail(`clock.alarm.${day}`, detail));
      }
    }
  }
  return updates;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ALARM_DAYS,
  DAB_FIELDS,
  parseYxcClock,
  parseYxcDistribution,
  parseYxcPlayInfo,
  parseYxcPresetList,
  parseYxcRecentList,
  parseYxcStatus,
  parseYxcTunerInfo,
  parseYxcTunerPresetLists,
  stateToYxc
});
//# sourceMappingURL=command-mapper.js.map
