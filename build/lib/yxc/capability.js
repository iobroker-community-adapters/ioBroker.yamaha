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
var capability_exports = {};
__export(capability_exports, {
  parseYxcFeatures: () => parseYxcFeatures
});
module.exports = __toCommonJS(capability_exports);
const MEDIA_BLOCKS = ["netusb", "tuner", "cd"];
function stringList(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}
function parseRange(rangeStep, id) {
  if (!Array.isArray(rangeStep)) {
    return void 0;
  }
  for (const entry of rangeStep) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const range = entry;
    if (range.id === id && typeof range.min === "number" && typeof range.max === "number" && typeof range.step === "number") {
      return { min: range.min, max: range.max, step: range.step };
    }
  }
  return void 0;
}
const ZONE_VALUE_LISTS = {
  sound_program_list: "soundProgram",
  surr_decoder_type_list: "sound.surroundDecoder",
  tone_control_mode_list: "sound.toneMode",
  equalizer_mode_list: "sound.equalizer.mode",
  audio_select_list: "sound.audioSelect",
  actual_volume_mode_list: "actualVolumeMode",
  link_control_list: "sound.linkControl",
  link_audio_delay_list: "sound.linkAudioDelay",
  link_audio_quality_list: "sound.linkAudioQuality"
};
function parseValueLists(zone) {
  const lists = {};
  for (const [field, stateId] of Object.entries(ZONE_VALUE_LISTS)) {
    const values = stringList(zone[field]);
    if (values.length > 0) {
      lists[stateId] = values;
    }
  }
  return Object.keys(lists).length > 0 ? lists : void 0;
}
const TUNER_BANDS = ["am", "fm", "dab"];
function parseTunerFeatures(tuner) {
  if (typeof tuner !== "object" || tuner === null) {
    return void 0;
  }
  const obj = tuner;
  const bands = stringList(obj.func_list).filter((func) => TUNER_BANDS.includes(func));
  const preset = typeof obj.preset === "object" && obj.preset !== null ? obj.preset : {};
  return {
    bands,
    presetType: preset.type === "common" ? "common" : "separate",
    presetNum: typeof preset.num === "number" ? preset.num : void 0
  };
}
function parseClockFeatures(clock) {
  if (typeof clock !== "object" || clock === null) {
    return void 0;
  }
  const obj = clock;
  return {
    alarmModes: stringList(obj.alarm_mode_list),
    alarmVolumeRange: parseRange(obj.range_step, "alarm_volume")
  };
}
function parseYxcFeatures(response) {
  if (typeof response !== "object" || response === null) {
    return { zones: [], media: [], hasDistribution: false };
  }
  const obj = response;
  const zones = [];
  if (Array.isArray(obj.zone)) {
    for (const entry of obj.zone) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const zone = entry;
      if (typeof zone.id === "string") {
        zones.push({
          id: zone.id,
          funcs: stringList(zone.func_list),
          inputs: stringList(zone.input_list),
          volumeRange: parseRange(zone.range_step, "volume"),
          valueLists: parseValueLists(zone),
          sceneNum: typeof zone.scene_num === "number" ? zone.scene_num : void 0
        });
      }
    }
  }
  const media = MEDIA_BLOCKS.filter((block) => block in obj);
  const netusb = obj.netusb;
  return {
    zones,
    media,
    netusbFuncs: typeof netusb === "object" && netusb !== null ? stringList(netusb.func_list) : void 0,
    hasDistribution: "distribution" in obj,
    tuner: media.includes("tuner") ? parseTunerFeatures(obj.tuner) : void 0,
    clock: "clock" in obj ? parseClockFeatures(obj.clock) : void 0
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  parseYxcFeatures
});
//# sourceMappingURL=capability.js.map
