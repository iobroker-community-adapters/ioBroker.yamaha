import { catalogToObjects } from "../catalog/build-objects";
import type { CatalogEntry, ObjectDef } from "../catalog/types";
import { decode, encode, isWritableValue, type ValueSpec } from "../catalog/value-coerce";
import type { StateValue } from "../types";
import type { YncaCapabilities } from "./capability";

/**
 * A YNCA catalog entry: the object part ({@link CatalogEntry}) plus its subunit
 * and function — the single source from which the init sweep, the device→state
 * read-back and the state→wire encode are all derived (no second table).
 */
export interface YncaEntry extends CatalogEntry {
  /** The YNCA subunit (MAIN, ZONE2, SYS, TUN, …). */
  subunit: string;
  /** The YNCA function name used to WRITE this state (PWR, VOL, …). */
  func: string;
  /**
   * The function the device REPORTS this state under, when it differs from the
   * write function — e.g. playback writes to PLAYBACK but is reported via
   * PLAYBACKINFO. The init sweep and the device→state read-back key on this;
   * defaults to {@link func}.
   */
  readFunc?: string;
}

/**
 * The function a device reports an entry under: its explicit readFunc, or its
 * write func when none is set.
 *
 * @param entry the catalog entry
 * @returns the function to key reads on
 */
function readFuncOf(entry: YncaEntry): string {
  return entry.readFunc ?? entry.func;
}

/**
 * Build a wire-value → label map — YNCA enum labels equal their wire value.
 *
 * @param values the enum wire values
 * @returns the states map for a dropdown
 */
function selfMap(values: string[]): Record<string, string> {
  return Object.fromEntries(values.map(value => [value, value]));
}

// The full device-agnostic input list (every input any Yamaha may report); a
// device shows only the ones it has, but the dropdown offers all valid values.
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
  "USB",
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
  "All-Ch Stereo",
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
  "AURO-3D",
]);

/** Amplifier functions shared by MAIN and each zone: state id + YNCA func + value spec. */
/** A per-function catalog definition, before its zone/subunit prefix and id are applied. */
interface FuncDef {
  func: string;
  state: string;
  name: string;
  spec: ValueSpec;
  write: boolean;
  role: string;
}

const AMP_FUNCS: FuncDef[] = [
  {
    func: "PWR",
    state: "power",
    name: "Power",
    spec: { kind: "onoff", on: "On", off: "Standby" },
    write: true,
    role: "switch.power",
  },
  {
    func: "VOL",
    state: "volume",
    name: "Volume",
    spec: { kind: "number", unit: "dB", min: -80.5, max: 16.5, step: 0.5 },
    write: true,
    role: "level.volume",
  },
  {
    func: "MUTE",
    state: "mute",
    name: "Mute",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "media.mute",
  },
  {
    func: "INP",
    state: "input",
    name: "Input",
    spec: { kind: "enum", states: INPUT_STATES },
    write: true,
    role: "media.input",
  },
  {
    func: "SOUNDPRG",
    state: "soundProgram",
    name: "Sound program",
    spec: { kind: "enum", states: SOUNDPRG_STATES },
    write: true,
    role: "state",
  },
  {
    func: "STRAIGHT",
    state: "straight",
    name: "Straight",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "ENHANCER",
    state: "enhancer",
    name: "Enhancer",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "PUREDIRMODE",
    state: "pureDirect",
    name: "Pure Direct",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "SLEEP",
    state: "sleep",
    name: "Sleep timer",
    spec: { kind: "enum", states: SLEEP_STATES },
    write: true,
    role: "state",
  },
  {
    func: "SPBASS",
    state: "sound.bass",
    name: "Bass",
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5 },
    write: true,
    role: "level",
  },
  {
    func: "SPTREBLE",
    state: "sound.treble",
    name: "Treble",
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5 },
    write: true,
    role: "level",
  },
  {
    func: "HDMIOUT",
    state: "hdmiOut",
    name: "HDMI output",
    spec: { kind: "enum", states: HDMIOUT_STATES },
    write: true,
    role: "state",
  },
  {
    func: "ADAPTIVEDRC",
    state: "adaptiveDrc",
    name: "Adaptive DRC",
    spec: { kind: "enum", states: ADAPTIVEDRC_STATES },
    write: true,
    role: "state",
  },
  {
    func: "SURROUNDAI",
    state: "surroundAI",
    name: "Surround AI",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "DIRMODE",
    state: "directMode",
    name: "Direct mode",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "2CHDECODER",
    state: "surroundDecoder",
    name: "Surround decoder",
    spec: { kind: "enum", states: DECODER_STATES },
    write: true,
    role: "state",
  },
  {
    func: "HPBASS",
    state: "sound.headphoneBass",
    name: "Headphone bass",
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5 },
    write: true,
    role: "level",
  },
  {
    func: "HPTREBLE",
    state: "sound.headphoneTreble",
    name: "Headphone treble",
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5 },
    write: true,
    role: "level",
  },
  {
    func: "EXBASS",
    state: "extraBass",
    name: "Extra Bass",
    spec: { kind: "onoff", on: "Auto", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "3DCINEMA",
    state: "cinemaDsp3d",
    name: "CINEMA DSP 3D",
    spec: { kind: "onoff", on: "Auto", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "INITVOLMODE",
    state: "initialVolume.mode",
    name: "Initial volume mode",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "INITVOLLVL",
    state: "initialVolume.level",
    name: "Initial volume level",
    spec: { kind: "number", unit: "dB", min: -80.5, max: 16.5, step: 0.5 },
    write: true,
    role: "level.volume",
  },
  {
    func: "MAXVOL",
    state: "maxVolume",
    name: "Maximum volume",
    spec: { kind: "number", unit: "dB", min: -30, max: 16.5, step: 5 },
    write: true,
    role: "level.volume",
  },
  {
    func: "LIPSYNCHDMIOUT1OFFSET",
    state: "lipSync.hdmiOut1",
    name: "Lip sync HDMI OUT1 offset",
    spec: { kind: "number", unit: "ms" },
    write: true,
    role: "level",
  },
  {
    func: "LIPSYNCHDMIOUT2OFFSET",
    state: "lipSync.hdmiOut2",
    name: "Lip sync HDMI OUT2 offset",
    spec: { kind: "number", unit: "ms" },
    write: true,
    role: "level",
  },
  {
    func: "ZONENAME",
    state: "zoneName",
    name: "Zone name",
    spec: { kind: "text" },
    write: true,
    role: "text",
  },
];

const ZONEB_AVAIL_STATES = selfMap(["Not Connected", "Not Ready", "Ready"]);

/**
 * MAIN-only amplifier functions: the Zone-B sub-zone (a second output area only
 * the main subunit exposes), the A/B speaker toggles, and the 12 scene names.
 * Kept out of AMP_FUNCS so they are not created for ZONE2-4.
 */
const MAIN_ONLY_FUNCS: FuncDef[] = [
  {
    func: "SPEAKERA",
    state: "speakerA",
    name: "Speaker A",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "SPEAKERB",
    state: "speakerB",
    name: "Speaker B",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "PWRB",
    state: "zoneB.power",
    name: "Zone B power",
    spec: { kind: "onoff", on: "On", off: "Standby" },
    write: true,
    role: "switch.power",
  },
  {
    func: "ZONEBAVAIL",
    state: "zoneB.available",
    name: "Zone B availability",
    spec: { kind: "enum", states: ZONEB_AVAIL_STATES },
    write: false,
    role: "state",
  },
  {
    func: "ZONEBMUTE",
    state: "zoneB.mute",
    name: "Zone B mute",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "media.mute",
  },
  {
    func: "ZONEBVOL",
    state: "zoneB.volume",
    name: "Zone B volume",
    spec: { kind: "number", unit: "dB", min: -80.5, max: 16.5, step: 0.5 },
    write: true,
    role: "level.volume",
  },
  {
    func: "ZONEBNAME",
    state: "zoneB.name",
    name: "Zone B name",
    spec: { kind: "text" },
    write: true,
    role: "text",
  },
];

const BAND_STATES = selfMap(["AM", "FM"]);
const TUN_SEARCHMODE_STATES = selfMap(["Preset", "Tuning"]);
const DAB_BAND_STATES = selfMap(["DAB", "FM"]);

/** The zones the catalog maps: MAIN flat, ZONE2-4 each under their own prefix. */
const ZONES: Array<{ subunit: string; prefix: string }> = [
  { subunit: "MAIN", prefix: "" },
  { subunit: "ZONE2", prefix: "zone2." },
  { subunit: "ZONE3", prefix: "zone3." },
  { subunit: "ZONE4", prefix: "zone4." },
];

/** Global (non-zone) functions: one subunit each. State id carries its own channel. */
const GLOBAL_FUNCS: Array<FuncDef & { subunit: string }> = [
  {
    subunit: "SYS",
    func: "PARTY",
    state: "party",
    name: "Party mode",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    subunit: "TUN",
    func: "BAND",
    state: "tuner.band",
    name: "Band",
    spec: { kind: "enum", states: BAND_STATES },
    write: true,
    role: "state",
  },
  {
    subunit: "TUN",
    func: "RDSTXTA",
    state: "tuner.rdsText",
    name: "RDS text",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  {
    subunit: "TUN",
    func: "RDSPRGSERVICE",
    state: "tuner.rdsService",
    name: "RDS station",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  {
    subunit: "TUN",
    func: "AMFREQ",
    state: "tuner.amFrequency",
    name: "AM frequency",
    spec: { kind: "number", unit: "kHz" },
    write: true,
    role: "level",
  },
  {
    subunit: "TUN",
    func: "FMFREQ",
    state: "tuner.fmFrequency",
    name: "FM frequency",
    spec: { kind: "number", unit: "kHz" },
    write: true,
    role: "level",
  },
  {
    subunit: "TUN",
    func: "RDSTXTB",
    state: "tuner.rdsTextB",
    name: "RDS text B",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  {
    subunit: "TUN",
    func: "RDSPRGTYPE",
    state: "tuner.rdsProgramType",
    name: "RDS program type",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  {
    subunit: "TUN",
    func: "SEARCHMODE",
    state: "tuner.searchMode",
    name: "Search mode",
    spec: { kind: "enum", states: TUN_SEARCHMODE_STATES },
    write: true,
    role: "state",
  },
];

const SPPATTERN_STATES = selfMap(["Pattern 1", "Pattern 2"]);
const SWFR_CNFG_STATES = selfMap(["None", "Use"]);

/**
 * SYS (system-wide) functions beyond party: model/version info, the system power
 * (all zones), the party mute, the HDMI-output toggles and the speaker patterns.
 * The 23 assignable input names are generated separately from {@link INPUT_NAME_KEYS}.
 */
const SYS_FUNCS: FuncDef[] = [
  { func: "MODELNAME", state: "system.model", name: "Model", spec: { kind: "text" }, write: false, role: "text" },
  {
    func: "VERSION",
    state: "system.version",
    name: "Firmware version",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  {
    func: "PWR",
    state: "system.power",
    name: "System power",
    spec: { kind: "onoff", on: "On", off: "Standby" },
    write: true,
    role: "switch.power",
  },
  {
    func: "PARTYMUTE",
    state: "partyMute",
    name: "Party mute",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "media.mute",
  },
  {
    func: "HDMIOUT1",
    state: "system.hdmiOut1",
    name: "HDMI OUT1",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "HDMIOUT2",
    state: "system.hdmiOut2",
    name: "HDMI OUT2",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "HDMIOUT3",
    state: "system.hdmiOut3",
    name: "HDMI OUT3",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "SPPATTERN",
    state: "system.speakerPattern",
    name: "Speaker pattern",
    spec: { kind: "enum", states: SPPATTERN_STATES },
    write: true,
    role: "state",
  },
  {
    func: "SPPATTERN1SWFR1CNFG",
    state: "system.speakerPattern1Swfr1",
    name: "Speaker pattern 1 subwoofer 1",
    spec: { kind: "enum", states: SWFR_CNFG_STATES },
    write: true,
    role: "state",
  },
  {
    func: "SPPATTERN1SWFR2CNFG",
    state: "system.speakerPattern1Swfr2",
    name: "Speaker pattern 1 subwoofer 2",
    spec: { kind: "enum", states: SWFR_CNFG_STATES },
    write: true,
    role: "state",
  },
  {
    func: "SPPATTERN2SWFR1CNFG",
    state: "system.speakerPattern2Swfr1",
    name: "Speaker pattern 2 subwoofer 1",
    spec: { kind: "enum", states: SWFR_CNFG_STATES },
    write: true,
    role: "state",
  },
  {
    func: "SPPATTERN2SWFR2CNFG",
    state: "system.speakerPattern2Swfr2",
    name: "Speaker pattern 2 subwoofer 2",
    spec: { kind: "enum", states: SWFR_CNFG_STATES },
    write: true,
    role: "state",
  },
];

// The 23 assignable input names (SYS INPNAME<KEY>, read-only text). The wire
// function is INPNAME + the upper-cased key (audio1 → INPNAMEAUDIO1).
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
  "vaux",
];

/**
 * DAB tuner functions (the `@DAB` subunit on DAB+-capable receivers). Mapped under
 * a `dab` channel of their own so DAB/FM labels never collide with the AM/FM `@TUN`
 * tuner's `tuner.*` states. The subunit also carries an FM frequency (FMFREQ).
 */
const DAB_FUNCS: FuncDef[] = [
  {
    func: "BAND",
    state: "dab.band",
    name: "DAB band",
    spec: { kind: "enum", states: DAB_BAND_STATES },
    write: true,
    role: "state",
  },
  {
    func: "DABCHLABEL",
    state: "dab.channelLabel",
    name: "DAB channel",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  { func: "DABDLSLABEL", state: "dab.dls", name: "DAB DLS text", spec: { kind: "text" }, write: false, role: "text" },
  {
    func: "DABENSEMBLELABEL",
    state: "dab.ensembleLabel",
    name: "DAB ensemble",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  {
    func: "DABSERVICELABEL",
    state: "dab.serviceLabel",
    name: "DAB service",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  { func: "DABPRESET", state: "dab.preset", name: "DAB preset", spec: { kind: "text" }, write: false, role: "text" },
  {
    func: "DABPRGTYPE",
    state: "dab.programType",
    name: "DAB program type",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  { func: "FMPRESET", state: "dab.fmPreset", name: "FM preset", spec: { kind: "text" }, write: false, role: "text" },
  {
    func: "FMRDSPRGSERVICE",
    state: "dab.fmRdsService",
    name: "FM RDS station",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  {
    func: "FMRDSPRGTYPE",
    state: "dab.fmRdsProgramType",
    name: "FM RDS program type",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  { func: "FMRDSTXT", state: "dab.fmRdsText", name: "FM RDS text", spec: { kind: "text" }, write: false, role: "text" },
  {
    func: "FMSEARCHMODE",
    state: "dab.fmSearchMode",
    name: "FM search mode",
    spec: { kind: "enum", states: TUN_SEARCHMODE_STATES },
    write: true,
    role: "state",
  },
  {
    func: "FMFREQ",
    state: "dab.fmFrequency",
    name: "FM frequency",
    spec: { kind: "number", unit: "kHz" },
    write: true,
    role: "level",
  },
];

const PLAYBACK_STATES = selfMap(["Play", "Pause", "Stop"]);
const REPEAT_STATES = selfMap(["Off", "Single", "All"]);

/**
 * Network/media player sources — each a subunit, mapped under its own channel. Only
 * the entries a device reports are created, so listing every source is safe.
 */
const PLAYER_SOURCES: Array<{ subunit: string; channel: string }> = [
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
  { subunit: "IPODUSB", channel: "ipodUsb" },
];

/** The playback functions shared by every player source (the __init__ mixin in the lib). */
const PLAYER_FUNCS: Array<{
  func: string;
  readFunc?: string;
  state: string;
  name: string;
  spec: ValueSpec;
  write: boolean;
  role: string;
}> = [
  {
    func: "PLAYBACK",
    readFunc: "PLAYBACKINFO",
    state: "playback",
    name: "Playback",
    spec: { kind: "enum", states: PLAYBACK_STATES },
    write: true,
    role: "media.state",
  },
  { func: "ARTIST", state: "artist", name: "Artist", spec: { kind: "text" }, write: false, role: "media.artist" },
  { func: "ALBUM", state: "album", name: "Album", spec: { kind: "text" }, write: false, role: "media.album" },
  { func: "SONG", state: "track", name: "Track", spec: { kind: "text" }, write: false, role: "media.title" },
  { func: "STATION", state: "station", name: "Station", spec: { kind: "text" }, write: false, role: "text" },
  { func: "CHNAME", state: "channelName", name: "Channel name", spec: { kind: "text" }, write: false, role: "text" },
  { func: "PRESET", state: "preset", name: "Preset", spec: { kind: "text" }, write: false, role: "text" },
  {
    func: "TOTALTIME",
    state: "totalTime",
    name: "Total time",
    spec: { kind: "text" },
    write: false,
    role: "media.duration.text",
  },
  {
    func: "ELAPSEDTIME",
    state: "elapsedTime",
    name: "Elapsed time",
    spec: { kind: "text" },
    write: false,
    role: "media.elapsed.text",
  },
  {
    func: "REPEAT",
    state: "repeat",
    name: "Repeat",
    spec: { kind: "enum", states: REPEAT_STATES },
    write: true,
    role: "state",
  },
  {
    func: "SHUFFLE",
    state: "shuffle",
    name: "Shuffle",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
];

/**
 * Turn a list of function definitions into catalog entries on one subunit, applying
 * an optional id prefix — the shared shape behind the amp/zone/SYS/DAB/global blocks.
 *
 * @param fns the function definitions
 * @param subunit the subunit the functions live on
 * @param prefix optional id prefix (e.g. a zone's `zone2.`)
 * @returns the catalog entries
 */
function fnEntries(fns: readonly FuncDef[], subunit: string, prefix = ""): YncaEntry[] {
  return fns.map(fn => ({
    id: `${prefix}${fn.state}`,
    name: fn.name,
    spec: fn.spec,
    write: fn.write,
    role: fn.role,
    subunit,
    func: fn.func,
  }));
}

/**
 * Build the device-agnostic YNCA catalog: every amplifier function for MAIN and each
 * zone, the global SYS/TUN functions, and the playback functions for each network/media
 * player source. The per-device mapper keeps only the entries the device reports.
 *
 * @returns the catalog entries
 */
export function buildYncaCatalog(): YncaEntry[] {
  const entries: YncaEntry[] = [];
  for (const zone of ZONES) {
    entries.push(...fnEntries(AMP_FUNCS, zone.subunit, zone.prefix));
  }
  // MAIN-only functions (Zone B sub-zone, speaker toggles).
  entries.push(...fnEntries(MAIN_ONLY_FUNCS, "MAIN"));
  // The 12 scene names (read-only) live on MAIN.
  for (let n = 1; n <= 12; n++) {
    entries.push({
      id: `scene.name${n}`,
      name: `Scene ${n} name`,
      spec: { kind: "text" },
      write: false,
      role: "text",
      subunit: "MAIN",
      func: `SCENE${n}NAME`,
    });
  }
  // Global functions each carry their own subunit.
  for (const fn of GLOBAL_FUNCS) {
    entries.push(...fnEntries([fn], fn.subunit));
  }
  entries.push(...fnEntries(SYS_FUNCS, "SYS"));
  for (const key of INPUT_NAME_KEYS) {
    const upper = key.toUpperCase();
    entries.push({
      id: `system.inputName.${key}`,
      name: `Input name ${upper}`,
      spec: { kind: "text" },
      write: false,
      role: "text",
      subunit: "SYS",
      func: `INPNAME${upper}`,
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
      });
    }
  }
  return entries;
}

/**
 * The init-sweep GETs: each (subunit, func) once.
 *
 * @param entries the catalog entries
 * @returns the subunit/function pairs to query
 */
export function sweepGets(entries: YncaEntry[]): Array<{ subunit: string; func: string }> {
  const seen = new Set<string>();
  const gets: Array<{ subunit: string; func: string }> = [];
  for (const entry of entries) {
    const func = readFuncOf(entry);
    const key = `${entry.subunit}:${func}`;
    if (!seen.has(key)) {
      seen.add(key);
      gets.push({ subunit: entry.subunit, func });
    }
  }
  return gets;
}

/**
 * Map `subunit:func` → catalog entry, for turning a device line into a state.
 *
 * @param entries the catalog entries
 * @returns the lookup map keyed `SUBUNIT:FUNC`
 */
export function funcToEntry(entries: YncaEntry[]): Map<string, YncaEntry> {
  return new Map(entries.map(entry => [`${entry.subunit}:${readFuncOf(entry)}`, entry]));
}

/**
 * Map state id → catalog entry, for turning a user write into a YNCA command.
 *
 * @param entries the catalog entries
 * @returns the lookup map keyed by state id
 */
export function idToEntry(entries: YncaEntry[]): Map<string, YncaEntry> {
  return new Map(entries.map(entry => [entry.id, entry]));
}

/**
 * Build the object tree for a device from its reported capabilities: keep only
 * the catalog entries the device answered for, then turn them into objects.
 *
 * @param capabilities the device's YNCA capabilities from the init sweep
 * @returns the object definitions to create
 */
export function yncaObjectsFor(capabilities: YncaCapabilities): ObjectDef[] {
  const present = buildYncaCatalog().filter(
    entry => capabilities.subunits[entry.subunit]?.[readFuncOf(entry)] !== undefined,
  );
  return catalogToObjects(present);
}

/**
 * Turn a device line into a typed state update via the func map, or undefined
 * when the function is not catalogued or the value is not decodable.
 *
 * @param message the decoded YNCA message (subunit/func/value)
 * @param message.subunit the message's subunit (MAIN, ZONE2, …)
 * @param message.func the message's function name
 * @param message.value the message's raw wire value
 * @param map the `funcToEntry` map
 * @returns the typed state update, or undefined
 */
export function yncaStateUpdate(
  message: { subunit: string; func: string; value: string },
  map: Map<string, YncaEntry>,
): StateValue | undefined {
  const entry = map.get(`${message.subunit}:${message.func}`);
  if (!entry) {
    return undefined;
  }
  const value = decode(entry.spec, message.value);
  return value === undefined ? undefined : { id: entry.id, value };
}

/**
 * Turn a user write into a YNCA subunit/func/value triple via the id map, or
 * undefined when the state is not catalogued.
 *
 * @param stateId the state id relative to the device
 * @param value the value written to the state
 * @param map the `idToEntry` map
 * @returns the triple to send, or undefined
 */
export function yncaCommand(
  stateId: string,
  value: unknown,
  map: Map<string, YncaEntry>,
): { subunit: string; func: string; value: string } | undefined {
  const entry = map.get(stateId);
  if (!entry) {
    return undefined;
  }
  // Guard the write value: a null/undefined or non-finite-number write must not be
  // turned into a bogus command (e.g. `@TUN:AMFREQ=null`).
  if (!isWritableValue(value, entry.spec.kind === "number")) {
    return undefined;
  }
  return { subunit: entry.subunit, func: entry.func, value: encode(entry.spec, value as boolean | number | string) };
}
