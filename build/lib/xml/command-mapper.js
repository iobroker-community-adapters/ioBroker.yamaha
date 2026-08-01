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
const XML_STATE_MAPPINGS = {
  power: {
    toInner: (value) => `<Power_Control><Power>${value ? "On" : "Standby"}</Power></Power_Control>`,
    statusField: "power"
  },
  volume: {
    toInner: (value) => `<Volume><Lvl><Val>${Math.round(Number(value) * 10)}</Val><Exp>1</Exp><Unit>dB</Unit></Lvl></Volume>`,
    statusField: "volume"
  },
  mute: { toInner: (value) => `<Volume><Mute>${value ? "On" : "Off"}</Mute></Volume>`, statusField: "mute" },
  input: { toInner: (value) => `<Input><Input_Sel>${String(value)}</Input_Sel></Input>`, statusField: "input" }
};
const ZONE_ELEMENT = { main: "Main_Zone", zone2: "Zone_2", zone3: "Zone_3", zone4: "Zone_4" };
const ZONE_PREFIX = { main: "", zone2: "zone2.", zone3: "zone3.", zone4: "zone4." };
function stateToXml(stateId, value) {
  let zoneKey = "main";
  let name = stateId;
  const dot = stateId.indexOf(".");
  if (dot > 0) {
    zoneKey = stateId.slice(0, dot);
    name = stateId.slice(dot + 1);
  }
  const zone = ZONE_ELEMENT[zoneKey];
  const mapping = XML_STATE_MAPPINGS[name];
  if (!zone || !mapping) {
    return void 0;
  }
  return { zone, inner: mapping.toInner(value) };
}
function parseXmlStatus(status, zone) {
  const prefix = ZONE_PREFIX[zone];
  if (prefix === void 0) {
    return [];
  }
  const updates = [];
  for (const [name, mapping] of Object.entries(XML_STATE_MAPPINGS)) {
    const value = status[mapping.statusField];
    if (value !== void 0) {
      updates.push({ id: `${prefix}${name}`, value });
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
