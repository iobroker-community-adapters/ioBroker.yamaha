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
  /**
   * Additional wire functions that report into this same state, beyond {@link readFunc}.
   * Some sources answer the same datum under a different function name (e.g. streaming
   * sources report the title under TRACK, older sources under SONG). Each alias is swept
   * and read-mapped to this one entry, without creating a second object for the state.
   */
  readAliases?: string[];
  /**
   * Write-only command (e.g. scene recall): the device never pushes it, so it is
   * kept out of {@link funcToEntry} (no device→state mapping). Its {@link readFunc}
   * is reused purely to gate object creation on a related reported function.
   */
  writeOnly?: boolean;
  /**
   * Optional wire-value encoder overriding the generic {@link encode} — for a
   * command whose wire form is not the bare value (scene recall sends "Scene N").
   */
  wireEncode?: (value: boolean | number | string) => string;
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
 * Every wire function a device may report an entry under: its read func plus any
 * {@link YncaEntry.readAliases}. Used by the sweep, the device→state map and the
 * object-creation gate so an aliased state is filled whichever function carries it.
 *
 * @param entry the catalog entry
 * @returns the functions to key reads on (at least one)
 */
function readFuncsOf(entry: YncaEntry): string[] {
  return entry.readAliases ? [readFuncOf(entry), ...entry.readAliases] : [readFuncOf(entry)];
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
    state: "sound.straight",
    name: "Straight",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "ENHANCER",
    state: "sound.enhancer",
    name: "Enhancer",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "PUREDIRMODE",
    state: "sound.pureDirect",
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
    state: "hdmi.output",
    name: "HDMI output",
    spec: { kind: "enum", states: HDMIOUT_STATES },
    write: true,
    role: "state",
  },
  {
    func: "ADAPTIVEDRC",
    state: "sound.adaptiveDrc",
    name: "Adaptive DRC",
    spec: { kind: "enum", states: ADAPTIVEDRC_STATES },
    write: true,
    role: "state",
  },
  {
    func: "SURROUNDAI",
    state: "sound.surroundAI",
    name: "Surround AI",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "DIRMODE",
    state: "sound.direct",
    name: "Direct",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "2CHDECODER",
    state: "sound.surroundDecoder",
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
    state: "sound.extraBass",
    name: "Extra Bass",
    spec: { kind: "onoff", on: "Auto", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "3DCINEMA",
    state: "sound.cinemaDsp3d",
    name: "CINEMA DSP 3D",
    spec: { kind: "onoff", on: "Auto", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "INITVOLMODE",
    state: "advanced.initialVolume.mode",
    name: "Initial volume mode",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "INITVOLLVL",
    state: "advanced.initialVolume.level",
    name: "Initial volume level",
    spec: { kind: "number", unit: "dB", min: -80.5, max: 16.5, step: 0.5 },
    write: true,
    role: "level.volume",
  },
  {
    func: "MAXVOL",
    state: "advanced.maxVolume",
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
    state: "advanced.speakerA",
    name: "Speaker A",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "SPEAKERB",
    state: "advanced.speakerB",
    name: "Speaker B",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "PWRB",
    state: "multiroom.zoneB.power",
    name: "Zone B power",
    spec: { kind: "onoff", on: "On", off: "Standby" },
    write: true,
    role: "switch.power",
  },
  {
    func: "ZONEBAVAIL",
    state: "multiroom.zoneB.available",
    name: "Zone B availability",
    spec: { kind: "enum", states: ZONEB_AVAIL_STATES },
    write: false,
    role: "state",
  },
  {
    func: "ZONEBMUTE",
    state: "multiroom.zoneB.mute",
    name: "Zone B mute",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "media.mute",
  },
  {
    func: "ZONEBVOL",
    state: "multiroom.zoneB.volume",
    name: "Zone B volume",
    spec: { kind: "number", unit: "dB", min: -80.5, max: 16.5, step: 0.5 },
    write: true,
    role: "level.volume",
  },
  {
    func: "ZONEBNAME",
    state: "multiroom.zoneB.name",
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
  { subunit: "ZONE2", prefix: "multiroom.zone2." },
  { subunit: "ZONE3", prefix: "multiroom.zone3." },
  { subunit: "ZONE4", prefix: "multiroom.zone4." },
];

/** Global (non-zone) functions: one subunit each. State id carries its own channel. */
const GLOBAL_FUNCS: Array<FuncDef & { subunit: string }> = [
  {
    subunit: "SYS",
    func: "PARTY",
    state: "multiroom.party",
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
  // Device metadata lives under the info channel (like govee's info.model/info.firmware),
  // not in the system grab-bag. Renamed from system.model/system.version (audit F7).
  { func: "MODELNAME", state: "info.model", name: "Model", spec: { kind: "text" }, write: false, role: "text" },
  {
    func: "VERSION",
    state: "info.firmware",
    name: "Firmware version",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  {
    func: "PWR",
    state: "multiroom.masterPower",
    name: "Master power (all zones)",
    spec: { kind: "onoff", on: "On", off: "Standby" },
    write: true,
    role: "switch.power",
  },
  {
    func: "PARTYMUTE",
    state: "multiroom.partyMute",
    name: "Party mute",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "media.mute",
  },
  {
    func: "HDMIOUT1",
    state: "hdmi.out1",
    name: "HDMI OUT1",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "HDMIOUT2",
    state: "hdmi.out2",
    name: "HDMI OUT2",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "HDMIOUT3",
    state: "hdmi.out3",
    name: "HDMI OUT3",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "SPPATTERN",
    state: "advanced.speakers.pattern",
    name: "Speaker pattern",
    spec: { kind: "enum", states: SPPATTERN_STATES },
    write: true,
    role: "state",
  },
  {
    func: "SPPATTERN1SWFR1CNFG",
    state: "advanced.speakers.pattern1Swfr1",
    name: "Speaker pattern 1 subwoofer 1",
    spec: { kind: "enum", states: SWFR_CNFG_STATES },
    write: true,
    role: "state",
  },
  {
    func: "SPPATTERN1SWFR2CNFG",
    state: "advanced.speakers.pattern1Swfr2",
    name: "Speaker pattern 1 subwoofer 2",
    spec: { kind: "enum", states: SWFR_CNFG_STATES },
    write: true,
    role: "state",
  },
  {
    func: "SPPATTERN2SWFR1CNFG",
    state: "advanced.speakers.pattern2Swfr1",
    name: "Speaker pattern 2 subwoofer 1",
    spec: { kind: "enum", states: SWFR_CNFG_STATES },
    write: true,
    role: "state",
  },
  {
    func: "SPPATTERN2SWFR2CNFG",
    state: "advanced.speakers.pattern2Swfr2",
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
  readAliases?: string[];
  state: string;
  name: string;
  spec: ValueSpec;
  write: boolean;
  role: string;
  /** Fixed wire value for an action button (e.g. Skip Fwd), overriding the spec's encode. */
  wireEncode?: (value: boolean | number | string) => string;
  /** Keep out of the device→state map (a write-only action, never read back). */
  writeOnly?: boolean;
}> = [
  {
    func: "PLAYBACK",
    readFunc: "PLAYBACKINFO",
    state: "playback",
    name: "Playback",
    // media.state must be a number for the type-detector media-player slot; PLAYBACKINFO
    // reports Play/Pause/Stop (Skip Fwd/Rev are the separate next/prev buttons below).
    spec: { kind: "code", codes: { Play: 0, Stop: 1, Pause: 2 }, labels: { 0: "Play", 1: "Stop", 2: "Pause" } },
    write: true,
    role: "media.state",
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
    role: "media.title",
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
    // media.mode.repeat is a number in the type-detector (off/one/all); code-mapped so it fills
    // the REPEAT slot and still reads/writes as labels.
    spec: { kind: "code", codes: { Off: 0, Single: 1, All: 2 }, labels: { 0: "Off", 1: "Single", 2: "All" } },
    write: true,
    role: "media.mode.repeat",
  },
  {
    func: "SHUFFLE",
    state: "shuffle",
    name: "Shuffle",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    // Boolean on/off shuffle → the type-detector media-player role (fills the SHUFFLE slot).
    role: "media.mode.shuffle",
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
    wireEncode: () => "Skip Fwd",
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
    wireEncode: () => "Skip Rev",
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
  // Scene recall (write-only): a settable 1..12 that triggers a scene via @MAIN:SCENE=Scene N
  // (ynca lib zone.py: `_put("SCENE", f"Scene {id}")`). Gated on SCENE1NAME so it appears only
  // where the device reports scenes; kept out of the device→state map (writeOnly) so it never
  // overwrites scene.name1's SCENE1NAME mapping.
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
    wireEncode: value => `Scene ${value}`,
  });
  // Global functions each carry their own subunit.
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
      func: `INPNAME${upper}`,
    });
  }
  entries.push(...fnEntries(DAB_FUNCS, "DAB", "tuner."));
  for (const source of PLAYER_SOURCES) {
    for (const fn of PLAYER_FUNCS) {
      entries.push({
        id: `player.${source.channel}.${fn.state}`,
        name: fn.name,
        spec: fn.spec,
        write: fn.write,
        role: fn.role,
        subunit: source.subunit,
        func: fn.func,
        readFunc: fn.readFunc,
        readAliases: fn.readAliases,
        wireEncode: fn.wireEncode,
        writeOnly: fn.writeOnly,
      });
    }
  }
  return entries;
}

/**
 * The built device-agnostic catalog — a module constant, since the catalog is static:
 * built once for the process, shared by the controller's lookup maps and
 * {@link yncaObjectsFor} (which previously rebuilt all ~450 entries per connect).
 */
export const YNCA_CATALOG: readonly YncaEntry[] = buildYncaCatalog();

/**
 * The AVAIL-probe GETs for the two-pass init sweep: one `@<SUBUNIT>:AVAIL=?` per
 * catalogued subunit. SYS is excluded — it does not answer AVAIL (python-ynca:
 * "It also does not respond to AVAIL=? so it will not end up in _available_subunits")
 * and is always swept. Verified against all 10 device fixtures: every non-SYS subunit
 * that reports functions also answers AVAIL, so probing first loses nothing.
 *
 * @param entries the catalog entries
 * @returns the AVAIL probes, one per non-SYS subunit
 */
export function availGets(entries: readonly YncaEntry[]): Array<{ subunit: string; func: string }> {
  const seen = new Set<string>();
  const gets: Array<{ subunit: string; func: string }> = [];
  for (const entry of entries) {
    if (entry.subunit !== "SYS" && !seen.has(entry.subunit)) {
      seen.add(entry.subunit);
      gets.push({ subunit: entry.subunit, func: "AVAIL" });
    }
  }
  return gets;
}

/**
 * The init-sweep GETs: each (subunit, func) once.
 *
 * @param entries the catalog entries
 * @returns the subunit/function pairs to query
 */
export function sweepGets(entries: readonly YncaEntry[]): Array<{ subunit: string; func: string }> {
  const seen = new Set<string>();
  const gets: Array<{ subunit: string; func: string }> = [];
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

/**
 * Map `subunit:func` → catalog entry, for turning a device line into a state.
 *
 * @param entries the catalog entries
 * @returns the lookup map keyed `SUBUNIT:FUNC`
 */
export function funcToEntry(entries: readonly YncaEntry[]): Map<string, YncaEntry> {
  return new Map(
    entries
      .filter(entry => !entry.writeOnly)
      .flatMap(entry => readFuncsOf(entry).map(func => [`${entry.subunit}:${func}`, entry] as const)),
  );
}

/**
 * Map state id → catalog entry, for turning a user write into a YNCA command.
 *
 * @param entries the catalog entries
 * @returns the lookup map keyed by state id
 */
export function idToEntry(entries: readonly YncaEntry[]): Map<string, YncaEntry> {
  return new Map(entries.map(entry => [entry.id, entry]));
}

/**
 * Build the object tree for a device from its reported capabilities: keep only
 * the catalog entries the device answered for, then turn them into objects.
 *
 * @param capabilities the device's YNCA capabilities from the init sweep
 * @param catalog the (possibly group-filtered) catalog to build from
 * @returns the object definitions to create
 */
export function yncaObjectsFor(
  capabilities: YncaCapabilities,
  catalog: readonly YncaEntry[] = YNCA_CATALOG,
): ObjectDef[] {
  const present = catalog.filter(entry =>
    readFuncsOf(entry).some(func => capabilities.subunits[entry.subunit]?.[func] !== undefined),
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
  const wire = entry.wireEncode
    ? entry.wireEncode(value as boolean | number | string)
    : encode(entry.spec, value as boolean | number | string);
  return { subunit: entry.subunit, func: entry.func, value: wire };
}
