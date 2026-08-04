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
var protocol_exports = {};
__export(protocol_exports, {
  encodeGet: () => encodeGet,
  encodePut: () => encodePut,
  parseBasicStatus: () => parseBasicStatus
});
module.exports = __toCommonJS(protocol_exports);
function encodePut(zone, inner) {
  return `<YAMAHA_AV cmd="PUT"><${zone}>${inner}</${zone}></YAMAHA_AV>`;
}
function encodeGet(zone, inner) {
  return `<YAMAHA_AV cmd="GET"><${zone}>${inner}</${zone}></YAMAHA_AV>`;
}
function parseBasicStatus(xml) {
  const status = {};
  const power = /<Power>(On|Standby)<\/Power>/.exec(xml);
  if (power) {
    status.power = power[1] === "On";
  }
  const val = /<Val>(-?\d+)<\/Val>/.exec(xml);
  if (val) {
    status.volume = Number(val[1]) / 10;
  }
  const mute = /<Mute>(On|Off)<\/Mute>/.exec(xml);
  if (mute) {
    status.mute = mute[1] === "On";
  }
  const input = /<Input_Sel>([^<]+)<\/Input_Sel>/.exec(xml);
  if (input) {
    status.input = input[1];
  }
  const soundProgram = /<Sound_Program>([^<]+)<\/Sound_Program>/.exec(xml);
  if (soundProgram) {
    status.soundProgram = soundProgram[1];
  }
  const pureDirect = /<Pure_Direct>\s*<Mode>(On|Off)<\/Mode>/.exec(xml);
  if (pureDirect) {
    status.pureDirect = pureDirect[1] === "On";
  }
  const sleep = /<Sleep>([^<]+)<\/Sleep>/.exec(xml);
  if (sleep) {
    status.sleep = sleep[1];
  }
  return status;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  encodeGet,
  encodePut,
  parseBasicStatus
});
//# sourceMappingURL=protocol.js.map
