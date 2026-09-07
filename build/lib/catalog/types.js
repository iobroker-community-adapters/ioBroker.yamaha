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
var types_exports = {};
__export(types_exports, {
  CHANNEL_DESC_KEYS: () => CHANNEL_DESC_KEYS,
  CHANNEL_NAME_KEYS: () => CHANNEL_NAME_KEYS,
  channelCommon: () => channelCommon
});
module.exports = __toCommonJS(types_exports);
var import_i18n = require("../i18n");
const CHANNEL_DESC_KEYS = {
  info: "descChannelInfo",
  zoneB: "descChannelZoneB",
  advanced: "descChannelAdvanced",
  speakers: "descChannelSpeakers",
  scene: "descChannelScene",
  remote: "descChannelRemote",
  inputNames: "descChannelInputNames",
  initialVolume: "descChannelInitialVolume",
  equalizer: "descChannelEqualizer",
  signal: "descChannelSignal",
  dab: "descChannelDab",
  player: "descChannelPlayer",
  multiroom: "descChannelMultiroom",
  group: "descChannelGroup",
  browse: "descChannelBrowse",
  trigger1Inputs: "descChannelTrigger1Inputs"
};
const CHANNEL_NAME_KEYS = {
  // Device info (metadata beside the per-device connection indicator)
  info: "info",
  // Zones
  zone2: "zone2",
  zone3: "zone3",
  zone4: "zone4",
  zoneB: "zoneB",
  // Amplifier groups
  sound: "sound",
  advanced: "advanced",
  hdmi: "hdmi",
  speakers: "speakers",
  scene: "scenes",
  remote: "remoteControl",
  inputNames: "inputNames",
  initialVolume: "initialVolume",
  equalizer: "equalizer",
  signal: "audioSignal",
  // Tuner
  tuner: "tuner",
  dab: "dab",
  // Media player container + multiroom
  player: "mediaPlayer",
  multiroom: "multiroom",
  // The MusicCast-Link folder under multiroom — a group of linked DEVICES, not zones.
  group: "musiccastGroupLinkedDevices",
  // Media player sources
  ipod: "iPod",
  ipodUsb: "ipodUSB",
  netRadio: "netRadio",
  trigger1Inputs: "trigger1Inputs",
  usb: "usb",
  napster: "napster",
  pandora: "pandora",
  rhapsody: "rhapsody",
  sirius: "siriusxm",
  airplay: "airplay",
  bluetooth: "bluetooth",
  pc: "pc",
  musicCastLink: "musiccastLink",
  // The browsing surface's own folder. It was missing here until the object inventory measured
  // the built tree (2026-09-07): the folder HAS an explanation, so it went out with a translated
  // desc next to the hard-coded English fallback name "Browse" — on every device.
  browse: "browse",
  // YXC/XML media channels
  cd: "cd",
  netPlayer: "networkPlayer",
  clock: "clock"
};
function channelCommon(segment) {
  const nameKey = CHANNEL_NAME_KEYS[segment];
  const descKey = CHANNEL_DESC_KEYS[segment];
  return {
    name: nameKey ? (0, import_i18n.tName)(nameKey) : segment.charAt(0).toUpperCase() + segment.slice(1),
    ...descKey ? { desc: (0, import_i18n.tName)(descKey) } : {}
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CHANNEL_DESC_KEYS,
  CHANNEL_NAME_KEYS,
  channelCommon
});
//# sourceMappingURL=types.js.map
