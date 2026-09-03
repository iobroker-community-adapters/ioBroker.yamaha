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
  YXC_AMP_CATALOG: () => YXC_AMP_CATALOG
});
module.exports = __toCommonJS(catalog_exports);
const bool = (value) => Boolean(value);
const num = (value) => Number(value);
const str = (value) => String(value);
const YXC_AMP_CATALOG = [
  {
    state: "power",
    common: { nameKey: "power", type: "boolean", role: "switch.power", read: true, write: true },
    create: { kind: "func", func: "power" },
    read: { field: "power" },
    fromStatus: (value) => value === "on",
    write: { apply: (c, v, z) => c.power(Boolean(v), z) }
  },
  {
    state: "volume",
    common: { nameKey: "volume", type: "number", role: "level.volume", read: true, write: true },
    create: { kind: "func", func: "volume" },
    read: { field: "volume" },
    fromStatus: num,
    write: { apply: (c, v, z) => c.setVolumeTo(Number(v), z) }
  },
  {
    state: "mute",
    common: { nameKey: "mute", type: "boolean", role: "media.mute", read: true, write: true },
    create: { kind: "func", func: "mute" },
    read: { field: "mute" },
    fromStatus: bool,
    write: { apply: (c, v, z) => c.mute(Boolean(v), z) }
  },
  {
    state: "input",
    common: { nameKey: "input", type: "string", role: "media.input", read: true, write: true },
    create: { kind: "input" },
    read: { field: "input" },
    fromStatus: str,
    write: { apply: (c, v, z) => c.setInput(String(v), z) }
  },
  {
    state: "soundProgram",
    common: { nameKey: "soundProgram", type: "string", role: "state", read: true, write: true },
    create: { kind: "func", func: "sound_program" },
    read: { field: "sound_program" },
    fromStatus: str,
    write: { apply: (c, v, z) => c.setSound(String(v), z) }
  },
  {
    state: "sound.enhancer",
    common: { nameKey: "enhancer", type: "boolean", role: "switch", read: true, write: true },
    create: { kind: "func", func: "enhancer" },
    read: { field: "enhancer" },
    fromStatus: bool,
    write: { apply: (c, v, z) => c.setEnhancer(Boolean(v), z) }
  },
  {
    state: "sound.pureDirect",
    common: { nameKey: "pureDirect", type: "boolean", role: "switch", read: true, write: true },
    create: { kind: "func", func: "pure_direct" },
    read: { field: "pure_direct" },
    fromStatus: bool,
    write: { apply: (c, v, z) => c.setPureDirect(Boolean(v), z) }
  },
  {
    state: "subwooferVolume",
    common: { nameKey: "subwooferTrim", type: "number", unit: "dB", role: "level", read: true, write: true },
    create: { kind: "func", func: "subwoofer_volume" },
    read: { field: "subwoofer_volume" },
    fromStatus: num,
    write: { apply: (c, v, z) => c.setSubwooferVolumeTo(Number(v), z) }
  },
  {
    state: "sound.bass",
    common: { nameKey: "bass", type: "number", unit: "dB", role: "level", read: true, write: true },
    create: { kind: "func", func: "tone_control" },
    read: { path: ["tone_control", "bass"] },
    fromStatus: num,
    write: { apply: (c, v, z) => c.setBassTo(Number(v), z) }
  },
  {
    state: "sound.toneMode",
    common: { nameKey: "toneControlMode", type: "string", role: "state", read: true, write: false },
    create: { kind: "func", func: "tone_control" },
    read: { path: ["tone_control", "mode"] },
    fromStatus: str
  },
  {
    state: "sound.treble",
    common: { nameKey: "treble", type: "number", unit: "dB", role: "level", read: true, write: true },
    create: { kind: "func", func: "tone_control" },
    read: { path: ["tone_control", "treble"] },
    fromStatus: num,
    write: { apply: (c, v, z) => c.setTrebleTo(Number(v), z) }
  },
  {
    state: "sleep",
    common: { nameKey: "sleepTimer", type: "number", unit: "min", role: "level", read: true, write: true },
    create: { kind: "func", func: "sleep" },
    read: { field: "sleep" },
    fromStatus: num,
    write: { apply: (c, v, z) => c.sleep(Number(v), z) }
  },
  {
    state: "sound.dialogueLevel",
    common: { nameKey: "dialogueLevel", type: "number", role: "value", read: true, write: false },
    create: { kind: "func", func: "dialogue_level" },
    read: { field: "dialogue_level" },
    fromStatus: num
  },
  {
    state: "actualVolume",
    common: { nameKey: "volumeDB", type: "number", unit: "dB", role: "value", read: true, write: false },
    create: { kind: "func", func: "actual_volume" },
    read: { path: ["actual_volume", "value"] },
    fromStatus: num
  },
  {
    state: "actualVolumeMode",
    common: { nameKey: "volumeDisplayMode", type: "string", role: "state", read: true, write: false },
    create: { kind: "func", func: "actual_volume" },
    read: { path: ["actual_volume", "mode"] },
    fromStatus: str
  },
  {
    state: "sound.contentsDisplay",
    common: { nameKey: "contentsDisplay", type: "boolean", role: "indicator", read: true, write: false },
    create: { kind: "func", func: "contents_display" },
    read: { field: "contents_display" },
    fromStatus: bool
  },
  {
    state: "sound.surroundDecoder",
    common: { nameKey: "surroundDecoder", type: "string", role: "text", read: true, write: false },
    create: { kind: "func", func: "surr_decoder_type" },
    read: { field: "surr_decoder_type" },
    fromStatus: str
  },
  {
    state: "sound.audioSelect",
    common: { nameKey: "audioSelect", type: "string", role: "text", read: true, write: false },
    create: { kind: "func", func: "audio_select" },
    read: { field: "audio_select" },
    fromStatus: str
  },
  {
    state: "sound.linkControl",
    common: { nameKey: "linkControl", type: "string", role: "text", read: true, write: false },
    create: { kind: "func", func: "link_control" },
    read: { field: "link_control" },
    fromStatus: str
  },
  {
    state: "sound.linkAudioDelay",
    common: { nameKey: "linkAudioDelay", type: "string", role: "text", read: true, write: false },
    create: { kind: "func", func: "link_audio_delay" },
    read: { field: "link_audio_delay" },
    fromStatus: str
  },
  {
    state: "sound.linkAudioQuality",
    common: { nameKey: "linkAudioQuality", type: "string", role: "text", read: true, write: false },
    create: { kind: "func", func: "link_audio_quality" },
    read: { field: "link_audio_quality" },
    fromStatus: str
  },
  {
    state: "sound.direct",
    common: { nameKey: "direct", type: "boolean", role: "switch", read: true, write: true },
    create: { kind: "func", func: "direct" },
    read: { field: "direct" },
    fromStatus: bool,
    write: { apply: (c, v, z) => c.setDirect(Boolean(v), z) }
  },
  {
    state: "sound.clearVoice",
    common: { nameKey: "clearVoice", type: "boolean", role: "switch", read: true, write: true },
    create: { kind: "func", func: "clear_voice" },
    read: { field: "clear_voice" },
    fromStatus: bool,
    write: { apply: (c, v, z) => c.setClearVoice(Boolean(v), z) }
  },
  {
    state: "sound.bassExtension",
    common: { nameKey: "bassExtension", type: "boolean", role: "switch", read: true, write: true },
    create: { kind: "func", func: "bass_extension" },
    read: { field: "bass_extension" },
    fromStatus: bool,
    write: { apply: (c, v, z) => c.setBassExtension(Boolean(v), z) }
  },
  {
    state: "sound.balance",
    common: { nameKey: "balance", type: "number", role: "level", read: true, write: true },
    create: { kind: "func", func: "balance" },
    read: { field: "balance" },
    fromStatus: num,
    write: { apply: (c, v, z) => c.setBalance(Number(v), z) }
  },
  {
    state: "sound.adaptiveDrc",
    common: { nameKey: "adaptiveDRC", type: "boolean", role: "indicator", read: true, write: false },
    create: { kind: "func", func: "adaptive_drc" },
    read: { field: "adaptive_drc" },
    fromStatus: bool
  },
  {
    state: "sound.adaptiveDspLevel",
    common: { nameKey: "adaptiveDSPLevel", type: "boolean", role: "indicator", read: true, write: false },
    create: { kind: "func", func: "adaptive_dsp_level" },
    read: { field: "adaptive_dsp_level" },
    fromStatus: bool
  },
  {
    state: "sound.extraBass",
    common: { nameKey: "extraBass", type: "boolean", role: "indicator", read: true, write: false },
    create: { kind: "func", func: "extra_bass" },
    read: { field: "extra_bass" },
    fromStatus: bool
  },
  {
    state: "sound.monaural",
    common: { nameKey: "monaural", type: "boolean", role: "indicator", read: true, write: false },
    create: { kind: "func", func: "mono" },
    read: { field: "mono" },
    fromStatus: bool
  },
  {
    state: "sound.surround3d",
    common: { nameKey: "surround3D", type: "boolean", role: "indicator", read: true, write: false },
    create: { kind: "func", func: "surround_3d" },
    read: { field: "surround_3d" },
    fromStatus: bool
  },
  {
    state: "sound.dialogueLift",
    common: {
      nameKey: "dialogueLift",
      descKey: "descDialogueLift",
      type: "number",
      role: "value",
      read: true,
      write: false,
      min: 0,
      max: 5,
      step: 1
    },
    create: { kind: "func", func: "dialogue_lift" },
    read: { field: "dialogue_lift" },
    fromStatus: num
  },
  {
    state: "sound.dtsDialogueControl",
    common: { nameKey: "dtsDialogueControl", type: "number", role: "value", read: true, write: false },
    create: { kind: "func", func: "dts_dialogue_control" },
    read: { field: "dts_dialogue_control" },
    fromStatus: num
  },
  {
    state: "sound.equalizer.mode",
    common: { nameKey: "equalizerMode", type: "string", role: "state", read: true, write: false },
    create: { kind: "func", func: "equalizer" },
    read: { path: ["equalizer", "mode"] },
    fromStatus: str
  },
  {
    state: "sound.equalizer.low",
    common: { nameKey: "equalizerLow", type: "number", unit: "dB", role: "level", read: true, write: true },
    create: { kind: "func", func: "equalizer" },
    read: { path: ["equalizer", "low"] },
    fromStatus: num
  },
  {
    state: "sound.equalizer.mid",
    common: { nameKey: "equalizerMid", type: "number", unit: "dB", role: "level", read: true, write: true },
    create: { kind: "func", func: "equalizer" },
    read: { path: ["equalizer", "mid"] },
    fromStatus: num
  },
  {
    state: "sound.equalizer.high",
    common: { nameKey: "equalizerHigh", type: "number", unit: "dB", role: "level", read: true, write: true },
    create: { kind: "func", func: "equalizer" },
    read: { path: ["equalizer", "high"] },
    fromStatus: num
  },
  {
    state: "advanced.maxVolume",
    common: { nameKey: "maximumVolume", type: "number", role: "value", read: true, write: false },
    create: { kind: "always" },
    read: { field: "max_volume" },
    fromStatus: num
  },
  {
    state: "inputText",
    common: { nameKey: "inputNameDisplay", type: "string", role: "text", read: true, write: false },
    create: { kind: "always" },
    read: { field: "input_text" },
    fromStatus: str
  },
  // The two device-global entries: their id starts with "multiroom." (no zone prefix ever
  // applies), so the mapper and the status parser emit them for the main zone only.
  {
    // distribution_enable says the zone MAY be used for Link streaming — proven on a live
    // device reporting true while in no group (role none) — not that it streams right now.
    state: "multiroom.group.streamingEnabled",
    common: { nameKey: "multiroomStreamingEnabled", type: "boolean", role: "indicator", read: true, write: false },
    create: { kind: "always" },
    read: { field: "distribution_enable" },
    fromStatus: bool
  },
  {
    state: "multiroom.partyEnable",
    common: { nameKey: "partyModeAllZones", type: "boolean", role: "switch", read: true, write: true },
    create: { kind: "always" },
    read: { field: "party_enable" },
    fromStatus: bool,
    write: { apply: (c, v) => c.setPartyMode(Boolean(v)) }
  }
];
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  YXC_AMP_CATALOG
});
//# sourceMappingURL=catalog.js.map
