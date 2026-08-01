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
const YXC_STATES = [
  {
    func: "power",
    state: "power",
    common: { name: "Power", type: "boolean", role: "switch.power", read: true, write: true }
  },
  {
    func: "volume",
    state: "volume",
    common: { name: "Volume", type: "number", role: "level.volume", read: true, write: true }
  },
  {
    func: "mute",
    state: "mute",
    common: { name: "Mute", type: "boolean", role: "media.mute", read: true, write: true }
  },
  {
    func: "sound_program",
    state: "soundProgram",
    common: { name: "Sound program", type: "string", role: "state", read: true, write: true }
  }
];
const INPUT_COMMON = {
  name: "Input",
  type: "string",
  role: "media.input",
  read: true,
  write: true
};
const ZONES = [
  { id: "main", prefix: "" },
  { id: "zone2", prefix: "zone2.", channel: "zone2", channelName: "Zone 2" },
  { id: "zone3", prefix: "zone3.", channel: "zone3", channelName: "Zone 3" },
  { id: "zone4", prefix: "zone4.", channel: "zone4", channelName: "Zone 4" }
];
function mapYxcToObjects(capabilities) {
  var _a;
  const objects = [];
  for (const zoneDef of ZONES) {
    const zone = capabilities.zones.find((z) => z.id === zoneDef.id);
    if (!zone) {
      continue;
    }
    const states = YXC_STATES.filter((state) => zone.funcs.includes(state.func));
    const hasInput = zone.inputs.length > 0;
    if (states.length === 0 && !hasInput) {
      continue;
    }
    if (zoneDef.channel) {
      objects.push({ id: zoneDef.channel, type: "channel", common: { name: (_a = zoneDef.channelName) != null ? _a : zoneDef.channel } });
    }
    for (const state of states) {
      const common = { ...state.common };
      if (state.state === "volume" && zone.volumeRange) {
        common.min = zone.volumeRange.min;
        common.max = zone.volumeRange.max;
        common.step = zone.volumeRange.step;
      }
      objects.push({ id: `${zoneDef.prefix}${state.state}`, type: "state", common });
    }
    if (hasInput) {
      objects.push({ id: `${zoneDef.prefix}input`, type: "state", common: { ...INPUT_COMMON } });
    }
  }
  return objects;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  mapYxcToObjects
});
//# sourceMappingURL=object-mapper.js.map
