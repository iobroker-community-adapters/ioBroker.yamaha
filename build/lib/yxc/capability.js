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
var capability_exports = {};
__export(capability_exports, {
  parseYxcFeatures: () => parseYxcFeatures
});
module.exports = __toCommonJS(capability_exports);
const MEDIA_BLOCKS = ["netusb", "tuner", "cd", "clock"];
function stringList(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}
function parseYxcFeatures(response) {
  if (typeof response !== "object" || response === null) {
    return { zones: [], media: [] };
  }
  const obj = response;
  const zones = [];
  if (Array.isArray(obj.zone)) {
    for (const entry of obj.zone) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const zone = entry;
      if (typeof zone.id === "string") {
        zones.push({ id: zone.id, funcs: stringList(zone.func_list), inputs: stringList(zone.input_list) });
      }
    }
  }
  const media = MEDIA_BLOCKS.filter((block) => block in obj);
  return { zones, media };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  parseYxcFeatures
});
//# sourceMappingURL=capability.js.map
