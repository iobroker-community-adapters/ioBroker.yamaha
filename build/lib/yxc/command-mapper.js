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
  stateToYxc: () => stateToYxc
});
module.exports = __toCommonJS(command_mapper_exports);
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
  }
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
    if (mapping.statusField in status) {
      updates.push({ id: `${prefix}${name}`, value: mapping.fromStatus(status[mapping.statusField]) });
    }
  }
  return updates;
}
function stateToYxc(stateId, value) {
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
  if (!mapping) {
    return void 0;
  }
  return { method: mapping.method, zone, value: mapping.toYxc(value) };
}
function parseYxcPlayInfo(playInfo) {
  if (typeof playInfo !== "object" || playInfo === null) {
    return [];
  }
  const info = playInfo;
  const updates = [];
  for (const field of ["playback", "artist", "album", "track"]) {
    const value = info[field];
    if (typeof value === "string") {
      updates.push({ id: `netPlayer.${field}`, value });
    }
  }
  return updates;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  parseYxcPlayInfo,
  parseYxcStatus,
  stateToYxc
});
//# sourceMappingURL=command-mapper.js.map
