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
var zones_exports = {};
__export(zones_exports, {
  YXC_ZONE_IDS: () => YXC_ZONE_IDS,
  zonePrefix: () => zonePrefix
});
module.exports = __toCommonJS(zones_exports);
const YXC_ZONE_IDS = ["main", "zone2", "zone3", "zone4"];
function zonePrefix(zone) {
  return zone === "main" ? "" : `multiroom.${zone}.`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  YXC_ZONE_IDS,
  zonePrefix
});
//# sourceMappingURL=zones.js.map
