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
var catalog_exports = {};
__export(catalog_exports, {
  XML_AMP_CATALOG: () => XML_AMP_CATALOG
});
module.exports = __toCommonJS(catalog_exports);
const XML_AMP_CATALOG = [
  {
    state: "power",
    common: { name: "Power", type: "boolean", role: "switch.power", read: true, write: true },
    statusField: "power",
    toInner: (value) => `<Power_Control><Power>${value ? "On" : "Standby"}</Power></Power_Control>`
  },
  {
    state: "volume",
    common: {
      name: "Volume",
      type: "number",
      role: "level.volume",
      read: true,
      write: true,
      unit: "dB",
      min: -80.5,
      max: 16.5,
      step: 0.5
    },
    statusField: "volume",
    toInner: (value) => `<Volume><Lvl><Val>${Math.round(Number(value) * 10)}</Val><Exp>1</Exp><Unit>dB</Unit></Lvl></Volume>`
  },
  {
    state: "mute",
    common: { name: "Mute", type: "boolean", role: "media.mute", read: true, write: true },
    statusField: "mute",
    toInner: (value) => `<Volume><Mute>${value ? "On" : "Off"}</Mute></Volume>`
  },
  {
    state: "input",
    common: { name: "Input", type: "string", role: "media.input", read: true, write: true },
    statusField: "input",
    toInner: (value) => `<Input><Input_Sel>${String(value)}</Input_Sel></Input>`
  },
  {
    state: "soundProgram",
    common: { name: "Sound program", type: "string", role: "state", read: true, write: true },
    statusField: "soundProgram",
    toInner: (value) => `<Surround><Program_Sel><Current><Sound_Program>${String(value)}</Sound_Program></Current></Program_Sel></Surround>`
  },
  {
    state: "pureDirect",
    common: { name: "Pure Direct", type: "boolean", role: "switch", read: true, write: true },
    statusField: "pureDirect",
    toInner: (value) => `<Sound_Video><Pure_Direct><Mode>${value ? "On" : "Off"}</Mode></Pure_Direct></Sound_Video>`
  },
  {
    state: "straight",
    common: { name: "Straight", type: "boolean", role: "switch", read: true, write: true },
    statusField: "straight",
    toInner: (value) => `<Surround><Program_Sel><Current><Straight>${value ? "On" : "Off"}</Straight></Current></Program_Sel></Surround>`
  },
  {
    state: "direct",
    common: { name: "Direct", type: "boolean", role: "switch", read: true, write: true },
    statusField: "direct",
    toInner: (value) => `<Sound_Video><Direct><Mode>${value ? "On" : "Off"}</Mode></Direct></Sound_Video>`
  },
  {
    state: "adaptiveDrc",
    common: { name: "Adaptive DRC", type: "string", role: "state", read: true, write: true },
    statusField: "adaptiveDrc",
    toInner: (value) => `<Sound_Video><Adaptive_DRC>${String(value)}</Adaptive_DRC></Sound_Video>`
  },
  {
    // Read-only: openHAB reads the Dialogue_Lvl path, but the write value structure
    // (Val/Exp/Unit vs bare) is not confirmed by a reference, so no write is offered.
    state: "dialogueLevel",
    common: { name: "Dialogue level", type: "number", role: "level", read: true, write: false },
    statusField: "dialogueLevel"
  },
  {
    state: "sleep",
    common: { name: "Sleep timer", type: "string", role: "state", read: true, write: true },
    statusField: "sleep",
    toInner: (value) => `<Power_Control><Sleep>${String(value)}</Sleep></Power_Control>`
  },
  // Tone, subwoofer trim and the Extra-Bass/YPAO toggles — exposed by the predecessor
  // adapter (yamaha-nodejs-soef) on real pre-2010 devices, and dropped in the rewrite.
  // Values verified against that library's PUT paths (audit findings F3/F4).
  {
    state: "bass",
    common: { name: "Bass", type: "number", role: "level", read: true, write: true, unit: "dB" },
    statusField: "bass",
    toInner: (value) => `<Sound_Video><Tone><Bass><Val>${Number(value)}</Val><Exp>1</Exp><Unit>dB</Unit></Bass></Tone></Sound_Video>`
  },
  {
    state: "treble",
    common: { name: "Treble", type: "number", role: "level", read: true, write: true, unit: "dB" },
    statusField: "treble",
    toInner: (value) => `<Sound_Video><Tone><Treble><Val>${Number(value)}</Val><Exp>1</Exp><Unit>dB</Unit></Treble></Tone></Sound_Video>`
  },
  {
    state: "subwooferTrim",
    common: { name: "Subwoofer trim", type: "number", role: "level", read: true, write: true, unit: "dB" },
    statusField: "subwooferTrim",
    toInner: (value) => `<Volume><Subwoofer_Trim><Val>${Number(value)}</Val><Exp>1</Exp><Unit>dB</Unit></Subwoofer_Trim></Volume>`
  },
  {
    state: "extraBass",
    common: { name: "Extra Bass", type: "boolean", role: "switch", read: true, write: true },
    statusField: "extraBass",
    toInner: (value) => `<Sound_Video><Extra_Bass>${value ? "Auto" : "Off"}</Extra_Bass></Sound_Video>`
  },
  {
    state: "ypaoVolume",
    common: { name: "YPAO Volume", type: "boolean", role: "switch", read: true, write: true },
    statusField: "ypaoVolume",
    toInner: (value) => `<Sound_Video><YPAO_Volume>${value ? "Auto" : "Off"}</YPAO_Volume></Sound_Video>`
  }
];
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  XML_AMP_CATALOG
});
//# sourceMappingURL=catalog.js.map
