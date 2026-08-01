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
var push_exports = {};
__export(push_exports, {
  zonesToRefresh: () => zonesToRefresh
});
module.exports = __toCommonJS(push_exports);
const ZONE_KEYS = ["main", "zone2", "zone3", "zone4"];
function zonesToRefresh(pushEvent) {
  if (typeof pushEvent !== "object" || pushEvent === null) {
    return [];
  }
  const event = pushEvent;
  return ZONE_KEYS.filter((zone) => zone in event);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  zonesToRefresh
});
//# sourceMappingURL=push.js.map
