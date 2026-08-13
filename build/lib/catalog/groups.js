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
  groupOf: () => groupOf
});
module.exports = __toCommonJS(groups_exports);
const SWITCHABLE_GROUPS = ["player", "tuner", "zones", "multiroom", "hdmi", "scene"];
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
  if (seg === "player" || PLAYER_CHANNELS.has(seg)) {
    return "player";
  }
  if (seg === "tuner" || seg === "dab") {
    return "tuner";
  }
  if (seg === "zone2" || seg === "zone3" || seg === "zone4") {
    return "zones";
  }
  if (seg === "multiroom" || seg === "dist") {
    return "multiroom";
  }
  if (seg === "hdmi") {
    return "hdmi";
  }
  if (seg === "scene") {
    return "scene";
  }
  return "amp";
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SWITCHABLE_GROUPS,
  groupOf
});
//# sourceMappingURL=groups.js.map
