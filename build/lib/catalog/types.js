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
  CHANNEL_NAMES: () => CHANNEL_NAMES
});
module.exports = __toCommonJS(types_exports);
const CHANNEL_NAMES = {
  // Device info (metadata beside the per-device connection indicator)
  info: "Info",
  // Zones
  zone2: "Zone 2",
  zone3: "Zone 3",
  zone4: "Zone 4",
  zoneB: "Zone B",
  // Amplifier groups
  sound: "Sound",
  hdmi: "HDMI",
  speakers: "Speakers",
  scene: "Scenes",
  inputNames: "Input names",
  initialVolume: "Initial volume",
  lipSync: "Lip sync",
  // Tuner
  tuner: "Tuner",
  dab: "DAB",
  // Media player container + multiroom
  player: "Media player",
  multiroom: "Multiroom",
  // Media player sources
  netRadio: "Net radio",
  server: "Media server",
  usb: "USB",
  spotify: "Spotify",
  deezer: "Deezer",
  tidal: "Tidal",
  napster: "Napster",
  pandora: "Pandora",
  rhapsody: "Rhapsody",
  sirius: "SiriusXM",
  airplay: "AirPlay",
  bluetooth: "Bluetooth",
  pc: "PC",
  musicCastLink: "MusicCast Link",
  ipod: "iPod",
  ipodUsb: "iPod (USB)",
  // YXC/XML media channels
  cd: "CD",
  netPlayer: "Network player",
  clock: "Clock"
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CHANNEL_NAMES
});
//# sourceMappingURL=types.js.map
