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
  parseYxcPlayInfo: () => parseYxcPlayInfo,
  parseYxcStatus: () => parseYxcStatus,
  parseYxcTunerInfo: () => parseYxcTunerInfo,
  stateToYxc: () => stateToYxc
});
module.exports = __toCommonJS(command_mapper_exports);
function readStatusField(status, mapping) {
  if (mapping.path) {
    let value = status;
    for (const key of mapping.path) {
      if (typeof value !== "object" || value === null) {
        return void 0;
      }
      value = value[key];
    }
    return value;
  }
  return mapping.statusField !== void 0 ? status[mapping.statusField] : void 0;
}
const YXC_STATE_MAPPINGS = {
  power: { statusField: "power", method: "power", toYxc: (value) => Boolean(value), fromStatus: (value) => value === "on" },
  volume: {
    statusField: "volume",
    method: "setVolumeTo",
    toYxc: (value) => Number(value),
    fromStatus: (value) => Number(value)
  },
  mute: { statusField: "mute", method: "mute", toYxc: (value) => Boolean(value), fromStatus: (value) => Boolean(value) },
  input: {
    statusField: "input",
    method: "setInput",
    toYxc: (value) => String(value),
    fromStatus: (value) => String(value)
  },
  soundProgram: {
    statusField: "sound_program",
    method: "setSound",
    toYxc: (value) => String(value),
    fromStatus: (value) => String(value)
  },
  enhancer: {
    statusField: "enhancer",
    method: "setEnhancer",
    toYxc: (value) => Boolean(value),
    fromStatus: (value) => Boolean(value)
  },
  pureDirect: {
    statusField: "pure_direct",
    method: "setPureDirect",
    toYxc: (value) => Boolean(value),
    fromStatus: (value) => Boolean(value)
  },
  subwooferVolume: {
    statusField: "subwoofer_volume",
    method: "setSubwooferVolumeTo",
    toYxc: (value) => Number(value),
    fromStatus: (value) => Number(value)
  },
  bass: {
    path: ["tone_control", "bass"],
    method: "setBassTo",
    toYxc: (value) => Number(value),
    fromStatus: (value) => Number(value)
  },
  treble: {
    path: ["tone_control", "treble"],
    method: "setTrebleTo",
    toYxc: (value) => Number(value),
    fromStatus: (value) => Number(value)
  },
  sleep: { statusField: "sleep", method: "sleep", toYxc: (value) => Number(value), fromStatus: (value) => Number(value) },
  dialogueLevel: { statusField: "dialogue_level", fromStatus: (value) => Number(value) },
  actualVolume: { path: ["actual_volume", "value"], fromStatus: (value) => Number(value) },
  contentsDisplay: { statusField: "contents_display", fromStatus: (value) => Boolean(value) },
  surroundDecoder: { statusField: "surr_decoder_type", fromStatus: (value) => String(value) },
  audioSelect: { statusField: "audio_select", fromStatus: (value) => String(value) },
  linkControl: { statusField: "link_control", fromStatus: (value) => String(value) },
  linkAudioDelay: { statusField: "link_audio_delay", fromStatus: (value) => String(value) },
  linkAudioQuality: { statusField: "link_audio_quality", fromStatus: (value) => String(value) }
};
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
  for (const [name, mapping] of Object.entries(YXC_STATE_MAPPINGS)) {
    const raw = readStatusField(status, mapping);
    if (raw !== void 0) {
      updates.push({ id: `${prefix}${name}`, value: mapping.fromStatus(raw) });
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
  const mapping = YXC_STATE_MAPPINGS[name];
  if (!mapping || mapping.method === void 0 || mapping.toYxc === void 0) {
    return void 0;
  }
  return { method: mapping.method, zone, value: mapping.toYxc(value) };
}
function parseYxcPlayInfo(playInfo, prefix = "netPlayer") {
  if (typeof playInfo !== "object" || playInfo === null) {
    return [];
  }
  const info = playInfo;
  const updates = [];
  for (const field of ["playback", "artist", "album", "track"]) {
    const value = info[field];
    if (typeof value === "string") {
      updates.push({ id: `${prefix}.${field}`, value });
    }
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
  parseYxcPlayInfo,
  parseYxcStatus,
  parseYxcTunerInfo,
  stateToYxc
});
//# sourceMappingURL=command-mapper.js.map
