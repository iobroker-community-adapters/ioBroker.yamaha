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
var object_mapper_exports = {};
__export(object_mapper_exports, {
  mapYxcToObjects: () => mapYxcToObjects
});
module.exports = __toCommonJS(object_mapper_exports);
const YXC_STATES = [
  {
    func: "power",
    state: "power",
    common: { name: "Power", type: "boolean", role: "switch.power", read: true, write: true }
  },
  {
    func: "volume",
    state: "volume",
    common: { name: "Volume", type: "number", role: "level.volume", read: true, write: true }
  },
  {
    func: "mute",
    state: "mute",
    common: { name: "Mute", type: "boolean", role: "media.mute", read: true, write: true }
  },
  {
    func: "sound_program",
    state: "soundProgram",
    common: { name: "Sound program", type: "string", role: "state", read: true, write: true }
  },
  {
    func: "enhancer",
    state: "enhancer",
    common: { name: "Enhancer", type: "boolean", role: "switch", read: true, write: true }
  },
  {
    func: "pure_direct",
    state: "pureDirect",
    common: { name: "Pure Direct", type: "boolean", role: "switch", read: true, write: true }
  },
  {
    func: "subwoofer_volume",
    state: "subwooferVolume",
    common: { name: "Subwoofer trim", type: "number", role: "level", read: true, write: true }
  },
  {
    func: "tone_control",
    state: "bass",
    common: { name: "Bass", type: "number", unit: "dB", role: "level", read: true, write: true }
  },
  {
    func: "tone_control",
    state: "treble",
    common: { name: "Treble", type: "number", unit: "dB", role: "level", read: true, write: true }
  },
  {
    func: "sleep",
    state: "sleep",
    common: { name: "Sleep timer", type: "number", unit: "min", role: "level", read: true, write: true }
  },
  {
    func: "dialogue_level",
    state: "dialogueLevel",
    common: { name: "Dialogue level", type: "number", role: "level", read: true, write: false }
  },
  {
    func: "actual_volume",
    state: "actualVolume",
    common: { name: "Actual volume", type: "number", unit: "dB", role: "value", read: true, write: false }
  },
  {
    func: "contents_display",
    state: "contentsDisplay",
    common: { name: "Contents display", type: "boolean", role: "indicator", read: true, write: false }
  },
  {
    func: "surr_decoder_type",
    state: "surroundDecoder",
    common: { name: "Surround decoder", type: "string", role: "text", read: true, write: false }
  },
  {
    func: "audio_select",
    state: "audioSelect",
    common: { name: "Audio select", type: "string", role: "text", read: true, write: false }
  },
  {
    func: "link_control",
    state: "linkControl",
    common: { name: "Link control", type: "string", role: "text", read: true, write: false }
  },
  {
    func: "link_audio_delay",
    state: "linkAudioDelay",
    common: { name: "Link audio delay", type: "string", role: "text", read: true, write: false }
  },
  {
    func: "link_audio_quality",
    state: "linkAudioQuality",
    common: { name: "Link audio quality", type: "string", role: "text", read: true, write: false }
  }
];
const INPUT_COMMON = {
  name: "Input",
  type: "string",
  role: "media.input",
  read: true,
  write: true
};
const ZONES = [
  { id: "main", prefix: "" },
  { id: "zone2", prefix: "zone2.", channel: "zone2", channelName: "Zone 2" },
  { id: "zone3", prefix: "zone3.", channel: "zone3", channelName: "Zone 3" },
  { id: "zone4", prefix: "zone4.", channel: "zone4", channelName: "Zone 4" }
];
const PLAYER_STATES = [
  {
    state: "playback",
    common: {
      name: "Playback",
      type: "string",
      role: "media.state",
      read: true,
      write: false,
      states: { play: "play", pause: "pause", stop: "stop" }
    }
  },
  { state: "artist", common: { name: "Artist", type: "string", role: "media.artist", read: true, write: false } },
  { state: "album", common: { name: "Album", type: "string", role: "media.album", read: true, write: false } },
  { state: "track", common: { name: "Track", type: "string", role: "media.title", read: true, write: false } },
  { state: "play", common: { name: "Play", type: "boolean", role: "button", read: false, write: true } },
  { state: "pause", common: { name: "Pause", type: "boolean", role: "button", read: false, write: true } },
  { state: "stop", common: { name: "Stop", type: "boolean", role: "button", read: false, write: true } },
  { state: "next", common: { name: "Next", type: "boolean", role: "button", read: false, write: true } },
  { state: "prev", common: { name: "Previous", type: "boolean", role: "button", read: false, write: true } }
];
function pushPlayerBlock(objects, prefix, channelName) {
  objects.push({ id: prefix, type: "channel", common: { name: channelName } });
  for (const player of PLAYER_STATES) {
    objects.push({ id: `${prefix}.${player.state}`, type: "state", common: { ...player.common } });
  }
}
function mapYxcToObjects(capabilities) {
  var _a;
  const objects = [];
  for (const zoneDef of ZONES) {
    const zone = capabilities.zones.find((z) => z.id === zoneDef.id);
    if (!zone) {
      continue;
    }
    const states = YXC_STATES.filter((state) => zone.funcs.includes(state.func));
    const hasInput = zone.inputs.length > 0;
    if (states.length === 0 && !hasInput) {
      continue;
    }
    if (zoneDef.channel) {
      objects.push({ id: zoneDef.channel, type: "channel", common: { name: (_a = zoneDef.channelName) != null ? _a : zoneDef.channel } });
    }
    for (const state of states) {
      const common = { ...state.common };
      if (state.state === "volume" && zone.volumeRange) {
        common.min = zone.volumeRange.min;
        common.max = zone.volumeRange.max;
        common.step = zone.volumeRange.step;
      }
      objects.push({ id: `${zoneDef.prefix}${state.state}`, type: "state", common });
    }
    if (hasInput) {
      objects.push({ id: `${zoneDef.prefix}input`, type: "state", common: { ...INPUT_COMMON } });
    }
  }
  if (capabilities.media.includes("netusb")) {
    pushPlayerBlock(objects, "netPlayer", "Network player");
  }
  if (capabilities.media.includes("cd")) {
    pushPlayerBlock(objects, "cd", "CD");
  }
  if (capabilities.media.includes("tuner")) {
    objects.push({ id: "tuner", type: "channel", common: { name: "Tuner" } });
    objects.push({
      id: "tuner.band",
      type: "state",
      common: { name: "Band", type: "string", role: "media.input", read: true, write: false }
    });
    objects.push({
      id: "tuner.frequency",
      type: "state",
      common: { name: "Frequency", type: "number", unit: "kHz", role: "value", read: true, write: false }
    });
    objects.push({
      id: "tuner.rdsText",
      type: "state",
      common: { name: "RDS text", type: "string", role: "text", read: true, write: false }
    });
  }
  return objects;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  mapYxcToObjects
});
//# sourceMappingURL=object-mapper.js.map
