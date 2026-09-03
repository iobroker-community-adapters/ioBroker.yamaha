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
var scene_titles_exports = {};
__export(scene_titles_exports, {
  knownScenes: () => knownScenes,
  resolveSceneNumber: () => resolveSceneNumber
});
module.exports = __toCommonJS(scene_titles_exports);
var import_protocol = require("../xml/protocol");
function knownScenes(memory, zoneKey) {
  var _a;
  if (!memory) {
    return [];
  }
  const xml = memory.remembered(`xmlScenes:${zoneKey}`);
  if (typeof xml === "string" && xml.length > 0) {
    const scenes = (0, import_protocol.parseSceneList)(xml);
    if (scenes.length > 0) {
      return scenes;
    }
  }
  if (zoneKey === "main") {
    const statics = memory.remembered("yncaStaticValues");
    const main = (_a = statics == null ? void 0 : statics.MAIN) != null ? _a : {};
    const scenes = [];
    for (let n = 1; n <= 12; n++) {
      const title = main[`SCENE${n}NAME`];
      if (typeof title === "string" && title.length > 0) {
        scenes.push({ num: n, title });
      }
    }
    return scenes;
  }
  return [];
}
function resolveSceneNumber(value, memory, zoneKey) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value !== "string") {
    return void 0;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const needle = trimmed.toLowerCase();
  const match = knownScenes(memory, zoneKey).find((scene) => scene.title.toLowerCase() === needle);
  return match == null ? void 0 : match.num;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  knownScenes,
  resolveSceneNumber
});
//# sourceMappingURL=scene-titles.js.map
