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
var groups_exports = {};
__export(groups_exports, {
  SWITCHABLE_GROUPS: () => SWITCHABLE_GROUPS,
  groupOf: () => groupOf,
  isGroupEnabled: () => isGroupEnabled
});
module.exports = __toCommonJS(groups_exports);
const SWITCHABLE_GROUPS = [
  "player",
  "tuner",
  "multiroom",
  "hdmi",
  "scene",
  "sound",
  "advanced"
];
const PLAYER_CHANNELS = /* @__PURE__ */ new Set([
  "netRadio",
  "server",
  "usb",
  "spotify",
  "deezer",
  "tidal",
  "napster",
  "pandora",
  "rhapsody",
  "sirius",
  "airplay",
  "bluetooth",
  "pc",
  "musicCastLink",
  "ipod",
  "ipodUsb",
  "netPlayer",
  "cd"
]);
function groupOf(stateId) {
  const seg = stateId.includes(".") ? stateId.slice(0, stateId.indexOf(".")) : stateId;
  if (seg === "multiroom") {
    return "multiroom";
  }
  if (seg === "hdmi" || seg === "lipSync") {
    return "hdmi";
  }
  if (seg === "player" || PLAYER_CHANNELS.has(seg)) {
    return "player";
  }
  if (seg === "tuner" || seg === "dab") {
    return "tuner";
  }
  if (seg === "sound") {
    return "sound";
  }
  if (seg === "advanced") {
    return "advanced";
  }
  if (seg === "scene") {
    return "scene";
  }
  return "amp";
}
function isGroupEnabled(stateId, config) {
  const group = groupOf(stateId);
  if (group === "amp") {
    return true;
  }
  return config[`group_${group}`] !== false;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SWITCHABLE_GROUPS,
  groupOf,
  isGroupEnabled
});
//# sourceMappingURL=groups.js.map
