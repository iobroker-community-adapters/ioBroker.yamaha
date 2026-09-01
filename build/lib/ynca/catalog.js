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
    spec: { kind: "number", unit: "dB", min: -80.5, max: 16.5, step: 0.5, decimals: 1 },
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
    state: "sound.straight",
    name: "Straight",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "ENHANCER",
    state: "sound.enhancer",
    name: "Enhancer",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "PUREDIRMODE",
    state: "sound.pureDirect",
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
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5, decimals: 1 },
    write: true,
    role: "level"
  },
  {
    func: "SPTREBLE",
    state: "sound.treble",
    name: "Treble",
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
    name: "Bass",
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5, decimals: 1 },
    write: true,
    role: "level"
  },
  {
    func: "TONETREBLE",
    state: "sound.treble",
    name: "Treble",
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5, decimals: 1 },
    write: true,
    role: "level"
  },
  // Read-only: only "Auto" is attested (RX-V6A ZONE2), the write vocabulary is
  // documented nowhere — no blind write offer (the Scene_Load lesson).
  {
    func: "TONEMODE",
    state: "sound.toneMode",
    name: "Tone control mode",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  // Dialogue level / DTS dialogue control / contents display / the AirPlay volume
  // interlock: reported by the MusicCast generation (RX-V6A sweep), write structure
  // unconfirmed → read-only, like the XML dialogue level.
  {
    func: "DIALOGUELVL",
    state: "sound.dialogueLevel",
    name: "Dialogue level",
    spec: { kind: "number", decimals: 0 },
    write: false,
    role: "value"
  },
  {
    func: "DTSDIALOGUECONTROL",
    state: "sound.dtsDialogueControl",
    name: "DTS dialogue control",
    spec: { kind: "number", decimals: 0 },
    write: false,
    role: "value"
  },
  {
    func: "CONTENTSDISP",
    state: "sound.contentsDisplay",
    name: "Contents display",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: false,
    role: "indicator"
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
    state: "sound.adaptiveDrc",
    name: "Adaptive DRC",
    spec: { kind: "enum", states: ADAPTIVEDRC_STATES },
    write: true,
    role: "state"
  },
  {
    func: "SURROUNDAI",
    state: "sound.surroundAI",
    name: "Surround AI",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "DIRMODE",
    state: "sound.direct",
    name: "Direct",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "2CHDECODER",
    state: "sound.surroundDecoder",
    name: "Surround decoder",
    spec: { kind: "enum", states: DECODER_STATES },
    write: true,
    role: "state"
  },
  {
    func: "HPBASS",
    state: "sound.headphoneBass",
    name: "Headphone bass",
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5, decimals: 1 },
    write: true,
    role: "level"
  },
  {
    func: "HPTREBLE",
    state: "sound.headphoneTreble",
    name: "Headphone treble",
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5, decimals: 1 },
    write: true,
    role: "level"
  },
  {
    func: "EXBASS",
    state: "sound.extraBass",
    name: "Extra Bass",
    spec: { kind: "onoff", on: "Auto", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "3DCINEMA",
    state: "sound.cinemaDsp3d",
    name: "CINEMA DSP 3D",
    spec: { kind: "onoff", on: "Auto", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "INITVOLMODE",
    state: "advanced.initialVolume.mode",
    name: "Initial volume mode",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "INITVOLLVL",
    state: "advanced.initialVolume.level",
    name: "Initial volume level",
    spec: { kind: "number", unit: "dB", min: -80.5, max: 16.5, step: 0.5, decimals: 1 },
    write: true,
    role: "level.volume"
  },
  {
    func: "MAXVOL",
    state: "advanced.maxVolume",
    name: "Maximum volume",
    // 5 dB grid with one mandatory decimal — except the literal ceiling 16.5, which is
    // valid despite being off-grid (the ynca-python MAXVOL special case).
    wireEncode: (value) => Number(value) === 16.5 ? "16.5" : (0, import_value_coerce.formatWireNumber)(Number(value), 1, 5),
    spec: { kind: "number", unit: "dB", min: -30, max: 16.5, step: 5 },
    write: true,
    role: "level.volume"
  },
  {
    func: "LIPSYNCHDMIOUT1OFFSET",
    state: "lipSync.hdmiOut1",
    name: "Lip sync HDMI OUT1 offset",
    spec: { kind: "number", unit: "ms", decimals: 0 },
    write: true,
    role: "level"
  },
  {
    func: "LIPSYNCHDMIOUT2OFFSET",
    state: "lipSync.hdmiOut2",
    name: "Lip sync HDMI OUT2 offset",
    spec: { kind: "number", unit: "ms", decimals: 0 },
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
    state: "advanced.speakerA",
    name: "Speaker A",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "SPEAKERB",
    state: "advanced.speakerB",
    name: "Speaker B",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "PWRB",
    state: "multiroom.zoneB.power",
    name: "Zone B power",
    spec: { kind: "onoff", on: "On", off: "Standby" },
    write: true,
    role: "switch.power"
  },
  {
    func: "ZONEBAVAIL",
    state: "multiroom.zoneB.available",
    name: "Zone B availability",
    spec: { kind: "enum", states: ZONEB_AVAIL_STATES },
    write: false,
    role: "state"
  },
  {
    func: "ZONEBMUTE",
    state: "multiroom.zoneB.mute",
    name: "Zone B mute",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "media.mute"
  },
  {
    func: "ZONEBVOL",
    state: "multiroom.zoneB.volume",
    name: "Zone B volume",
    spec: { kind: "number", unit: "dB", min: -80.5, max: 16.5, step: 0.5, decimals: 1 },
    write: true,
    role: "level.volume"
  },
  {
    func: "ZONEBNAME",
    state: "multiroom.zoneB.name",
    name: "Zone B name",
    spec: { kind: "text" },
    write: true,
    role: "text"
  },
  // Adaptive DSP (official RX-V671 command list) — the DSP-level companion of
  // Adaptive DRC, same Off/Auto value set.
  {
    func: "ADAPTIVEDSP",
    state: "sound.adaptiveDsp",
    name: "Adaptive DSP",
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
    name: "Party mode (all zones)",
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
  // The stored-station surface (#613): PRESET is readable AND writable on TUN
  // (fixtures answer "1" / "No Preset"; the ynca spec's EnumOrInt preset), so the
  // active slot shows up and writing a number recalls it. 0 = no preset active.
  {
    subunit: "TUN",
    func: "PRESET",
    state: "tuner.preset",
    name: "Preset (recall by number)",
    spec: { kind: "number", min: 0, max: 40, step: 1, decimals: 0 },
    write: true,
    role: "level",
    wireDecode: (wire) => wire === "No Preset" ? "0" : wire
  },
  {
    subunit: "TUN",
    func: "PRESET",
    state: "tuner.presetUp",
    name: "Next preset",
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
    name: "Previous preset",
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
    name: "Frequency",
    spec: { kind: "number", unit: "kHz", decimals: 0 },
    write: true,
    role: "level"
  },
  {
    subunit: "TUN",
    func: "FMFREQ",
    state: "tuner.frequency",
    name: "Frequency",
    spec: { kind: "number", unit: "kHz", decimals: 0 },
    write: true,
    role: "level",
    wireDecode: (wire) => String(Math.round(Number.parseFloat(wire) * 1e3))
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
  },
  // FM playback mode (official RX-V671 command list): Auto mutes without stereo
  // reception, Mono forces monaural for weak stations.
  {
    subunit: "TUN",
    func: "FMMODE",
    state: "tuner.fmMode",
    name: "FM mode",
    spec: { kind: "enum", states: selfMap(["Auto", "Mono"]) },
    write: true,
    role: "state"
  },
  // Tuning/stereo indicators (official list; both push auto-feedback).
  {
    subunit: "TUN",
    func: "TUNED",
    state: "tuner.tuned",
    name: "Tuned to a station",
    spec: { kind: "onoff", on: "Assert", off: "Negate" },
    write: false,
    role: "indicator"
  },
  {
    subunit: "TUN",
    func: "SIGSTEREOMONO",
    state: "tuner.stereo",
    name: "Stereo reception",
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
    name: "Save to preset (0 = first free slot)",
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
    state: "multiroom.masterPower",
    name: "Master power (all zones)",
    spec: { kind: "onoff", on: "On", off: "Standby" },
    write: true,
    role: "switch.power"
  },
  {
    func: "PARTYMUTE",
    state: "multiroom.partyMute",
    name: "Party mute (all zones)",
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
    state: "advanced.speakers.pattern",
    name: "Speaker pattern",
    spec: { kind: "enum", states: SPPATTERN_STATES },
    write: true,
    role: "state"
  },
  {
    func: "SPPATTERN1SWFR1CNFG",
    state: "advanced.speakers.pattern1Swfr1",
    name: "Speaker pattern 1 subwoofer 1",
    spec: { kind: "enum", states: SWFR_CNFG_STATES },
    write: true,
    role: "state"
  },
  {
    func: "SPPATTERN1SWFR2CNFG",
    state: "advanced.speakers.pattern1Swfr2",
    name: "Speaker pattern 1 subwoofer 2",
    spec: { kind: "enum", states: SWFR_CNFG_STATES },
    write: true,
    role: "state"
  },
  {
    func: "SPPATTERN2SWFR1CNFG",
    state: "advanced.speakers.pattern2Swfr1",
    name: "Speaker pattern 2 subwoofer 1",
    spec: { kind: "enum", states: SWFR_CNFG_STATES },
    write: true,
    role: "state"
  },
  {
    func: "SPPATTERN2SWFR2CNFG",
    state: "advanced.speakers.pattern2Swfr2",
    name: "Speaker pattern 2 subwoofer 2",
    spec: { kind: "enum", states: SWFR_CNFG_STATES },
    write: true,
    role: "state"
  },
  // Amp-assign for speaker pattern 1 (official RX-V671 list: PUT+GET with the three
  // documented values; the RX-V6A answers "Basic").
  {
    func: "SPPATTERN1AMP",
    state: "advanced.speakers.pattern1Amp",
    name: "Speaker pattern 1 amp assign",
    spec: { kind: "enum", states: selfMap(["Basic", "7ch +1ZONE", "5ch BI-AMP"]) },
    write: true,
    role: "state"
  },
  // Trigger-out 1 manual level (official list: PUT+GET, Lo/Hi).
  {
    func: "TRIG1MANUAL",
    state: "advanced.trigger1Manual",
    name: "Trigger out 1 manual level",
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
    name: "YNCA control port",
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
    name: "Band",
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
  {
    func: "DABPRESET",
    state: "preset",
    name: "Preset (recall by number)",
    spec: { kind: "number", min: 0, max: 40, step: 1, decimals: 0 },
    write: true,
    role: "level",
    wireDecode: (wire) => wire === "No Preset" ? "0" : wire
  },
  {
    func: "DABPRGTYPE",
    state: "dab.programType",
    name: "DAB program type",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    func: "FMPRESET",
    state: "preset",
    name: "Preset (recall by number)",
    spec: { kind: "number", min: 0, max: 40, step: 1, decimals: 0 },
    write: true,
    role: "level",
    wireDecode: (wire) => wire === "No Preset" ? "0" : wire
  },
  {
    func: "FMRDSPRGSERVICE",
    state: "rdsService",
    name: "RDS station",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    func: "FMRDSPRGTYPE",
    state: "rdsProgramType",
    name: "RDS program type",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  { func: "FMRDSTXT", state: "rdsText", name: "RDS text", spec: { kind: "text" }, write: false, role: "text" },
  {
    func: "FMSEARCHMODE",
    state: "searchMode",
    name: "Search mode",
    spec: { kind: "enum", states: TUN_SEARCHMODE_STATES },
    write: true,
    role: "state"
  },
  {
    func: "FMFREQ",
    state: "frequency",
    name: "Frequency",
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
    name: "Audio mode",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    func: "DABBITRATE",
    state: "dab.bitRate",
    name: "Bit rate",
    spec: { kind: "number", decimals: 0 },
    write: false,
    role: "value"
  },
  {
    func: "DABDATETIME",
    state: "dab.dateTime",
    name: "DAB date/time",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    func: "DABOFFAIR",
    state: "dab.offAir",
    name: "Off air",
    spec: { kind: "onoff", on: "Assert", off: "Negate" },
    write: false,
    role: "indicator"
  },
  {
    func: "FMRDSCLOCK",
    state: "rdsClock",
    name: "RDS clock",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    func: "FMSIGSTEREOMONO",
    state: "stereo",
    name: "Stereo reception",
    spec: { kind: "onoff", on: "Assert", off: "Negate" },
    write: false,
    role: "indicator"
  },
  {
    func: "FMTUNED",
    state: "tuned",
    name: "Tuned to a station",
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
    name: "Playback",
    // media.state must be a number for the type-detector media-player slot; PLAYBACKINFO
    // reports Play/Pause/Stop (Skip Fwd/Rev are the separate next/prev buttons below).
    spec: { kind: "code", codes: { Play: 0, Stop: 1, Pause: 2 }, labels: { 0: "Play", 1: "Stop", 2: "Pause" } },
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
    // media.mode.repeat is a number in the type-detector (off/one/all); code-mapped so it fills
    // the REPEAT slot and still reads/writes as labels.
    spec: { kind: "code", codes: { Off: 0, Single: 1, All: 2 }, labels: { 0: "Off", 1: "Single", 2: "All" } },
    write: true,
    role: "media.mode.repeat"
  },
  {
    func: "SHUFFLE",
    state: "shuffle",
    name: "Shuffle",
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
    name: "Next",
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
    name: "Previous",
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
    name: fn.name,
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
  const entries = [];
  for (const zone of ZONES) {
    entries.push(...fnEntries(AMP_FUNCS, zone.subunit, zone.prefix));
  }
  entries.push(...fnEntries(MAIN_ONLY_FUNCS, "MAIN"));
  entries.push({
    id: "scene.recall",
    name: "Recall scene",
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
      name: `Input name ${upper}`,
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
        name: fn.name,
        spec: fn.spec,
        write: fn.write,
        role: fn.role,
        subunit: source.subunit,
        func: fn.func,
        readFunc: fn.readFunc,
        readAliases: fn.readAliases,
        wireEncode: fn.wireEncode,
        writeOnly: fn.writeOnly
      });
    }
    if (PRESET_SUBUNITS.includes(source.subunit)) {
      entries.push({
        id: `player.${source.channel}.preset`,
        name: "Recall preset",
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
        name: "Save to preset (0 = first free slot)",
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
    name: "Bookmark current station",
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
      name: "Connected",
      spec: { kind: "onoff", on: "Connected", off: "Disconnected" },
      write: false,
      role: "indicator",
      subunit: "BT",
      func: "CONNECTINFO"
    },
    {
      id: "player.bluetooth.connect",
      name: "Connect",
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
      name: "Start pairing",
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
      name: "Cancel pairing",
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
      name: "Paired device",
      spec: { kind: "text" },
      write: false,
      role: "text",
      subunit: "BT",
      func: "DEVICENAME"
    },
    {
      id: "player.airplay.volumeInterlock",
      name: "Volume interlock",
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
    entries.filter((entry) => !entry.writeOnly).flatMap((entry) => readFuncsOf(entry).map((func) => [`${entry.subunit}:${func}`, entry]))
  );
}
function idToEntry(entries) {
  return new Map(entries.map((entry) => [entry.id, entry]));
}
function yncaObjectsFor(capabilities, catalog = YNCA_CATALOG) {
  return (0, import_build_objects.catalogToObjects)(presentYncaEntries(capabilities, catalog));
}
function presentYncaEntries(capabilities, catalog = YNCA_CATALOG) {
  return catalog.filter(
    (entry) => readFuncsOf(entry).some((func) => {
      var _a;
      return ((_a = capabilities.subunits[entry.subunit]) == null ? void 0 : _a[func]) !== void 0;
    })
  );
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
  if (!(0, import_value_coerce.isWritableValue)(value, entry.spec.kind === "number")) {
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
