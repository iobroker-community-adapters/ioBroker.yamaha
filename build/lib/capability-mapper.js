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
var capability_mapper_exports = {};
__export(capability_mapper_exports, {
  mapYncaToObjects: () => mapYncaToObjects
});
module.exports = __toCommonJS(capability_mapper_exports);
const AMP_STATES = [
  {
    func: "PWR",
    state: "power",
    common: { name: "Power", type: "boolean", role: "switch.power", read: true, write: true }
  },
  {
    func: "VOL",
    state: "volume",
    common: { name: "Volume", type: "number", role: "level.volume", read: true, write: true, unit: "dB" }
  },
  {
    func: "MUTE",
    state: "mute",
    common: { name: "Mute", type: "boolean", role: "media.mute", read: true, write: true }
  },
  {
    func: "INP",
    state: "input",
    common: { name: "Input", type: "string", role: "media.input", read: true, write: true }
  },
  {
    func: "SOUNDPRG",
    state: "soundProgram",
    common: { name: "Sound program", type: "string", role: "state", read: true, write: true }
  },
  {
    func: "STRAIGHT",
    state: "straight",
    common: { name: "Straight", type: "boolean", role: "switch", read: true, write: true }
  },
  {
    func: "ENHANCER",
    state: "enhancer",
    common: { name: "Enhancer", type: "boolean", role: "switch", read: true, write: true }
  },
  {
    func: "PUREDIRMODE",
    state: "pureDirect",
    common: { name: "Pure Direct", type: "boolean", role: "switch", read: true, write: true }
  },
  {
    func: "SLEEP",
    state: "sleep",
    common: { name: "Sleep timer", type: "string", role: "state", read: true, write: true }
  }
];
const ZONES = [
  { subunit: "MAIN", prefix: "" },
  { subunit: "ZONE2", prefix: "zone2.", channel: "zone2", channelName: "Zone 2" },
  { subunit: "ZONE3", prefix: "zone3.", channel: "zone3", channelName: "Zone 3" },
  { subunit: "ZONE4", prefix: "zone4.", channel: "zone4", channelName: "Zone 4" }
];
function mapYncaToObjects(capabilities) {
  var _a;
  const objects = [];
  for (const zone of ZONES) {
    const funcs = capabilities.subunits[zone.subunit];
    if (!funcs) {
      continue;
    }
    const applicable = AMP_STATES.filter((def) => def.func in funcs);
    if (applicable.length === 0) {
      continue;
    }
    if (zone.channel) {
      objects.push({ id: zone.channel, type: "channel", common: { name: (_a = zone.channelName) != null ? _a : zone.channel } });
    }
    for (const def of applicable) {
      objects.push({ id: `${zone.prefix}${def.state}`, type: "state", common: { ...def.common } });
    }
  }
  return objects;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  mapYncaToObjects
});
//# sourceMappingURL=capability-mapper.js.map
