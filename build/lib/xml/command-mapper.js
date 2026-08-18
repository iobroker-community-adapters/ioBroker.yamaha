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
  parseXmlStatus: () => parseXmlStatus,
  stateToXml: () => stateToXml
});
module.exports = __toCommonJS(command_mapper_exports);
var import_value_coerce = require("../catalog/value-coerce");
var import_catalog = require("./catalog");
const ZONE_ELEMENT = { main: "Main_Zone", zone2: "Zone_2", zone3: "Zone_3", zone4: "Zone_4" };
const ZONE_PREFIX = {
  main: "",
  zone2: "multiroom.zone2.",
  zone3: "multiroom.zone3.",
  zone4: "multiroom.zone4."
};
function stateToXml(stateId, value) {
  var _a;
  let zoneKey = "main";
  let name = stateId;
  const zoneMatch = /^multiroom\.(zone[234])\.(.+)$/.exec(stateId);
  if (zoneMatch) {
    zoneKey = zoneMatch[1];
    name = zoneMatch[2];
  }
  const entry = import_catalog.XML_AMP_CATALOG.find((e) => e.state === name);
  if (!(entry == null ? void 0 : entry.toInner) || entry.mainOnly && zoneKey !== "main" || !(0, import_value_coerce.isWritableValue)(value, entry.common.type === "number")) {
    return void 0;
  }
  const zone = (_a = entry.writeZone) != null ? _a : ZONE_ELEMENT[zoneKey];
  if (!zone) {
    return void 0;
  }
  return { zone, inner: entry.toInner(value) };
}
function parseXmlStatus(status, zone) {
  const prefix = ZONE_PREFIX[zone];
  if (prefix === void 0) {
    return [];
  }
  const updates = [];
  for (const entry of import_catalog.XML_AMP_CATALOG) {
    const value = entry.statusField ? status[entry.statusField] : void 0;
    if (value !== void 0) {
      updates.push({ id: `${prefix}${entry.state}`, value });
    }
  }
  return updates;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  parseXmlStatus,
  stateToXml
});
//# sourceMappingURL=command-mapper.js.map
