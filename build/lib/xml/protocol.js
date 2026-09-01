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
  assertXmlOk: () => assertXmlOk,
  encodeGet: () => encodeGet,
  encodePut: () => encodePut,
  parseBasicStatus: () => parseBasicStatus,
  parseInputList: () => parseInputList,
  parseModelName: () => parseModelName,
  parseReturnCode: () => parseReturnCode,
  parseSceneList: () => parseSceneList,
  parseTunerInfo: () => parseTunerInfo
});
module.exports = __toCommonJS(protocol_exports);
var import_entities = require("./entities");
function parseReturnCode(xml) {
  const match = /<YAMAHA_AV[^>]*\bRC="(\d+)"/.exec(xml);
  return match ? Number(match[1]) : void 0;
}
function assertXmlOk(xml, what) {
  if (xml.length === 0) {
    throw new Error(`device refused ${what} (empty response)`);
  }
  const code = parseReturnCode(xml);
  if (code !== void 0 && code !== 0) {
    throw new Error(`device refused ${what} (RC=${code})`);
  }
  return xml;
}
function parseSceneList(xml) {
  const scenes = [];
  const pattern = /<Item_\d+>\s*<Param>Scene (\d+)<\/Param>\s*<RW>([^<]*)<\/RW>\s*<Title>([^<]*)<\/Title>/g;
  for (let match = pattern.exec(xml); match; match = pattern.exec(xml)) {
    if (match[2].includes("W")) {
      scenes.push({ num: Number(match[1]), title: (0, import_entities.decodeXmlText)(match[3]) });
    }
  }
  return scenes;
}
function parseInputList(xml) {
  const inputs = [];
  const pattern = /<Item_\d+>\s*<Param>([^<]+)<\/Param>/g;
  for (let match = pattern.exec(xml); match; match = pattern.exec(xml)) {
    inputs.push((0, import_entities.decodeXmlText)(match[1]));
  }
  return inputs;
}
function parseTunerInfo(xml) {
  const info = {};
  const preset = /<Preset>\s*<Preset_Sel>([^<]+)<\/Preset_Sel>/.exec(xml);
  if (preset) {
    const slot = Number(preset[1]);
    info.preset = Number.isFinite(slot) ? slot : 0;
  }
  const freq = /<Freq>\s*(?:<Current>\s*)?<Val>(-?\d+)<\/Val>\s*<Exp>(\d+)<\/Exp>\s*<Unit>([^<]*)<\/Unit>/.exec(xml);
  if (freq) {
    info.frequency = Number(freq[1]) / 10 ** Number(freq[2]);
    info.frequencyUnit = freq[3];
  }
  const service = /<Program_Service>([^<]*)<\/Program_Service>/.exec(xml);
  if (service) {
    info.rdsService = (0, import_entities.decodeXmlText)(service[1]);
  }
  const text = /<Radio_Text>([^<]*)<\/Radio_Text>/.exec(xml);
  if (text) {
    info.rdsText = (0, import_entities.decodeXmlText)(text[1]);
  }
  const tuned = /<Tuned>(Assert|Negate)<\/Tuned>/.exec(xml);
  if (tuned) {
    info.tuned = tuned[1] === "Assert";
  }
  const stereo = /<Stereo>(Assert|Negate)<\/Stereo>/.exec(xml);
  if (stereo) {
    info.stereo = stereo[1] === "Assert";
  }
  return info;
}
function encodePut(zone, inner) {
  return `<YAMAHA_AV cmd="PUT"><${zone}>${inner}</${zone}></YAMAHA_AV>`;
}
function encodeGet(zone, inner) {
  return `<YAMAHA_AV cmd="GET"><${zone}>${inner}</${zone}></YAMAHA_AV>`;
}
function parseModelName(xml) {
  const match = /<Model_Name>([^<]*)<\/Model_Name>/.exec(xml);
  return match && match[1].length > 0 ? (0, import_entities.decodeXmlText)(match[1]) : void 0;
}
function parseBasicStatus(xml) {
  const status = {};
  const power = /<Power>(On|Standby)<\/Power>/.exec(xml);
  if (power) {
    status.power = power[1] === "On";
  }
  const volume = /<Volume>\s*<Lvl>\s*<Val>(-?\d+)<\/Val>/.exec(xml);
  if (volume) {
    status.volume = Number(volume[1]) / 10;
  }
  const mute = /<Mute>(On|Off)<\/Mute>/.exec(xml);
  if (mute) {
    status.mute = mute[1] === "On";
  }
  const input = /<Input_Sel>([^<]+)<\/Input_Sel>/.exec(xml);
  if (input) {
    status.input = (0, import_entities.decodeXmlText)(input[1]);
  }
  const soundProgram = /<Sound_Program>([^<]+)<\/Sound_Program>/.exec(xml);
  if (soundProgram) {
    status.soundProgram = (0, import_entities.decodeXmlText)(soundProgram[1]);
  }
  const pureDirect = /<Pure_Direct>\s*<Mode>(On|Off)<\/Mode>/.exec(xml);
  if (pureDirect) {
    status.pureDirect = pureDirect[1] === "On";
  }
  const straight = /<Straight>(On|Off)<\/Straight>/.exec(xml);
  if (straight) {
    status.straight = straight[1] === "On";
  }
  const direct = /<Direct>\s*<Mode>(On|Off)<\/Mode>/.exec(xml);
  if (direct) {
    status.direct = direct[1] === "On";
  }
  const adaptiveDrc = /<Adaptive_DRC>(Auto|Off)<\/Adaptive_DRC>/.exec(xml);
  if (adaptiveDrc) {
    status.adaptiveDrc = (0, import_entities.decodeXmlText)(adaptiveDrc[1]);
  }
  const dialogueLevel = /<Dialogue_Lvl>\s*<Val>(-?\d+)<\/Val>/.exec(xml);
  if (dialogueLevel) {
    status.dialogueLevel = Number(dialogueLevel[1]);
  }
  const sleepMatch = /<Sleep>([^<]+)<\/Sleep>/.exec(xml);
  if (sleepMatch) {
    status.sleep = (0, import_entities.decodeXmlText)(sleepMatch[1]);
  }
  const bass = /<Bass>\s*<Val>(-?\d+)<\/Val>/.exec(xml);
  if (bass) {
    status.bass = Number(bass[1]) / 10;
  }
  const treble = /<Treble>\s*<Val>(-?\d+)<\/Val>/.exec(xml);
  if (treble) {
    status.treble = Number(treble[1]) / 10;
  }
  const subwooferTrim = /<Subwoofer_Trim>\s*<Val>(-?\d+)<\/Val>/.exec(xml);
  if (subwooferTrim) {
    status.subwooferTrim = Number(subwooferTrim[1]) / 10;
  }
  const extraBass = /<Extra_Bass>([^<]+)<\/Extra_Bass>/.exec(xml);
  if (extraBass) {
    status.extraBass = extraBass[1] !== "Off";
  }
  const ypaoVolume = /<YPAO_Volume>([^<]+)<\/YPAO_Volume>/.exec(xml);
  if (ypaoVolume) {
    status.ypaoVolume = ypaoVolume[1] !== "Off";
  }
  const hdmiOut1 = /<OUT_1>(On|Off)<\/OUT_1>/.exec(xml);
  if (hdmiOut1) {
    status.hdmiOut1 = hdmiOut1[1] === "On";
  }
  const hdmiOut2 = /<OUT_2>(On|Off)<\/OUT_2>/.exec(xml);
  if (hdmiOut2) {
    status.hdmiOut2 = hdmiOut2[1] === "On";
  }
  const party = /<Party_Info>([^<]+)<\/Party_Info>/.exec(xml);
  if (party) {
    status.party = party[1] === "On";
  }
  const dialogueLift = /<Dialogue_Lift>(-?\d+)<\/Dialogue_Lift>/.exec(xml);
  if (dialogueLift) {
    status.dialogueLift = Number(dialogueLift[1]);
  }
  return status;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  assertXmlOk,
  encodeGet,
  encodePut,
  parseBasicStatus,
  parseInputList,
  parseModelName,
  parseReturnCode,
  parseSceneList,
  parseTunerInfo
});
//# sourceMappingURL=protocol.js.map
