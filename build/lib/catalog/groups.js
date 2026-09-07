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
  groupsOf: () => groupsOf,
  isGroupEnabled: () => isGroupEnabled
});
module.exports = __toCommonJS(groups_exports);
var import_owner_policy = require("./owner-policy");
const SWITCHABLE_GROUPS = [
  "player",
  "tuner",
  "multiroom",
  "hdmi",
  "scene",
  "sound",
  "advanced",
  "clock"
];
function groupOf(stateId) {
  const template = stateId.replace(import_owner_policy.ZONE_PREFIX, "");
  const seg = template.includes(".") ? template.slice(0, template.indexOf(".")) : template;
  if (seg === "multiroom") {
    return "multiroom";
  }
  if (seg === "hdmi") {
    return "hdmi";
  }
  if (seg === "player" || seg === "remote") {
    return "player";
  }
  if (seg === "tuner") {
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
  if (seg === "clock") {
    return "clock";
  }
  return "amp";
}
function groupsOf(stateId) {
  const theme = groupOf(stateId);
  if (!import_owner_policy.ZONE_PREFIX.test(stateId) || theme === "multiroom") {
    return [theme];
  }
  return ["multiroom", theme];
}
function isGroupEnabled(stateId, config) {
  return groupsOf(stateId).every((group) => group === "amp" || config[`group_${group}`] !== false);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SWITCHABLE_GROUPS,
  groupOf,
  groupsOf,
  isGroupEnabled
});
//# sourceMappingURL=groups.js.map
