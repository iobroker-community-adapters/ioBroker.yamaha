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
  buildYncaCatalog: () => buildYncaCatalog,
  funcToEntry: () => funcToEntry,
  idToEntry: () => idToEntry,
  sweepGets: () => sweepGets,
  yncaCommand: () => yncaCommand,
  yncaObjectsFor: () => yncaObjectsFor,
  yncaStateUpdate: () => yncaStateUpdate
});
module.exports = __toCommonJS(catalog_exports);
var import_build_objects = require("../catalog/build-objects");
var import_value_coerce = require("../catalog/value-coerce");
function readFuncOf(entry) {
  var _a;
  return (_a = entry.readFunc) != null ? _a : entry.func;
}
function readFuncsOf(entry) {
  return entry.readAliases ? [readFuncOf(entry), ...entry.readAliases] : [readFuncOf(entry)];
}
function selfMap(values) {
  return Object.fromEntries(values.map((value) => [value, value]));
}
const INPUT_STATES = selfMap([
  "AUDIO",
  "AUDIO1",
  "AUDIO2",
  "AUDIO3",
  "AUDIO4",
  "AUDIO5",
  "AV1",
  "AV2",
  "AV3",
  "AV4",
  "AV5",
  "AV6",
  "AV7",
  "CD",
  "COAXIAL1",
  "COAXIAL2",
  "DOCK",
  "HDMI1",
  "HDMI2",
  "HDMI3",
  "HDMI4",
  "HDMI5",
  "HDMI6",
  "HDMI7",
  "LINE1",
  "LINE2",
  "LINE3",
  "Main Zone Sync",
  "MULTI CH",
  "OPTICAL1",
  "OPTICAL2",
  "PHONO",
  "TV",
  "V-AUX",
  "AirPlay",
  "Bluetooth",
  "Deezer",
  "iPod",
  "iPod (USB)",
  "MusicCast Link",
  "Napster",
  "NET RADIO",
  "Pandora",
  "PC",
  "Rhapsody",
  "SERVER",
  "SIRIUS",
  "SIRIUS InternetRadio",
  "SiriusXM",
  "Spotify",
  "TIDAL",
  "TUNER",
  "UAW",
  "USB"
]);
const SOUNDPRG_STATES = selfMap([
  "Action Game",
  "Adventure",
  "Arena",
  "Cellar Club",
  "Chamber",
  "Church in Freiburg",
  "Church in Royaumont",
  "Church in Tokyo",
  "Disco",
  "Drama",
  "Enhanced",
  "Hall in Amsterdam",
  "Hall in Frankfurt",
  "Hall in Munich",
  "Hall in Munich A",
  "Hall in Munich B",
  "Hall in Stuttgart",
  "Hall in USA A",
  "Hall in USA B",
  "Hall in Vienna",
  "Mono Movie",
  "Music Video",
  "Pavilion",
  "Recital/Opera",
  "Roleplaying Game",
  "Sci-Fi",
  "Spectacle",
  "Sports",
  "Standard",
  "Surround Decoder",
  "The Bottom Line",
  "The Roxy Theatre",
  "Village Gate",
  "Village Vanguard",
  "Warehouse Loft",
  "2ch Stereo",
  "5ch Stereo",
  "7ch Stereo",
  "9ch Stereo",
  "11ch Stereo",
  "All-Ch Stereo"
]);
const SLEEP_STATES = selfMap(["Off", "30 min", "60 min", "90 min", "120 min"]);
const HDMIOUT_STATES = selfMap(["Off", "OUT1", "OUT2", "OUT1 + 2"]);
const ADAPTIVEDRC_STATES = selfMap(["Off", "Auto"]);
const DECODER_STATES = selfMap([
  "Auto",
  "Dolby PL",
  "Dolby PLII Movie",
  "Dolby PLII Music",
  "Dolby PLII Game",
  "Dolby PLIIx Movie",
  "Dolby PLIIx Music",
  "Dolby PLIIx Game",
  "Dolby Surround",
  "DTS NEO:6 Cinema",
  "DTS NEO:6 Music",
  "DTS Neural:X",
  "AURO-3D"
]);
const AMP_FUNCS = [
  {
    func: "PWR",
    state: "power",
    name: "Power",
    spec: { kind: "onoff", on: "On", off: "Standby" },
    write: true,
    role: "switch.power"
  },
  {
    func: "VOL",
    state: "volume",
    name: "Volume",
    spec: { kind: "number", unit: "dB", min: -80.5, max: 16.5, step: 0.5 },
    write: true,
    role: "level.volume"
  },
  {
    func: "MUTE",
    state: "mute",
    name: "Mute",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "media.mute"
  },
  {
    func: "INP",
    state: "input",
    name: "Input",
    spec: { kind: "enum", states: INPUT_STATES },
    write: true,
    role: "media.input"
  },
  {
    func: "SOUNDPRG",
    state: "soundProgram",
    name: "Sound program",
    spec: { kind: "enum", states: SOUNDPRG_STATES },
    write: true,
    role: "state"
  },
  {
    func: "STRAIGHT",
    state: "straight",
    name: "Straight",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "ENHANCER",
    state: "enhancer",
    name: "Enhancer",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "PUREDIRMODE",
    state: "pureDirect",
    name: "Pure Direct",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "SLEEP",
    state: "sleep",
    name: "Sleep timer",
    spec: { kind: "enum", states: SLEEP_STATES },
    write: true,
    role: "state"
  },
  {
    func: "SPBASS",
    state: "sound.bass",
    name: "Bass",
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5 },
    write: true,
    role: "level"
  },
  {
    func: "SPTREBLE",
    state: "sound.treble",
    name: "Treble",
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5 },
    write: true,
    role: "level"
  },
  {
    func: "HDMIOUT",
    state: "hdmi.output",
    name: "HDMI output",
    spec: { kind: "enum", states: HDMIOUT_STATES },
    write: true,
    role: "state"
  },
  {
    func: "ADAPTIVEDRC",
    state: "adaptiveDrc",
    name: "Adaptive DRC",
    spec: { kind: "enum", states: ADAPTIVEDRC_STATES },
    write: true,
    role: "state"
  },
  {
    func: "SURROUNDAI",
    state: "surroundAI",
    name: "Surround AI",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "DIRMODE",
    state: "direct",
    name: "Direct",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "2CHDECODER",
    state: "surroundDecoder",
    name: "Surround decoder",
    spec: { kind: "enum", states: DECODER_STATES },
    write: true,
    role: "state"
  },
  {
    func: "HPBASS",
    state: "sound.headphoneBass",
    name: "Headphone bass",
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5 },
    write: true,
    role: "level"
  },
  {
    func: "HPTREBLE",
    state: "sound.headphoneTreble",
    name: "Headphone treble",
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5 },
    write: true,
    role: "level"
  },
  {
    func: "EXBASS",
    state: "extraBass",
    name: "Extra Bass",
    spec: { kind: "onoff", on: "Auto", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "3DCINEMA",
    state: "cinemaDsp3d",
    name: "CINEMA DSP 3D",
    spec: { kind: "onoff", on: "Auto", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "INITVOLMODE",
    state: "initialVolume.mode",
    name: "Initial volume mode",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "INITVOLLVL",
    state: "initialVolume.level",
    name: "Initial volume level",
    spec: { kind: "number", unit: "dB", min: -80.5, max: 16.5, step: 0.5 },
    write: true,
    role: "level.volume"
  },
  {
    func: "MAXVOL",
    state: "maxVolume",
    name: "Maximum volume",
    spec: { kind: "number", unit: "dB", min: -30, max: 16.5, step: 5 },
    write: true,
    role: "level.volume"
  },
  {
    func: "LIPSYNCHDMIOUT1OFFSET",
    state: "lipSync.hdmiOut1",
    name: "Lip sync HDMI OUT1 offset",
    spec: { kind: "number", unit: "ms" },
    write: true,
    role: "level"
  },
  {
    func: "LIPSYNCHDMIOUT2OFFSET",
    state: "lipSync.hdmiOut2",
    name: "Lip sync HDMI OUT2 offset",
    spec: { kind: "number", unit: "ms" },
    write: true,
    role: "level"
  },
  {
    func: "ZONENAME",
    state: "zoneName",
    name: "Zone name",
    spec: { kind: "text" },
    write: true,
    role: "text"
  }
];
const ZONEB_AVAIL_STATES = selfMap(["Not Connected", "Not Ready", "Ready"]);
const MAIN_ONLY_FUNCS = [
  {
    func: "SPEAKERA",
    state: "speakerA",
    name: "Speaker A",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "SPEAKERB",
    state: "speakerB",
    name: "Speaker B",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "PWRB",
    state: "zoneB.power",
    name: "Zone B power",
    spec: { kind: "onoff", on: "On", off: "Standby" },
    write: true,
    role: "switch.power"
  },
  {
    func: "ZONEBAVAIL",
    state: "zoneB.available",
    name: "Zone B availability",
    spec: { kind: "enum", states: ZONEB_AVAIL_STATES },
    write: false,
    role: "state"
  },
  {
    func: "ZONEBMUTE",
    state: "zoneB.mute",
    name: "Zone B mute",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "media.mute"
  },
  {
    func: "ZONEBVOL",
    state: "zoneB.volume",
    name: "Zone B volume",
    spec: { kind: "number", unit: "dB", min: -80.5, max: 16.5, step: 0.5 },
    write: true,
    role: "level.volume"
  },
  {
    func: "ZONEBNAME",
    state: "zoneB.name",
    name: "Zone B name",
    spec: { kind: "text" },
    write: true,
    role: "text"
  }
];
const BAND_STATES = selfMap(["AM", "FM"]);
const TUN_SEARCHMODE_STATES = selfMap(["Preset", "Tuning"]);
const DAB_BAND_STATES = selfMap(["DAB", "FM"]);
const ZONES = [
  { subunit: "MAIN", prefix: "" },
  { subunit: "ZONE2", prefix: "zone2." },
  { subunit: "ZONE3", prefix: "zone3." },
  { subunit: "ZONE4", prefix: "zone4." }
];
const GLOBAL_FUNCS = [
  {
    subunit: "SYS",
    func: "PARTY",
    state: "party",
    name: "Party mode",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    subunit: "TUN",
    func: "BAND",
    state: "tuner.band",
    name: "Band",
    spec: { kind: "enum", states: BAND_STATES },
    write: true,
    role: "state"
  },
  {
    subunit: "TUN",
    func: "RDSTXTA",
    state: "tuner.rdsText",
    name: "RDS text",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    subunit: "TUN",
    func: "RDSPRGSERVICE",
    state: "tuner.rdsService",
    name: "RDS station",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    subunit: "TUN",
    func: "AMFREQ",
    state: "tuner.amFrequency",
    name: "AM frequency",
    spec: { kind: "number", unit: "kHz" },
    write: true,
    role: "level"
  },
  {
    subunit: "TUN",
    func: "FMFREQ",
    state: "tuner.fmFrequency",
    name: "FM frequency",
    spec: { kind: "number", unit: "kHz" },
    write: true,
    role: "level"
  },
  {
    subunit: "TUN",
    func: "RDSTXTB",
    state: "tuner.rdsTextB",
    name: "RDS text B",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    subunit: "TUN",
    func: "RDSPRGTYPE",
    state: "tuner.rdsProgramType",
    name: "RDS program type",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    subunit: "TUN",
    func: "SEARCHMODE",
    state: "tuner.searchMode",
    name: "Search mode",
    spec: { kind: "enum", states: TUN_SEARCHMODE_STATES },
    write: true,
    role: "state"
  }
];
const SPPATTERN_STATES = selfMap(["Pattern 1", "Pattern 2"]);
const SWFR_CNFG_STATES = selfMap(["None", "Use"]);
const SYS_FUNCS = [
  // Device metadata lives under the info channel (like govee's info.model/info.firmware),
  // not in the system grab-bag. Renamed from system.model/system.version (audit F7).
  { func: "MODELNAME", state: "info.model", name: "Model", spec: { kind: "text" }, write: false, role: "text" },
  {
    func: "VERSION",
    state: "info.firmware",
    name: "Firmware version",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    func: "PWR",
    state: "masterPower",
    name: "Master power (all zones)",
    spec: { kind: "onoff", on: "On", off: "Standby" },
    write: true,
    role: "switch.power"
  },
  {
    func: "PARTYMUTE",
    state: "partyMute",
    name: "Party mute",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "media.mute"
  },
  {
    func: "HDMIOUT1",
    state: "hdmi.out1",
    name: "HDMI OUT1",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "HDMIOUT2",
    state: "hdmi.out2",
    name: "HDMI OUT2",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "HDMIOUT3",
    state: "hdmi.out3",
    name: "HDMI OUT3",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "SPPATTERN",
    state: "speakers.pattern",
    name: "Speaker pattern",
    spec: { kind: "enum", states: SPPATTERN_STATES },
    write: true,
    role: "state"
  },
  {
    func: "SPPATTERN1SWFR1CNFG",
    state: "speakers.pattern1Swfr1",
    name: "Speaker pattern 1 subwoofer 1",
    spec: { kind: "enum", states: SWFR_CNFG_STATES },
    write: true,
    role: "state"
  },
  {
    func: "SPPATTERN1SWFR2CNFG",
    state: "speakers.pattern1Swfr2",
    name: "Speaker pattern 1 subwoofer 2",
    spec: { kind: "enum", states: SWFR_CNFG_STATES },
    write: true,
    role: "state"
  },
  {
    func: "SPPATTERN2SWFR1CNFG",
    state: "speakers.pattern2Swfr1",
    name: "Speaker pattern 2 subwoofer 1",
    spec: { kind: "enum", states: SWFR_CNFG_STATES },
    write: true,
    role: "state"
  },
  {
    func: "SPPATTERN2SWFR2CNFG",
    state: "speakers.pattern2Swfr2",
    name: "Speaker pattern 2 subwoofer 2",
    spec: { kind: "enum", states: SWFR_CNFG_STATES },
    write: true,
    role: "state"
  }
];
const INPUT_NAME_KEYS = [
  "audio1",
  "audio2",
  "audio3",
  "audio4",
  "av1",
  "av2",
  "av3",
  "av4",
  "av5",
  "av6",
  "av7",
  "dock",
  "hdmi1",
  "hdmi2",
  "hdmi3",
  "hdmi4",
  "hdmi5",
  "hdmi6",
  "hdmi7",
  "multich",
  "phono",
  "usb",
  "vaux"
];
const DAB_FUNCS = [
  {
    func: "BAND",
    state: "dab.band",
    name: "DAB band",
    spec: { kind: "enum", states: DAB_BAND_STATES },
    write: true,
    role: "state"
  },
  {
    func: "DABCHLABEL",
    state: "dab.channelLabel",
    name: "DAB channel",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  { func: "DABDLSLABEL", state: "dab.dls", name: "DAB DLS text", spec: { kind: "text" }, write: false, role: "text" },
  {
    func: "DABENSEMBLELABEL",
    state: "dab.ensembleLabel",
    name: "DAB ensemble",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    func: "DABSERVICELABEL",
    state: "dab.serviceLabel",
    name: "DAB service",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  { func: "DABPRESET", state: "dab.preset", name: "DAB preset", spec: { kind: "text" }, write: false, role: "text" },
  {
    func: "DABPRGTYPE",
    state: "dab.programType",
    name: "DAB program type",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  { func: "FMPRESET", state: "dab.fmPreset", name: "FM preset", spec: { kind: "text" }, write: false, role: "text" },
  {
    func: "FMRDSPRGSERVICE",
    state: "dab.fmRdsService",
    name: "FM RDS station",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    func: "FMRDSPRGTYPE",
    state: "dab.fmRdsProgramType",
    name: "FM RDS program type",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  { func: "FMRDSTXT", state: "dab.fmRdsText", name: "FM RDS text", spec: { kind: "text" }, write: false, role: "text" },
  {
    func: "FMSEARCHMODE",
    state: "dab.fmSearchMode",
    name: "FM search mode",
    spec: { kind: "enum", states: TUN_SEARCHMODE_STATES },
    write: true,
    role: "state"
  },
  {
    func: "FMFREQ",
    state: "dab.fmFrequency",
    name: "FM frequency",
    spec: { kind: "number", unit: "kHz" },
    write: true,
    role: "level"
  }
];
const PLAYBACK_STATES = selfMap(["Play", "Pause", "Stop", "Skip Fwd", "Skip Rev"]);
const REPEAT_STATES = selfMap(["Off", "Single", "All"]);
const PLAYER_SOURCES = [
  { subunit: "NETRADIO", channel: "netRadio" },
  { subunit: "SERVER", channel: "server" },
  { subunit: "USB", channel: "usb" },
  { subunit: "SPOTIFY", channel: "spotify" },
  { subunit: "DEEZER", channel: "deezer" },
  { subunit: "TIDAL", channel: "tidal" },
  { subunit: "NAPSTER", channel: "napster" },
  { subunit: "PANDORA", channel: "pandora" },
  { subunit: "RHAP", channel: "rhapsody" },
  { subunit: "SIRIUS", channel: "sirius" },
  { subunit: "AIRPLAY", channel: "airplay" },
  { subunit: "BT", channel: "bluetooth" },
  { subunit: "PC", channel: "pc" },
  { subunit: "MCLINK", channel: "musicCastLink" },
  { subunit: "IPOD", channel: "ipod" },
  { subunit: "IPODUSB", channel: "ipodUsb" }
];
const PLAYER_FUNCS = [
  {
    func: "PLAYBACK",
    readFunc: "PLAYBACKINFO",
    state: "playback",
    name: "Playback",
    spec: { kind: "enum", states: PLAYBACK_STATES },
    write: true,
    role: "media.state"
  },
  { func: "ARTIST", state: "artist", name: "Artist", spec: { kind: "text" }, write: false, role: "media.artist" },
  { func: "ALBUM", state: "album", name: "Album", spec: { kind: "text" }, write: false, role: "media.album" },
  // Streaming sources (Spotify/Tidal/Deezer, and Pandora firmware-dependent) report the
  // title under TRACK; older sources (server/usb/netradio/…) under SONG. Both feed `track`.
  {
    func: "SONG",
    readAliases: ["TRACK"],
    state: "track",
    name: "Track",
    spec: { kind: "text" },
    write: false,
    role: "media.title"
  },
  { func: "STATION", state: "station", name: "Station", spec: { kind: "text" }, write: false, role: "text" },
  { func: "CHNAME", state: "channelName", name: "Channel name", spec: { kind: "text" }, write: false, role: "text" },
  { func: "PRESET", state: "preset", name: "Preset", spec: { kind: "text" }, write: false, role: "text" },
  {
    func: "TOTALTIME",
    state: "totalTime",
    name: "Total time",
    spec: { kind: "text" },
    write: false,
    role: "media.duration.text"
  },
  {
    func: "ELAPSEDTIME",
    state: "elapsedTime",
    name: "Elapsed time",
    spec: { kind: "text" },
    write: false,
    role: "media.elapsed.text"
  },
  {
    func: "REPEAT",
    state: "repeat",
    name: "Repeat",
    spec: { kind: "enum", states: REPEAT_STATES },
    write: true,
    role: "state"
  },
  {
    func: "SHUFFLE",
    state: "shuffle",
    name: "Shuffle",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    // Boolean on/off shuffle → the type-detector media-player role (fills the SHUFFLE slot).
    role: "media.mode.shuffle"
  }
];
function fnEntries(fns, subunit, prefix = "") {
  return fns.map((fn) => ({
    id: `${prefix}${fn.state}`,
    name: fn.name,
    spec: fn.spec,
    write: fn.write,
    role: fn.role,
    subunit,
    func: fn.func
  }));
}
function buildYncaCatalog() {
  const entries = [];
  for (const zone of ZONES) {
    entries.push(...fnEntries(AMP_FUNCS, zone.subunit, zone.prefix));
  }
  entries.push(...fnEntries(MAIN_ONLY_FUNCS, "MAIN"));
  for (let n = 1; n <= 12; n++) {
    entries.push({
      id: `scene.name${n}`,
      name: `Scene ${n} name`,
      spec: { kind: "text" },
      write: false,
      role: "text",
      subunit: "MAIN",
      func: `SCENE${n}NAME`
    });
  }
  entries.push({
    id: "scene.recall",
    name: "Recall scene",
    spec: { kind: "number", min: 1, max: 12, step: 1 },
    write: true,
    role: "level",
    subunit: "MAIN",
    func: "SCENE",
    readFunc: "SCENE1NAME",
    writeOnly: true,
    wireEncode: (value) => `Scene ${value}`
  });
  for (const fn of GLOBAL_FUNCS) {
    entries.push(...fnEntries([fn], fn.subunit));
  }
  entries.push(...fnEntries(SYS_FUNCS, "SYS"));
  for (const key of INPUT_NAME_KEYS) {
    const upper = key.toUpperCase();
    entries.push({
      id: `inputNames.${key}`,
      name: `Input name ${upper}`,
      spec: { kind: "text" },
      write: false,
      role: "text",
      subunit: "SYS",
      func: `INPNAME${upper}`
    });
  }
  entries.push(...fnEntries(DAB_FUNCS, "DAB"));
  for (const source of PLAYER_SOURCES) {
    for (const fn of PLAYER_FUNCS) {
      entries.push({
        id: `${source.channel}.${fn.state}`,
        name: fn.name,
        spec: fn.spec,
        write: fn.write,
        role: fn.role,
        subunit: source.subunit,
        func: fn.func,
        readFunc: fn.readFunc,
        readAliases: fn.readAliases
      });
    }
  }
  return entries;
}
function sweepGets(entries) {
  const seen = /* @__PURE__ */ new Set();
  const gets = [];
  for (const entry of entries) {
    for (const func of readFuncsOf(entry)) {
      const key = `${entry.subunit}:${func}`;
      if (!seen.has(key)) {
        seen.add(key);
        gets.push({ subunit: entry.subunit, func });
      }
    }
  }
  return gets;
}
function funcToEntry(entries) {
  return new Map(
    entries.filter((entry) => !entry.writeOnly).flatMap((entry) => readFuncsOf(entry).map((func) => [`${entry.subunit}:${func}`, entry]))
  );
}
function idToEntry(entries) {
  return new Map(entries.map((entry) => [entry.id, entry]));
}
function yncaObjectsFor(capabilities) {
  const present = buildYncaCatalog().filter(
    (entry) => readFuncsOf(entry).some((func) => {
      var _a;
      return ((_a = capabilities.subunits[entry.subunit]) == null ? void 0 : _a[func]) !== void 0;
    })
  );
  return (0, import_build_objects.catalogToObjects)(present);
}
function yncaStateUpdate(message, map) {
  const entry = map.get(`${message.subunit}:${message.func}`);
  if (!entry) {
    return void 0;
  }
  const value = (0, import_value_coerce.decode)(entry.spec, message.value);
  return value === void 0 ? void 0 : { id: entry.id, value };
}
function yncaCommand(stateId, value, map) {
  const entry = map.get(stateId);
  if (!entry) {
    return void 0;
  }
  if (!(0, import_value_coerce.isWritableValue)(value, entry.spec.kind === "number")) {
    return void 0;
  }
  const wire = entry.wireEncode ? entry.wireEncode(value) : (0, import_value_coerce.encode)(entry.spec, value);
  return { subunit: entry.subunit, func: entry.func, value: wire };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  buildYncaCatalog,
  funcToEntry,
  idToEntry,
  sweepGets,
  yncaCommand,
  yncaObjectsFor,
  yncaStateUpdate
});
//# sourceMappingURL=catalog.js.map
