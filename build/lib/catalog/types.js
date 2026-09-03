"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all) __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if ((from && typeof from === "object") || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, {
          get: () => from[key],
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable,
        });
  }
  return to;
};
var __toCommonJS = mod => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var types_exports = {};
__export(types_exports, {
  CHANNEL_DESC_KEYS: () => CHANNEL_DESC_KEYS,
  CHANNEL_NAME_KEYS: () => CHANNEL_NAME_KEYS,
});
module.exports = __toCommonJS(types_exports);
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
  musicCastLink: "descChannelMusicCastLink",
  browse: "descChannelBrowse",
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
  netRadio: "netRadio",
  server: "mediaServer",
  usb: "usb",
  spotify: "spotify",
  deezer: "deezer",
  tidal: "tidal",
  napster: "napster",
  pandora: "pandora",
  rhapsody: "rhapsody",
  sirius: "siriusxm",
  airplay: "airplay",
  bluetooth: "bluetooth",
  pc: "pc",
  musicCastLink: "musiccastLink",
  ipod: "iPod",
  ipodUsb: "ipodUSB",
  // YXC/XML media channels
  cd: "cd",
  netPlayer: "networkPlayer",
  clock: "clock",
};
// Annotate the CommonJS export names for ESM import in node:
0 &&
  (module.exports = {
    CHANNEL_DESC_KEYS,
    CHANNEL_NAME_KEYS,
  });
//# sourceMappingURL=types.js.map
