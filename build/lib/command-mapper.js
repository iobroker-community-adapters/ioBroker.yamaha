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
  stateToYnca: () => stateToYnca,
  yncaToState: () => yncaToState
});
module.exports = __toCommonJS(command_mapper_exports);
const STATE_MAPPINGS = {
  power: { func: "PWR", toYnca: (value) => value ? "On" : "Standby", fromYnca: (value) => value === "On" },
  volume: { func: "VOL", toYnca: (value) => Number(value).toFixed(1), fromYnca: (value) => Number.parseFloat(value) },
  mute: { func: "MUTE", toYnca: (value) => value ? "On" : "Off", fromYnca: (value) => value === "On" },
  input: { func: "INP", toYnca: (value) => String(value), fromYnca: (value) => value },
  soundProgram: { func: "SOUNDPRG", toYnca: (value) => String(value), fromYnca: (value) => value }
};
const ZONE_TO_SUBUNIT = { zone2: "ZONE2", zone3: "ZONE3", zone4: "ZONE4" };
const SUBUNIT_TO_PREFIX = { MAIN: "", ZONE2: "zone2.", ZONE3: "zone3.", ZONE4: "zone4." };
function stateToYnca(stateId, value) {
  let subunit = "MAIN";
  let name = stateId;
  const dot = stateId.indexOf(".");
  if (dot > 0) {
    const zone = ZONE_TO_SUBUNIT[stateId.slice(0, dot)];
    if (!zone) {
      return void 0;
    }
    subunit = zone;
    name = stateId.slice(dot + 1);
  }
  const mapping = STATE_MAPPINGS[name];
  if (!mapping) {
    return void 0;
  }
  return { subunit, func: mapping.func, value: mapping.toYnca(value) };
}
function yncaToState(message) {
  const prefix = SUBUNIT_TO_PREFIX[message.subunit];
  if (prefix === void 0) {
    return void 0;
  }
  for (const [name, mapping] of Object.entries(STATE_MAPPINGS)) {
    if (mapping.func === message.func) {
      return { id: `${prefix}${name}`, value: mapping.fromYnca(message.value) };
    }
  }
  return void 0;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  stateToYnca,
  yncaToState
});
//# sourceMappingURL=command-mapper.js.map
