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
  YNCA_CATALOG: () => YNCA_CATALOG,
  availGets: () => availGets,
  buildYncaCatalog: () => buildYncaCatalog,
  funcToEntry: () => funcToEntry,
  idToEntry: () => idToEntry,
  presentYncaEntries: () => presentYncaEntries,
  sweepGets: () => sweepGets,
  yncaCommand: () => yncaCommand,
  yncaObjectsFor: () => yncaObjectsFor,
  yncaStateUpdate: () => yncaStateUpdate
});
module.exports = __toCommonJS(catalog_exports);
var import_build_objects = require("../catalog/build-objects");
var import_value_coerce = require("../catalog/value-coerce");
var import_play_time = require("../catalog/play-time");
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
    nameKey: "Power",
    spec: { kind: "onoff", on: "On", off: "Standby" },
    write: true,
    role: "switch.power"
  },
  {
    func: "VOL",
    state: "volume",
    nameKey: "Volume",
    spec: { kind: "number", unit: "dB", min: -80.5, max: 16.5, step: 0.5, decimals: 1 },
    write: true,
    role: "level.volume"
  },
  {
    func: "MUTE",
    state: "mute",
    nameKey: "Mute",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "media.mute"
  },
  {
    func: "INP",
    state: "input",
    nameKey: "Input",
    spec: { kind: "enum", states: INPUT_STATES },
    write: true,
    role: "media.input"
  },
  {
    func: "SOUNDPRG",
    state: "soundProgram",
    nameKey: "Sound program",
    spec: { kind: "enum", states: SOUNDPRG_STATES },
    write: true,
    role: "state"
  },
  {
    func: "STRAIGHT",
    state: "sound.straight",
    nameKey: "Straight",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "ENHANCER",
    state: "sound.enhancer",
    nameKey: "Enhancer",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "PUREDIRMODE",
    state: "sound.pureDirect",
    nameKey: "Pure Direct",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "SLEEP",
    state: "sleep",
    nameKey: "Sleep timer",
    spec: { kind: "enum", states: SLEEP_STATES },
    write: true,
    role: "state"
  },
  {
    func: "SPBASS",
    state: "sound.bass",
    nameKey: "Bass",
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5, decimals: 1 },
    write: true,
    role: "level"
  },
  {
    func: "SPTREBLE",
    state: "sound.treble",
    nameKey: "Treble",
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5, decimals: 1 },
    write: true,
    role: "level"
  },
  // The MusicCast generation's tone dialect: it does not know SPBASS/SPTREBLE and
  // answers TONEBASS/TONETREBLE instead ("0.0" — RX-V6A full sweep, 2026-09-01), on
  // MAIN and ZONE2 alike. Same id as the SP dialect: the per-device write map picks
  // whichever function THIS device reported, so each generation is written in its own
  // dialect. Listed AFTER the SP variant — on a device reporting both, the newer wins.
  {
    func: "TONEBASS",
    state: "sound.bass",
    nameKey: "Bass",
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5, decimals: 1 },
    write: true,
    role: "level"
  },
  {
    func: "TONETREBLE",
    state: "sound.treble",
    nameKey: "Treble",
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5, decimals: 1 },
    write: true,
    role: "level"
  },
  // Read-only: only "Auto" is attested (RX-V6A ZONE2), the write vocabulary is
  // documented nowhere — no blind write offer (the Scene_Load lesson).
  {
    func: "TONEMODE",
    state: "sound.toneMode",
    nameKey: "Tone control mode",
    spec: { kind: "text" },
    write: false,
    // `state`, not `text`: it is a mode out of a fixed set, and MusicCast even declares the
    // list for it. Both transports feed this one id, so the role must not depend on which of
    // them happens to own it.
    role: "state"
  },
  // Dialogue level / DTS dialogue control / contents display / the AirPlay volume
  // interlock: reported by the MusicCast generation (RX-V6A sweep), write structure
  // unconfirmed → read-only, like the XML dialogue level.
  {
    func: "DIALOGUELVL",
    state: "sound.dialogueLevel",
    nameKey: "Dialogue level",
    spec: { kind: "number", decimals: 0 },
    write: false,
    role: "value"
  },
  {
    func: "DTSDIALOGUECONTROL",
    state: "sound.dtsDialogueControl",
    nameKey: "DTS dialogue control",
    spec: { kind: "number", decimals: 0 },
    write: false,
    role: "value"
  },
  {
    func: "CONTENTSDISP",
    state: "sound.contentsDisplay",
    nameKey: "Contents display",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: false,
    role: "indicator"
  },
  {
    func: "HDMIOUT",
    state: "hdmi.output",
    nameKey: "HDMI output",
    spec: { kind: "enum", states: HDMIOUT_STATES },
    write: true,
    role: "state"
  },
  {
    func: "ADAPTIVEDRC",
    state: "sound.adaptiveDrc",
    nameKey: "Adaptive DRC",
    spec: { kind: "enum", states: ADAPTIVEDRC_STATES },
    write: true,
    role: "state"
  },
  {
    func: "SURROUNDAI",
    state: "sound.surroundAI",
    nameKey: "Surround AI",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "DIRMODE",
    state: "sound.direct",
    nameKey: "Direct",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "2CHDECODER",
    state: "sound.surroundDecoder",
    nameKey: "Surround decoder",
    spec: { kind: "enum", states: DECODER_STATES },
    write: true,
    role: "state"
  },
  {
    func: "HPBASS",
    state: "sound.headphoneBass",
    nameKey: "Headphone bass",
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5, decimals: 1 },
    write: true,
    role: "level"
  },
  {
    func: "HPTREBLE",
    state: "sound.headphoneTreble",
    nameKey: "Headphone treble",
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5, decimals: 1 },
    write: true,
    role: "level"
  },
  {
    func: "EXBASS",
    state: "sound.extraBass",
    nameKey: "Extra Bass",
    spec: { kind: "onoff", on: "Auto", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "3DCINEMA",
    state: "sound.cinemaDsp3d",
    nameKey: "CINEMA DSP 3D",
    spec: { kind: "onoff", on: "Auto", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "INITVOLMODE",
    state: "advanced.initialVolume.mode",
    nameKey: "Initial volume mode",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "INITVOLLVL",
    state: "advanced.initialVolume.level",
    nameKey: "Initial volume level",
    spec: { kind: "number", unit: "dB", min: -80.5, max: 16.5, step: 0.5, decimals: 1 },
    write: true,
    role: "level.volume"
  },
  {
    func: "MAXVOL",
    state: "advanced.maxVolume",
    nameKey: "Maximum volume",
    // 5 dB grid with one mandatory decimal — except the literal ceiling 16.5, which is
    // valid despite being off-grid (the ynca-python MAXVOL special case).
    wireEncode: (value) => Number(value) === 16.5 ? "16.5" : (0, import_value_coerce.formatWireNumber)(Number(value), 1, 5),
    spec: { kind: "number", unit: "dB", min: -30, max: 16.5, step: 5 },
    write: true,
    role: "level.volume"
  },
  // Lip sync is an HDMI property (v2.0.0): both offsets live in the hdmi folder,
  // the former lipSync folder is gone.
  {
    func: "LIPSYNCHDMIOUT1OFFSET",
    state: "hdmi.lipSyncOut1",
    nameKey: "Lip sync HDMI OUT1 offset",
    spec: { kind: "number", unit: "ms", decimals: 0 },
    write: true,
    role: "level"
  },
  {
    func: "LIPSYNCHDMIOUT2OFFSET",
    state: "hdmi.lipSyncOut2",
    nameKey: "Lip sync HDMI OUT2 offset",
    spec: { kind: "number", unit: "ms", decimals: 0 },
    write: true,
    role: "level"
  },
  {
    func: "ZONENAME",
    state: "zoneName",
    nameKey: "Zone name",
    spec: { kind: "text" },
    write: true,
    role: "text"
  }
];
const ZONEB_AVAIL_STATES = selfMap(["Not Connected", "Not Ready", "Ready"]);
const MAIN_ONLY_FUNCS = [
  // The A/B toggles belong with the other speaker settings (v2.0.0).
  {
    func: "SPEAKERA",
    state: "advanced.speakers.speakerA",
    nameKey: "Speaker A",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "SPEAKERB",
    state: "advanced.speakers.speakerB",
    nameKey: "Speaker B",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "PWRB",
    state: "multiroom.zoneB.power",
    nameKey: "Zone B power",
    spec: { kind: "onoff", on: "On", off: "Standby" },
    write: true,
    role: "switch.power"
  },
  {
    func: "ZONEBAVAIL",
    state: "multiroom.zoneB.available",
    nameKey: "Zone B availability",
    spec: { kind: "enum", states: ZONEB_AVAIL_STATES },
    write: false,
    role: "state"
  },
  {
    func: "ZONEBMUTE",
    state: "multiroom.zoneB.mute",
    nameKey: "Zone B mute",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "media.mute"
  },
  {
    func: "ZONEBVOL",
    state: "multiroom.zoneB.volume",
    nameKey: "Zone B volume",
    spec: { kind: "number", unit: "dB", min: -80.5, max: 16.5, step: 0.5, decimals: 1 },
    write: true,
    role: "level.volume"
  },
  {
    func: "ZONEBNAME",
    state: "multiroom.zoneB.name",
    nameKey: "Zone B name",
    spec: { kind: "text" },
    write: true,
    role: "text"
  },
  // Adaptive DSP (official RX-V671 command list) — the DSP-level companion of
  // Adaptive DRC, same Off/Auto value set.
  {
    func: "ADAPTIVEDSP",
    state: "sound.adaptiveDsp",
    nameKey: "Adaptive DSP",
    spec: { kind: "enum", states: ADAPTIVEDRC_STATES },
    write: true,
    role: "state"
  }
];
const BAND_STATES = selfMap(["AM", "FM"]);
const TUN_SEARCHMODE_STATES = selfMap(["Preset", "Tuning"]);
const DAB_BAND_STATES = selfMap(["DAB", "FM"]);
const ZONES = [
  { subunit: "MAIN", prefix: "" },
  { subunit: "ZONE2", prefix: "multiroom.zone2." },
  { subunit: "ZONE3", prefix: "multiroom.zone3." },
  { subunit: "ZONE4", prefix: "multiroom.zone4." }
];
const GLOBAL_FUNCS = [
  {
    subunit: "SYS",
    func: "PARTY",
    state: "multiroom.party",
    nameKey: "Party mode (all zones)",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    subunit: "TUN",
    func: "BAND",
    state: "tuner.band",
    nameKey: "Band",
    spec: { kind: "enum", states: BAND_STATES },
    write: true,
    role: "state"
  },
  // The stored-station surface (#613): PRESET is readable AND writable on TUN
  // (fixtures answer "1" / "No Preset"; the ynca spec's EnumOrInt preset), so the
  // active slot shows up and writing a number recalls it. 0 = no preset active.
  {
    subunit: "TUN",
    func: "PRESET",
    state: "tuner.preset",
    nameKey: "Preset (recall by number)",
    spec: { kind: "number", min: 0, max: 40, step: 1, decimals: 0 },
    write: true,
    role: "level",
    wireDecode: (wire) => wire === "No Preset" ? "0" : wire
  },
  {
    subunit: "TUN",
    func: "PRESET",
    state: "tuner.presetUp",
    nameKey: "Next preset",
    spec: { kind: "button" },
    write: true,
    role: "button",
    readFunc: "PRESET",
    writeOnly: true,
    wireEncode: () => "Up"
  },
  {
    subunit: "TUN",
    func: "PRESET",
    state: "tuner.presetDown",
    nameKey: "Previous preset",
    spec: { kind: "button" },
    write: true,
    role: "button",
    readFunc: "PRESET",
    writeOnly: true,
    wireEncode: () => "Down"
  },
  {
    subunit: "TUN",
    func: "RDSTXTA",
    state: "tuner.rdsText",
    nameKey: "RDS text",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    subunit: "TUN",
    func: "RDSPRGSERVICE",
    state: "tuner.rdsService",
    nameKey: "RDS station",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  // ONE tuner frequency (v2.0.0), unified to kHz — the MusicCast convention, so the
  // same state means the same thing on every generation. Both wire functions read
  // into it (AM answers whole kHz, FM answers MHz with two decimals → ×1000). The
  // WRITE is band-dependent (AMFREQ vs FMFREQ vs the DAB subunit's FMFREQ) and is
  // routed by the controller BEFORE the generic write path — handleStateChange
  // intercepts tuner.frequency, so these entries' write flag only shapes the object.
  {
    subunit: "TUN",
    func: "AMFREQ",
    state: "tuner.frequency",
    nameKey: "Frequency",
    spec: { kind: "number", unit: "kHz", decimals: 0 },
    write: true,
    role: "level"
  },
  {
    subunit: "TUN",
    func: "FMFREQ",
    state: "tuner.frequency",
    nameKey: "Frequency",
    spec: { kind: "number", unit: "kHz", decimals: 0 },
    write: true,
    role: "level",
    wireDecode: (wire) => String(Math.round(Number.parseFloat(wire) * 1e3))
  },
  {
    subunit: "TUN",
    func: "RDSTXTB",
    state: "tuner.rdsTextB",
    nameKey: "RDS text B",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    subunit: "TUN",
    func: "RDSPRGTYPE",
    state: "tuner.rdsProgramType",
    nameKey: "RDS program type",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    subunit: "TUN",
    func: "SEARCHMODE",
    state: "tuner.searchMode",
    nameKey: "Search mode",
    spec: { kind: "enum", states: TUN_SEARCHMODE_STATES },
    write: true,
    role: "state"
  },
  // FM playback mode (official RX-V671 command list): Auto mutes without stereo
  // reception, Mono forces monaural for weak stations.
  {
    subunit: "TUN",
    func: "FMMODE",
    state: "tuner.fmMode",
    nameKey: "FM mode",
    spec: { kind: "enum", states: selfMap(["Auto", "Mono"]) },
    write: true,
    role: "state"
  },
  // Tuning/stereo indicators (official list; both push auto-feedback).
  {
    subunit: "TUN",
    func: "TUNED",
    state: "tuner.tuned",
    nameKey: "Tuned to a station",
    spec: { kind: "onoff", on: "Assert", off: "Negate" },
    write: false,
    role: "indicator"
  },
  {
    subunit: "TUN",
    func: "SIGSTEREOMONO",
    state: "tuner.stereo",
    nameKey: "Stereo reception",
    spec: { kind: "onoff", on: "Assert", off: "Negate" },
    write: false,
    role: "indicator"
  },
  // Store the current station to a preset bank (@TUN:MEM, official list): a slot
  // number stores there, 0 stores to the first free slot ("Auto").
  {
    subunit: "TUN",
    func: "MEM",
    state: "tuner.presetSave",
    nameKey: "Save to preset (0 = first free slot)",
    spec: { kind: "number", min: 0, max: 40, step: 1 },
    write: true,
    role: "level",
    readFunc: "PRESET",
    writeOnly: true,
    wireEncode: (value) => Number(value) === 0 ? "Auto" : String(Math.round(Number(value)))
  }
];
const SPPATTERN_STATES = selfMap(["Pattern 1", "Pattern 2"]);
const SWFR_CNFG_STATES = selfMap(["None", "Use"]);
const SYS_FUNCS = [
  // Device metadata lives under the info channel (like govee's info.model/info.firmware),
  // not in the system grab-bag. Renamed from system.model/system.version (audit F7).
  { func: "MODELNAME", state: "info.model", nameKey: "Model", spec: { kind: "text" }, write: false, role: "text" },
  {
    func: "VERSION",
    state: "info.firmware",
    nameKey: "Firmware version",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    func: "PWR",
    state: "multiroom.masterPower",
    nameKey: "Master power (all zones)",
    spec: { kind: "onoff", on: "On", off: "Standby" },
    write: true,
    role: "switch.power"
  },
  {
    func: "PARTYMUTE",
    state: "multiroom.partyMute",
    nameKey: "Party mute (all zones)",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "media.mute"
  },
  {
    func: "HDMIOUT1",
    state: "hdmi.out1",
    nameKey: "HDMI OUT1",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "HDMIOUT2",
    state: "hdmi.out2",
    nameKey: "HDMI OUT2",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "HDMIOUT3",
    state: "hdmi.out3",
    nameKey: "HDMI OUT3",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "SPPATTERN",
    state: "advanced.speakers.pattern",
    nameKey: "Speaker pattern",
    spec: { kind: "enum", states: SPPATTERN_STATES },
    write: true,
    role: "state"
  },
  {
    func: "SPPATTERN1SWFR1CNFG",
    state: "advanced.speakers.pattern1Swfr1",
    nameKey: "Speaker pattern 1 subwoofer 1",
    spec: { kind: "enum", states: SWFR_CNFG_STATES },
    write: true,
    role: "state"
  },
  {
    func: "SPPATTERN1SWFR2CNFG",
    state: "advanced.speakers.pattern1Swfr2",
    nameKey: "Speaker pattern 1 subwoofer 2",
    spec: { kind: "enum", states: SWFR_CNFG_STATES },
    write: true,
    role: "state"
  },
  {
    func: "SPPATTERN2SWFR1CNFG",
    state: "advanced.speakers.pattern2Swfr1",
    nameKey: "Speaker pattern 2 subwoofer 1",
    spec: { kind: "enum", states: SWFR_CNFG_STATES },
    write: true,
    role: "state"
  },
  {
    func: "SPPATTERN2SWFR2CNFG",
    state: "advanced.speakers.pattern2Swfr2",
    nameKey: "Speaker pattern 2 subwoofer 2",
    spec: { kind: "enum", states: SWFR_CNFG_STATES },
    write: true,
    role: "state"
  },
  // Amp-assign for speaker pattern 1 (official RX-V671 list: PUT+GET with the three
  // documented values; the RX-V6A answers "Basic").
  {
    func: "SPPATTERN1AMP",
    state: "advanced.speakers.pattern1Amp",
    nameKey: "Speaker pattern 1 amp assign",
    spec: { kind: "enum", states: selfMap(["Basic", "7ch +1ZONE", "5ch BI-AMP"]) },
    write: true,
    role: "state"
  },
  // Trigger-out 1 manual level (official list: PUT+GET, Lo/Hi).
  {
    func: "TRIG1MANUAL",
    state: "advanced.trigger1Manual",
    nameKey: "Trigger out 1 manual level",
    spec: { kind: "enum", states: selfMap(["Lo", "Hi"]) },
    write: true,
    role: "state"
  },
  // The control port itself (official list: PUT 50000-65535). Deliberately READ-ONLY:
  // writing it from ioBroker would cut this very connection and strand the adapter on
  // the old port until a rediscovery — a foot-gun, not a feature.
  {
    func: "YNCAPORT",
    state: "advanced.yncaPort",
    nameKey: "YNCA control port",
    spec: { kind: "number", decimals: 0 },
    write: false,
    role: "value"
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
const INPUT_NAME_LABELS = { vaux: "V-AUX", multich: "MULTI CH" };
const DAB_FUNCS = [
  // v2.0.0 tuner unification: the DAB subunit's FM half IS the same tuner every
  // non-DAB device carries flat under tuner.* — so band, preset, frequency, search
  // mode, RDS and the signal flags map onto the SAME flat ids (tuner.band says
  // which band the values describe). Only genuinely DAB-specific detail stays
  // under tuner.dab. Band-dependent writes (frequency, preset) are routed by the
  // controller before the generic write path.
  {
    func: "BAND",
    state: "band",
    nameKey: "Band",
    spec: { kind: "enum", states: DAB_BAND_STATES },
    write: true,
    role: "state"
  },
  {
    func: "DABCHLABEL",
    state: "dab.channelLabel",
    nameKey: "DAB channel",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    func: "DABDLSLABEL",
    state: "dab.dls",
    nameKey: "DAB DLS text",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    func: "DABENSEMBLELABEL",
    state: "dab.ensembleLabel",
    nameKey: "DAB ensemble",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    func: "DABSERVICELABEL",
    state: "dab.serviceLabel",
    nameKey: "DAB service",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    func: "DABPRESET",
    state: "preset",
    nameKey: "Preset (recall by number)",
    spec: { kind: "number", min: 0, max: 40, step: 1, decimals: 0 },
    write: true,
    role: "level",
    wireDecode: (wire) => wire === "No Preset" ? "0" : wire
  },
  {
    func: "DABPRGTYPE",
    state: "dab.programType",
    nameKey: "DAB program type",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    func: "FMPRESET",
    state: "preset",
    nameKey: "Preset (recall by number)",
    spec: { kind: "number", min: 0, max: 40, step: 1, decimals: 0 },
    write: true,
    role: "level",
    wireDecode: (wire) => wire === "No Preset" ? "0" : wire
  },
  {
    func: "FMRDSPRGSERVICE",
    state: "rdsService",
    nameKey: "RDS station",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    func: "FMRDSPRGTYPE",
    state: "rdsProgramType",
    nameKey: "RDS program type",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  { func: "FMRDSTXT", state: "rdsText", nameKey: "RDS text", spec: { kind: "text" }, write: false, role: "text" },
  {
    func: "FMSEARCHMODE",
    state: "searchMode",
    nameKey: "Search mode",
    spec: { kind: "enum", states: TUN_SEARCHMODE_STATES },
    write: true,
    role: "state"
  },
  {
    func: "FMFREQ",
    state: "frequency",
    nameKey: "Frequency",
    // Same wire form as the TUN FMFREQ above (MHz, two decimals) — read into the
    // unified kHz state; the controller routes the band-dependent write.
    spec: { kind: "number", unit: "kHz", decimals: 0 },
    write: true,
    role: "level",
    wireDecode: (wire) => String(Math.round(Number.parseFloat(wire) * 1e3))
  },
  // DAB/FM detail answered by the RX-V6A full sweep (2026-09-01) — read-only status.
  // audioMode goes to the flat tuner state (band-scoped like frequency); bitRate and
  // offAir share their tuner.dab ids with the YXC DAB block, so both feed one node.
  {
    func: "DABAUDIOMODE",
    state: "audioMode",
    nameKey: "Audio mode",
    spec: { kind: "text" },
    write: false,
    // `state` like the MusicCast side — see sound.toneMode above.
    role: "state"
  },
  {
    func: "DABBITRATE",
    state: "dab.bitRate",
    nameKey: "Bit rate",
    spec: { kind: "number", decimals: 0 },
    write: false,
    role: "value"
  },
  {
    func: "DABDATETIME",
    state: "dab.dateTime",
    nameKey: "DAB date/time",
    spec: { kind: "text" },
    write: false,
    role: "text",
    // The device pads this field and reports an all-zero placeholder while it carries no DAB
    // time (measured on an RX-V6A whose DAB status was "not_ready": `"     '00 00:00"`, against
    // real values of the form `04NOV'22 12:24` in the reference logs). Text values pass through
    // verbatim, so without this the datapoint shows the padding as its content. A real reading
    // always carries a month name or a non-zero digit, so that is the test — safer than matching
    // one placeholder spelling and blanking a real date by accident.
    wireDecode: (wire) => {
      const trimmed = wire.trim();
      return /[A-Za-z1-9]/.test(trimmed) ? trimmed : "";
    }
  },
  {
    func: "DABOFFAIR",
    state: "dab.offAir",
    nameKey: "Off air",
    spec: { kind: "onoff", on: "Assert", off: "Negate" },
    write: false,
    role: "indicator"
  },
  {
    func: "FMRDSCLOCK",
    state: "rdsClock",
    nameKey: "RDS clock",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    func: "FMSIGSTEREOMONO",
    state: "stereo",
    nameKey: "Stereo reception",
    spec: { kind: "onoff", on: "Assert", off: "Negate" },
    write: false,
    role: "indicator"
  },
  {
    func: "FMTUNED",
    state: "tuned",
    nameKey: "Tuned to a station",
    spec: { kind: "onoff", on: "Assert", off: "Negate" },
    write: false,
    role: "indicator"
  }
];
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
const PRESET_SUBUNITS = ["NETRADIO", "NAPSTER", "PANDORA", "PC", "RHAP", "SIRIUS", "USB"];
const MEM_SUBUNITS = ["NETRADIO", "NAPSTER", "PC", "USB"];
const PLAYER_FUNCS = [
  {
    func: "PLAYBACK",
    readFunc: "PLAYBACKINFO",
    state: "playback",
    nameKey: "Playback",
    // media.state must be a number for the type-detector media-player slot; PLAYBACKINFO
    // reports Play/Pause/Stop (Skip Fwd/Rev are the separate next/prev buttons below).
    spec: { kind: "code", codes: { Play: 0, Stop: 1, Pause: 2 }, labels: { 0: "Play", 1: "Stop", 2: "Pause" } },
    write: true,
    role: "media.state"
  },
  { func: "ARTIST", state: "artist", nameKey: "Artist", spec: { kind: "text" }, write: false, role: "media.artist" },
  { func: "ALBUM", state: "album", nameKey: "Album", spec: { kind: "text" }, write: false, role: "media.album" },
  // Streaming sources (Spotify/Tidal/Deezer, and Pandora firmware-dependent) report the
  // title under TRACK; older sources (server/usb/netradio/…) under SONG. Both feed `track`.
  {
    func: "SONG",
    readAliases: ["TRACK"],
    state: "track",
    nameKey: "Track",
    spec: { kind: "text" },
    write: false,
    role: "media.title"
  },
  { func: "STATION", state: "station", nameKey: "Station", spec: { kind: "text" }, write: false, role: "text" },
  { func: "CHNAME", state: "channelName", nameKey: "Channel name", spec: { kind: "text" }, write: false, role: "text" },
  // The times come off the YNCA wire as text ("1:23") and off MusicCast as seconds. Both
  // forms are published on every device, from the one value: the NUMBER fills the type
  // detector's media-player slot (it accepts nothing else), the text is what a
  // visualisation shows. Without the number a YNCA-only receiver had no time at all in
  // the player, and the datapoint's very type depended on which protocol answered.
  {
    func: "TOTALTIME",
    state: "totalTime",
    nameKey: "Total time",
    spec: { kind: "number", unit: "s", decimals: 0 },
    write: false,
    role: "media.duration",
    wireDecode: (wire) => {
      var _a;
      return String((_a = (0, import_play_time.parsePlayTime)(wire)) != null ? _a : "");
    }
  },
  {
    func: "TOTALTIME",
    state: "totalTimeText",
    nameKey: "Total time (readable)",
    spec: { kind: "text" },
    write: false,
    role: "media.duration.text",
    derived: true
  },
  {
    func: "ELAPSEDTIME",
    state: "elapsedTime",
    nameKey: "Elapsed time",
    spec: { kind: "number", unit: "s", decimals: 0 },
    write: false,
    role: "media.elapsed",
    wireDecode: (wire) => {
      var _a;
      return String((_a = (0, import_play_time.parsePlayTime)(wire)) != null ? _a : "");
    }
  },
  {
    func: "ELAPSEDTIME",
    state: "elapsedTimeText",
    nameKey: "Elapsed time (readable)",
    spec: { kind: "text" },
    write: false,
    role: "media.elapsed.text",
    derived: true
  },
  {
    func: "REPEAT",
    state: "repeat",
    nameKey: "Repeat",
    // media.mode.repeat is a number in the type-detector (off/one/all); code-mapped so it fills
    // the REPEAT slot and still reads/writes as labels.
    spec: { kind: "code", codes: { Off: 0, Single: 1, All: 2 }, labels: { 0: "Off", 1: "Single", 2: "All" } },
    write: true,
    role: "media.mode.repeat"
  },
  {
    func: "SHUFFLE",
    state: "shuffle",
    nameKey: "Shuffle",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    // Boolean on/off shuffle → the type-detector media-player role (fills the SHUFFLE slot).
    role: "media.mode.shuffle"
  },
  // Track skip: write-only buttons that put Skip Fwd/Rev on PLAYBACK. The device reports only
  // Play/Pause/Stop, so these are actions, not states — button.next/prev fill the type-detector
  // NEXT/PREV slots (previously they were extra values in the playback dropdown).
  // readFunc gates object creation on the REPORTED function: PLAYBACK itself is write-only and
  // never answers a GET (all device fixtures carry only PLAYBACKINFO), so gating on PLAYBACK
  // would create these buttons on no real device — the scene.recall pattern.
  {
    func: "PLAYBACK",
    readFunc: "PLAYBACKINFO",
    state: "next",
    nameKey: "Next",
    spec: { kind: "button" },
    write: true,
    role: "button.next",
    writeOnly: true,
    wireEncode: () => "Skip Fwd"
  },
  {
    func: "PLAYBACK",
    readFunc: "PLAYBACKINFO",
    state: "prev",
    nameKey: "Previous",
    spec: { kind: "button" },
    write: true,
    role: "button.prev",
    writeOnly: true,
    wireEncode: () => "Skip Rev"
  }
];
function fnEntries(fns, subunit, prefix = "") {
  return fns.map((fn) => ({
    id: `${prefix}${fn.state}`,
    nameKey: fn.nameKey,
    spec: fn.spec,
    write: fn.write,
    role: fn.role,
    subunit,
    func: fn.func,
    wireEncode: fn.wireEncode,
    wireDecode: fn.wireDecode,
    readFunc: fn.readFunc,
    writeOnly: fn.writeOnly
  }));
}
function buildYncaCatalog() {
  var _a;
  const entries = [];
  for (const zone of ZONES) {
    entries.push(...fnEntries(AMP_FUNCS, zone.subunit, zone.prefix));
  }
  entries.push(...fnEntries(MAIN_ONLY_FUNCS, "MAIN"));
  entries.push({
    id: "scene.recall",
    nameKey: "Recall scene",
    spec: { kind: "number", min: 1, max: 12, step: 1 },
    write: true,
    role: "level",
    subunit: "MAIN",
    func: "SCENE",
    readFunc: "SCENE1NAME",
    readAliases: Array.from({ length: 11 }, (_, i) => `SCENE${i + 2}NAME`),
    writeOnly: true,
    wireEncode: (value) => `Scene ${Math.round(Number(value))}`
  });
  for (const fn of GLOBAL_FUNCS) {
    entries.push(...fnEntries([fn], fn.subunit));
  }
  entries.push(...fnEntries(SYS_FUNCS, "SYS"));
  for (const key of INPUT_NAME_KEYS) {
    const upper = key.toUpperCase();
    entries.push({
      id: `advanced.inputNames.${key}`,
      // Each of the 23 carries the input it names — they all read "Input names" before,
      // the folder's own label, so the object tree showed the folder and 23 children with
      // one and the same text and only the id told them apart.
      nameKey: "Input name (%s)",
      nameArgs: [(_a = INPUT_NAME_LABELS[key]) != null ? _a : upper],
      spec: { kind: "text" },
      write: false,
      role: "text",
      subunit: "SYS",
      func: `INPNAME${upper}`
    });
  }
  entries.push(...fnEntries(DAB_FUNCS, "DAB", "tuner."));
  for (const source of PLAYER_SOURCES) {
    for (const fn of PLAYER_FUNCS) {
      entries.push({
        id: `player.${fn.state}`,
        nameKey: fn.nameKey,
        spec: fn.spec,
        write: fn.write,
        role: fn.role,
        subunit: source.subunit,
        func: fn.func,
        readFunc: fn.readFunc,
        readAliases: fn.readAliases,
        wireEncode: fn.wireEncode,
        wireDecode: fn.wireDecode,
        writeOnly: fn.writeOnly,
        derived: fn.derived
      });
    }
    if (PRESET_SUBUNITS.includes(source.subunit)) {
      entries.push({
        id: `player.${source.channel}.preset`,
        nameKey: "Recall preset",
        spec: { kind: "number", min: 0, max: 40, step: 1, decimals: 0 },
        write: true,
        role: "level",
        subunit: source.subunit,
        func: "PRESET",
        readFunc: "PLAYBACKINFO",
        writeOnly: true
      });
    }
    if (MEM_SUBUNITS.includes(source.subunit)) {
      entries.push({
        id: `player.${source.channel}.presetSave`,
        nameKey: "Save to preset (0 = first free slot)",
        spec: { kind: "number", min: 0, max: 40, step: 1 },
        write: true,
        role: "level",
        subunit: source.subunit,
        func: "MEM",
        readFunc: "PLAYBACKINFO",
        writeOnly: true,
        wireEncode: (value) => Number(value) === 0 ? "Auto" : String(Math.round(Number(value)))
      });
    }
  }
  entries.push({
    id: "player.netRadio.bookmark",
    nameKey: "Bookmark current station",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
    subunit: "NETRADIO",
    func: "BOOKMARK",
    readFunc: "PLAYBACKINFO",
    writeOnly: true
  });
  entries.push(
    {
      id: "player.bluetooth.connected",
      nameKey: "Connected",
      spec: { kind: "onoff", on: "Connected", off: "Disconnected" },
      write: false,
      role: "indicator",
      subunit: "BT",
      func: "CONNECTINFO"
    },
    {
      id: "player.bluetooth.connect",
      nameKey: "Connect",
      spec: { kind: "onoff", on: "Connect", off: "Disconnect" },
      write: true,
      role: "switch",
      subunit: "BT",
      func: "CONNECT",
      readFunc: "CONNECTINFO",
      writeOnly: true
    },
    {
      id: "player.bluetooth.pairing",
      nameKey: "Start pairing",
      spec: { kind: "button" },
      write: true,
      role: "button",
      subunit: "BT",
      func: "PAIRING",
      readFunc: "CONNECTINFO",
      writeOnly: true,
      wireEncode: () => "Start"
    },
    {
      id: "player.bluetooth.pairingCancel",
      nameKey: "Cancel pairing",
      spec: { kind: "button" },
      write: true,
      role: "button",
      subunit: "BT",
      func: "PAIRING",
      readFunc: "CONNECTINFO",
      writeOnly: true,
      wireEncode: () => "Cancel"
    },
    // Answered by the RX-V6A full sweep (2026-09-01): the paired device's name and
    // the AirPlay volume-interlock mode — read-only status, subunit-specific.
    {
      id: "player.bluetooth.deviceName",
      nameKey: "Paired device",
      spec: { kind: "text" },
      write: false,
      role: "text",
      subunit: "BT",
      func: "DEVICENAME"
    },
    {
      id: "player.airplay.volumeInterlock",
      nameKey: "Volume interlock",
      spec: { kind: "text" },
      write: false,
      role: "text",
      subunit: "AIRPLAY",
      func: "VOLINTERLOCK"
    }
  );
  return entries;
}
const YNCA_CATALOG = buildYncaCatalog();
function availGets(entries) {
  const seen = /* @__PURE__ */ new Set();
  const gets = [];
  for (const entry of entries) {
    if (entry.subunit !== "SYS" && !seen.has(entry.subunit)) {
      seen.add(entry.subunit);
      gets.push({ subunit: entry.subunit, func: "AVAIL" });
    }
  }
  return gets;
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
    entries.filter((entry) => !entry.writeOnly && !entry.derived).flatMap((entry) => readFuncsOf(entry).map((func) => [`${entry.subunit}:${func}`, entry]))
  );
}
function idToEntry(entries) {
  return new Map(entries.map((entry) => [entry.id, entry]));
}
function yncaObjectsFor(capabilities, catalog = YNCA_CATALOG) {
  return (0, import_build_objects.catalogToObjects)(presentYncaEntries(capabilities, catalog));
}
function presentYncaEntries(capabilities, catalog = YNCA_CATALOG) {
  const present = catalog.filter(
    (entry) => readFuncsOf(entry).some((func) => {
      var _a;
      return ((_a = capabilities.subunits[entry.subunit]) == null ? void 0 : _a[func]) !== void 0;
    })
  );
  return unionSharedDropdowns(present);
}
function unionSharedDropdowns(entries) {
  const merged = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    if (entry.spec.kind !== "enum") {
      continue;
    }
    const seen = merged.get(entry.id);
    merged.set(entry.id, { ...seen != null ? seen : {}, ...entry.spec.states });
  }
  return entries.map((entry) => {
    if (entry.spec.kind !== "enum") {
      return entry;
    }
    const states = merged.get(entry.id);
    if (!states || Object.keys(states).length === Object.keys(entry.spec.states).length) {
      return entry;
    }
    return { ...entry, spec: { ...entry.spec, states } };
  });
}
function yncaStateUpdate(message, map) {
  const entry = map.get(`${message.subunit}:${message.func}`);
  if (!entry) {
    return void 0;
  }
  const wire = entry.wireDecode ? entry.wireDecode(message.value) : message.value;
  const value = (0, import_value_coerce.decode)(entry.spec, wire);
  return value === void 0 ? void 0 : { id: entry.id, value };
}
function yncaCommand(stateId, value, map) {
  const entry = map.get(stateId);
  if (!(entry == null ? void 0 : entry.write)) {
    return void 0;
  }
  if (!(0, import_value_coerce.isWritableValue)(value, entry.spec.kind === "number" || entry.spec.kind === "code")) {
    return void 0;
  }
  const wire = entry.wireEncode ? entry.wireEncode(value) : (0, import_value_coerce.encode)(entry.spec, value);
  return { subunit: entry.subunit, func: entry.func, value: wire };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  YNCA_CATALOG,
  availGets,
  buildYncaCatalog,
  funcToEntry,
  idToEntry,
  presentYncaEntries,
  sweepGets,
  yncaCommand,
  yncaObjectsFor,
  yncaStateUpdate
});
//# sourceMappingURL=catalog.js.map
