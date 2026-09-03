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
    nameKey: "power",
    spec: { kind: "onoff", on: "On", off: "Standby" },
    write: true,
    role: "switch.power"
  },
  {
    func: "VOL",
    state: "volume",
    nameKey: "volume",
    spec: { kind: "number", unit: "dB", min: -80.5, max: 16.5, step: 0.5, decimals: 1 },
    write: true,
    role: "level.volume"
  },
  {
    func: "MUTE",
    state: "mute",
    nameKey: "mute",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "media.mute"
  },
  {
    func: "INP",
    state: "input",
    nameKey: "input",
    spec: { kind: "enum", states: INPUT_STATES },
    write: true,
    role: "media.input"
  },
  {
    func: "SOUNDPRG",
    state: "soundProgram",
    nameKey: "soundProgram",
    descKey: "descSoundProgram",
    spec: { kind: "enum", states: SOUNDPRG_STATES },
    write: true,
    role: "state"
  },
  {
    func: "STRAIGHT",
    state: "sound.straight",
    nameKey: "straight",
    descKey: "descStraight",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "ENHANCER",
    state: "sound.enhancer",
    nameKey: "enhancer",
    descKey: "descEnhancer",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "PUREDIRMODE",
    state: "sound.pureDirect",
    nameKey: "pureDirect",
    descKey: "descPureDirect",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "SLEEP",
    state: "sleep",
    nameKey: "sleepTimer",
    spec: { kind: "enum", states: SLEEP_STATES },
    write: true,
    role: "state"
  },
  {
    func: "SPBASS",
    state: "sound.bass",
    nameKey: "bass",
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5, decimals: 1 },
    write: true,
    role: "level"
  },
  {
    func: "SPTREBLE",
    state: "sound.treble",
    nameKey: "treble",
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
    nameKey: "bass",
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5, decimals: 1 },
    write: true,
    role: "level"
  },
  {
    func: "TONETREBLE",
    state: "sound.treble",
    nameKey: "treble",
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5, decimals: 1 },
    write: true,
    role: "level"
  },
  // Read-only: only "Auto" is attested (RX-V6A ZONE2), the write vocabulary is
  // documented nowhere — no blind write offer (the Scene_Load lesson).
  {
    func: "TONEMODE",
    state: "sound.toneMode",
    nameKey: "toneControlMode",
    descKey: "descToneControlMode",
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
    nameKey: "dialogueLevel",
    descKey: "descDialogueLevel",
    spec: { kind: "number", decimals: 0 },
    write: false,
    role: "value"
  },
  {
    func: "DTSDIALOGUECONTROL",
    state: "sound.dtsDialogueControl",
    nameKey: "dtsDialogueControl",
    descKey: "descDtsDialogueControl",
    spec: { kind: "number", decimals: 0 },
    write: false,
    role: "value"
  },
  {
    func: "CONTENTSDISP",
    state: "sound.contentsDisplay",
    nameKey: "contentsDisplay",
    descKey: "descContentsDisplay",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: false,
    role: "indicator"
  },
  {
    func: "HDMIOUT",
    state: "hdmi.output",
    nameKey: "hdmiOutput",
    descKey: "descHdmiOutput",
    spec: { kind: "enum", states: HDMIOUT_STATES },
    write: true,
    role: "state"
  },
  {
    func: "ADAPTIVEDRC",
    state: "sound.adaptiveDrc",
    nameKey: "adaptiveDRC",
    descKey: "descAdaptiveDRC",
    spec: { kind: "enum", states: ADAPTIVEDRC_STATES },
    write: true,
    role: "state"
  },
  {
    func: "SURROUNDAI",
    state: "sound.surroundAI",
    nameKey: "surroundAI",
    descKey: "descSurroundAI",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "DIRMODE",
    state: "sound.direct",
    nameKey: "direct",
    descKey: "descDirect",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "2CHDECODER",
    state: "sound.surroundDecoder",
    nameKey: "surroundDecoder",
    descKey: "descSurroundDecoder",
    spec: { kind: "enum", states: DECODER_STATES },
    write: true,
    role: "state"
  },
  {
    func: "HPBASS",
    state: "sound.headphoneBass",
    nameKey: "headphoneBass",
    descKey: "descHeadphoneBass",
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5, decimals: 1 },
    write: true,
    role: "level"
  },
  {
    func: "HPTREBLE",
    state: "sound.headphoneTreble",
    nameKey: "headphoneTreble",
    descKey: "descHeadphoneTreble",
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5, decimals: 1 },
    write: true,
    role: "level"
  },
  {
    func: "EXBASS",
    state: "sound.extraBass",
    nameKey: "extraBass",
    descKey: "descExtraBass",
    spec: { kind: "onoff", on: "Auto", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "3DCINEMA",
    state: "sound.cinemaDsp3d",
    nameKey: "cinemaDSP3D",
    descKey: "descCinemaDSP3D",
    spec: { kind: "onoff", on: "Auto", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "INITVOLMODE",
    state: "advanced.initialVolume.mode",
    nameKey: "initialVolumeMode",
    descKey: "descInitialVolumeMode",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "INITVOLLVL",
    state: "advanced.initialVolume.level",
    nameKey: "initialVolumeLevel",
    descKey: "descInitialVolumeLevel",
    spec: { kind: "number", unit: "dB", min: -80.5, max: 16.5, step: 0.5, decimals: 1 },
    write: true,
    role: "level.volume"
  },
  {
    func: "MAXVOL",
    state: "advanced.maxVolume",
    nameKey: "maximumVolume",
    descKey: "descMaximumVolume",
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
    nameKey: "lipSyncHDMIOUT1Offset",
    descKey: "descLipSyncHDMIOUT1Offset",
    spec: { kind: "number", unit: "ms", decimals: 0 },
    write: true,
    role: "level"
  },
  {
    func: "LIPSYNCHDMIOUT2OFFSET",
    state: "hdmi.lipSyncOut2",
    nameKey: "lipSyncHDMIOUT2Offset",
    descKey: "descLipSyncHDMIOUT2Offset",
    spec: { kind: "number", unit: "ms", decimals: 0 },
    write: true,
    role: "level"
  },
  {
    func: "ZONENAME",
    state: "zoneName",
    nameKey: "zoneName",
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
    nameKey: "speakerA",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "SPEAKERB",
    state: "advanced.speakers.speakerB",
    nameKey: "speakerB",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "PWRB",
    state: "multiroom.zoneB.power",
    nameKey: "zoneBPower",
    spec: { kind: "onoff", on: "On", off: "Standby" },
    write: true,
    role: "switch.power"
  },
  {
    func: "ZONEBAVAIL",
    state: "multiroom.zoneB.available",
    nameKey: "zoneBAvailability",
    descKey: "descZoneBAvailability",
    spec: { kind: "enum", states: ZONEB_AVAIL_STATES },
    write: false,
    role: "state"
  },
  {
    func: "ZONEBMUTE",
    state: "multiroom.zoneB.mute",
    nameKey: "zoneBMute",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "media.mute"
  },
  {
    func: "ZONEBVOL",
    state: "multiroom.zoneB.volume",
    nameKey: "zoneBVolume",
    spec: { kind: "number", unit: "dB", min: -80.5, max: 16.5, step: 0.5, decimals: 1 },
    write: true,
    role: "level.volume"
  },
  {
    func: "ZONEBNAME",
    state: "multiroom.zoneB.name",
    nameKey: "zoneBName",
    spec: { kind: "text" },
    write: true,
    role: "text"
  },
  // Adaptive DSP (official RX-V671 command list) — the DSP-level companion of
  // Adaptive DRC, same Off/Auto value set.
  {
    func: "ADAPTIVEDSP",
    state: "sound.adaptiveDsp",
    nameKey: "adaptiveDSP",
    descKey: "descAdaptiveDSP",
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
    nameKey: "partyModeAllZones",
    descKey: "descPartyModeAllZones",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    subunit: "TUN",
    func: "BAND",
    state: "tuner.band",
    nameKey: "band",
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
    nameKey: "presetRecallByNumber",
    descKey: "descPresetRecallByNumber",
    spec: { kind: "number", min: 0, max: 40, step: 1, decimals: 0 },
    write: true,
    role: "level",
    wireDecode: (wire) => wire === "No Preset" ? "0" : wire
  },
  {
    subunit: "TUN",
    func: "PRESET",
    state: "tuner.presetUp",
    nameKey: "nextPreset",
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
    nameKey: "previousPreset",
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
    nameKey: "rdsText",
    descKey: "descRdsText",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    subunit: "TUN",
    func: "RDSPRGSERVICE",
    state: "tuner.rdsService",
    nameKey: "rdsStation",
    descKey: "descRdsStation",
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
    nameKey: "frequency",
    spec: { kind: "number", unit: "kHz", decimals: 0 },
    write: true,
    role: "level"
  },
  {
    subunit: "TUN",
    func: "FMFREQ",
    state: "tuner.frequency",
    nameKey: "frequency",
    spec: { kind: "number", unit: "kHz", decimals: 0 },
    write: true,
    role: "level",
    wireDecode: (wire) => String(Math.round(Number.parseFloat(wire) * 1e3))
  },
  {
    subunit: "TUN",
    func: "RDSTXTB",
    state: "tuner.rdsTextB",
    nameKey: "rdsTextB",
    descKey: "descRdsTextB",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    subunit: "TUN",
    func: "RDSPRGTYPE",
    state: "tuner.rdsProgramType",
    nameKey: "rdsProgramType",
    descKey: "descRdsProgramType",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    subunit: "TUN",
    func: "SEARCHMODE",
    state: "tuner.searchMode",
    nameKey: "searchMode",
    descKey: "descSearchMode",
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
    nameKey: "fmMode",
    descKey: "descFmMode",
    spec: { kind: "enum", states: selfMap(["Auto", "Mono"]) },
    write: true,
    role: "state"
  },
  // Tuning/stereo indicators (official list; both push auto-feedback).
  {
    subunit: "TUN",
    func: "TUNED",
    state: "tuner.tuned",
    nameKey: "tunedToAStation",
    descKey: "descTunedToAStation",
    spec: { kind: "onoff", on: "Assert", off: "Negate" },
    write: false,
    role: "indicator"
  },
  {
    subunit: "TUN",
    func: "SIGSTEREOMONO",
    state: "tuner.stereo",
    nameKey: "stereoReception",
    descKey: "descStereoReception",
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
    nameKey: "saveToPreset0FirstFreeSlot",
    descKey: "descSaveToPreset0FirstFreeSlot",
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
  { func: "MODELNAME", state: "info.model", nameKey: "model", spec: { kind: "text" }, write: false, role: "text" },
  {
    func: "VERSION",
    state: "info.firmware",
    nameKey: "firmwareVersion",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    func: "PWR",
    state: "multiroom.masterPower",
    nameKey: "masterPowerAllZones",
    descKey: "descMasterPowerAllZones",
    spec: { kind: "onoff", on: "On", off: "Standby" },
    write: true,
    role: "switch.power"
  },
  {
    func: "PARTYMUTE",
    state: "multiroom.partyMute",
    nameKey: "partyMuteAllZones",
    descKey: "descPartyMuteAllZones",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "media.mute"
  },
  {
    func: "HDMIOUT1",
    state: "hdmi.out1",
    nameKey: "hdmiOUT1",
    descKey: "descHdmiOUT1",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "HDMIOUT2",
    state: "hdmi.out2",
    nameKey: "hdmiOUT2",
    descKey: "descHdmiOUT2",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "HDMIOUT3",
    state: "hdmi.out3",
    nameKey: "hdmiOUT3",
    descKey: "descHdmiOUT3",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch"
  },
  {
    func: "SPPATTERN",
    state: "advanced.speakers.pattern",
    nameKey: "speakerPattern",
    descKey: "descSpeakerPattern",
    spec: { kind: "enum", states: SPPATTERN_STATES },
    write: true,
    role: "state"
  },
  {
    func: "SPPATTERN1SWFR1CNFG",
    state: "advanced.speakers.pattern1Swfr1",
    nameKey: "speakerPattern1Subwoofer1",
    descKey: "descSpeakerPattern1Subwoofer1",
    spec: { kind: "enum", states: SWFR_CNFG_STATES },
    write: true,
    role: "state"
  },
  {
    func: "SPPATTERN1SWFR2CNFG",
    state: "advanced.speakers.pattern1Swfr2",
    nameKey: "speakerPattern1Subwoofer2",
    descKey: "descSpeakerPattern1Subwoofer2",
    spec: { kind: "enum", states: SWFR_CNFG_STATES },
    write: true,
    role: "state"
  },
  {
    func: "SPPATTERN2SWFR1CNFG",
    state: "advanced.speakers.pattern2Swfr1",
    nameKey: "speakerPattern2Subwoofer1",
    descKey: "descSpeakerPattern2Subwoofer1",
    spec: { kind: "enum", states: SWFR_CNFG_STATES },
    write: true,
    role: "state"
  },
  {
    func: "SPPATTERN2SWFR2CNFG",
    state: "advanced.speakers.pattern2Swfr2",
    nameKey: "speakerPattern2Subwoofer2",
    descKey: "descSpeakerPattern2Subwoofer2",
    spec: { kind: "enum", states: SWFR_CNFG_STATES },
    write: true,
    role: "state"
  },
  // Amp-assign for speaker pattern 1 (official RX-V671 list: PUT+GET with the three
  // documented values; the RX-V6A answers "Basic").
  {
    func: "SPPATTERN1AMP",
    state: "advanced.speakers.pattern1Amp",
    nameKey: "speakerPattern1AmpAssign",
    descKey: "descSpeakerPattern1AmpAssign",
    spec: { kind: "enum", states: selfMap(["Basic", "7ch +1ZONE", "5ch BI-AMP"]) },
    write: true,
    role: "state"
  },
  // Trigger-out 1 manual level (official list: PUT+GET, Lo/Hi).
  {
    func: "TRIG1MANUAL",
    state: "advanced.trigger1Manual",
    nameKey: "triggerOut1ManualLevel",
    descKey: "descTriggerOut1ManualLevel",
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
    nameKey: "yncaControlPort",
    descKey: "descYncaControlPort",
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
    nameKey: "band",
    spec: { kind: "enum", states: DAB_BAND_STATES },
    write: true,
    role: "state"
  },
  {
    func: "DABCHLABEL",
    state: "dab.channelLabel",
    nameKey: "dabChannel",
    descKey: "descDabChannel",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    func: "DABDLSLABEL",
    state: "dab.dls",
    nameKey: "dabDLSText",
    descKey: "descDabDLSText",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    func: "DABENSEMBLELABEL",
    state: "dab.ensembleLabel",
    nameKey: "dabEnsemble",
    descKey: "descDabEnsemble",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    func: "DABSERVICELABEL",
    state: "dab.serviceLabel",
    nameKey: "dabService",
    descKey: "descDabService",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    func: "DABPRESET",
    state: "preset",
    nameKey: "presetRecallByNumber",
    descKey: "descPresetRecallByNumber",
    spec: { kind: "number", min: 0, max: 40, step: 1, decimals: 0 },
    write: true,
    role: "level",
    wireDecode: (wire) => wire === "No Preset" ? "0" : wire
  },
  {
    func: "DABPRGTYPE",
    state: "dab.programType",
    nameKey: "dabProgramType",
    descKey: "descDabProgramType",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    func: "FMPRESET",
    state: "preset",
    nameKey: "presetRecallByNumber",
    descKey: "descPresetRecallByNumber",
    spec: { kind: "number", min: 0, max: 40, step: 1, decimals: 0 },
    write: true,
    role: "level",
    wireDecode: (wire) => wire === "No Preset" ? "0" : wire
  },
  {
    func: "FMRDSPRGSERVICE",
    state: "rdsService",
    nameKey: "rdsStation",
    descKey: "descRdsStation",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    func: "FMRDSPRGTYPE",
    state: "rdsProgramType",
    nameKey: "rdsProgramType",
    descKey: "descRdsProgramType",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    func: "FMRDSTXT",
    state: "rdsText",
    nameKey: "rdsText",
    descKey: "descRdsText",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    func: "FMSEARCHMODE",
    state: "searchMode",
    nameKey: "searchMode",
    descKey: "descSearchMode",
    spec: { kind: "enum", states: TUN_SEARCHMODE_STATES },
    write: true,
    role: "state"
  },
  {
    func: "FMFREQ",
    state: "frequency",
    nameKey: "frequency",
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
    nameKey: "audioMode",
    descKey: "descAudioMode",
    spec: { kind: "text" },
    write: false,
    // `state` like the MusicCast side — see sound.toneMode above.
    role: "state"
  },
  {
    func: "DABBITRATE",
    state: "dab.bitRate",
    nameKey: "bitRate",
    descKey: "descBitRate",
    spec: { kind: "number", decimals: 0 },
    write: false,
    role: "value"
  },
  {
    func: "DABDATETIME",
    state: "dab.dateTime",
    nameKey: "dabDateTime",
    descKey: "descDabDateTime",
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
    nameKey: "offAir",
    descKey: "descOffAir",
    spec: { kind: "onoff", on: "Assert", off: "Negate" },
    write: false,
    role: "indicator"
  },
  {
    func: "FMRDSCLOCK",
    state: "rdsClock",
    nameKey: "rdsClock",
    descKey: "descRdsClock",
    spec: { kind: "text" },
    write: false,
    role: "text"
  },
  {
    func: "FMSIGSTEREOMONO",
    state: "stereo",
    nameKey: "stereoReception",
    descKey: "descStereoReception",
    spec: { kind: "onoff", on: "Assert", off: "Negate" },
    write: false,
    role: "indicator"
  },
  {
    func: "FMTUNED",
    state: "tuned",
    nameKey: "tunedToAStation",
    descKey: "descTunedToAStation",
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
    nameKey: "playback",
    // media.state must be a number for the type-detector media-player slot; PLAYBACKINFO
    // reports Play/Pause/Stop (Skip Fwd/Rev are the separate next/prev buttons below).
    spec: { kind: "code", codes: { Play: 0, Stop: 1, Pause: 2 }, labels: { 0: "Play", 1: "Stop", 2: "Pause" } },
    write: true,
    role: "media.state"
  },
  { func: "ARTIST", state: "artist", nameKey: "artist", spec: { kind: "text" }, write: false, role: "media.artist" },
  { func: "ALBUM", state: "album", nameKey: "album", spec: { kind: "text" }, write: false, role: "media.album" },
  // Streaming sources (Spotify/Tidal/Deezer, and Pandora firmware-dependent) report the
  // title under TRACK; older sources (server/usb/netradio/…) under SONG. Both feed `track`.
  {
    func: "SONG",
    readAliases: ["TRACK"],
    state: "track",
    nameKey: "track",
    spec: { kind: "text" },
    write: false,
    role: "media.title"
  },
  { func: "STATION", state: "station", nameKey: "station", spec: { kind: "text" }, write: false, role: "text" },
  { func: "CHNAME", state: "channelName", nameKey: "channelName", spec: { kind: "text" }, write: false, role: "text" },
  // The times come off the YNCA wire as text ("1:23") and off MusicCast as seconds. Both
  // forms are published on every device, from the one value: the NUMBER fills the type
  // detector's media-player slot (it accepts nothing else), the text is what a
  // visualisation shows. Without the number a YNCA-only receiver had no time at all in
  // the player, and the datapoint's very type depended on which protocol answered.
  {
    func: "TOTALTIME",
    state: "totalTime",
    nameKey: "totalTime",
    descKey: "descTotalTime",
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
    nameKey: "totalTimeReadable",
    descKey: "descTotalTimeReadable",
    spec: { kind: "text" },
    write: false,
    role: "media.duration.text",
    derived: true
  },
  {
    func: "ELAPSEDTIME",
    state: "elapsedTime",
    nameKey: "elapsedTime",
    descKey: "descElapsedTime",
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
    nameKey: "elapsedTimeReadable",
    descKey: "descElapsedTimeReadable",
    spec: { kind: "text" },
    write: false,
    role: "media.elapsed.text",
    derived: true
  },
  {
    func: "REPEAT",
    state: "repeat",
    nameKey: "repeat",
    // media.mode.repeat is a number in the type-detector (off/one/all); code-mapped so it fills
    // the REPEAT slot and still reads/writes as labels.
    spec: { kind: "code", codes: { Off: 0, Single: 1, All: 2 }, labels: { 0: "Off", 1: "Single", 2: "All" } },
    write: true,
    role: "media.mode.repeat"
  },
  {
    func: "SHUFFLE",
    state: "shuffle",
    nameKey: "shuffle",
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
    nameKey: "next",
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
    nameKey: "previous",
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
    descKey: fn.descKey,
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
    nameKey: "recallScene",
    descKey: "descRecallScene",
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
      nameKey: "inputName",
      descKey: "descInputName",
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
        descKey: fn.descKey,
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
        nameKey: "recallPreset",
        descKey: "descRecallPreset",
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
        nameKey: "saveToPreset0FirstFreeSlot",
        descKey: "descSaveToPreset0FirstFreeSlot",
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
    nameKey: "bookmarkCurrentStation",
    descKey: "descBookmarkCurrentStation",
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
      nameKey: "connected",
      spec: { kind: "onoff", on: "Connected", off: "Disconnected" },
      write: false,
      role: "indicator",
      subunit: "BT",
      func: "CONNECTINFO"
    },
    {
      id: "player.bluetooth.connect",
      nameKey: "connect",
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
      nameKey: "startPairing",
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
      nameKey: "cancelPairing",
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
      nameKey: "pairedDevice",
      spec: { kind: "text" },
      write: false,
      role: "text",
      subunit: "BT",
      func: "DEVICENAME"
    },
    {
      id: "player.airplay.volumeInterlock",
      nameKey: "volumeInterlock",
      descKey: "descVolumeInterlock",
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
