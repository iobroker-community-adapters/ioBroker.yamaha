import { catalogToObjects } from "../catalog/build-objects";
import type { CatalogEntry, ObjectDef } from "../catalog/types";
import { decode, encode, type ValueSpec } from "../catalog/value-coerce";
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
  /** The YNCA function name (PWR, VOL, …). */
  func: string;
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
const AMP_FUNCS: Array<{ func: string; state: string; name: string; spec: ValueSpec; write: boolean; role: string }> = [
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
];

const BAND_STATES = selfMap(["AM", "FM"]);

/** The zones the catalog maps: MAIN flat, ZONE2-4 each under their own prefix. */
const ZONES: Array<{ subunit: string; prefix: string }> = [
  { subunit: "MAIN", prefix: "" },
  { subunit: "ZONE2", prefix: "zone2." },
  { subunit: "ZONE3", prefix: "zone3." },
  { subunit: "ZONE4", prefix: "zone4." },
];

/** Global (non-zone) functions: one subunit each. State id carries its own channel. */
const GLOBAL_FUNCS: Array<{
  subunit: string;
  func: string;
  state: string;
  name: string;
  spec: ValueSpec;
  write: boolean;
  role: string;
}> = [
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
];

const PLAYBACK_STATES = selfMap(["Play", "Pause", "Stop"]);
const REPEAT_STATES = selfMap(["Off", "Single", "All"]);

/** Network/media player sources — each a subunit, mapped under its own channel. */
const PLAYER_SOURCES: Array<{ subunit: string; channel: string }> = [
  { subunit: "NETRADIO", channel: "netRadio" },
  { subunit: "SERVER", channel: "server" },
  { subunit: "USB", channel: "usb" },
  { subunit: "SPOTIFY", channel: "spotify" },
];

/** The playback functions shared by every player source (the __init__ mixin in the lib). */
const PLAYER_FUNCS: Array<{
  func: string;
  state: string;
  name: string;
  spec: ValueSpec;
  write: boolean;
  role: string;
}> = [
  {
    func: "PLAYBACK",
    state: "playback",
    name: "Playback",
    spec: { kind: "enum", states: PLAYBACK_STATES },
    write: true,
    role: "media.state",
  },
  { func: "ARTIST", state: "artist", name: "Artist", spec: { kind: "text" }, write: false, role: "media.artist" },
  { func: "ALBUM", state: "album", name: "Album", spec: { kind: "text" }, write: false, role: "media.album" },
  { func: "SONG", state: "track", name: "Track", spec: { kind: "text" }, write: false, role: "media.title" },
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
 * Build the device-agnostic YNCA catalog: every amplifier function for MAIN and
 * each zone, the global SYS/TUN functions, and the playback functions for each
 * network/media player source. The per-device mapper keeps only the entries the
 * device reports.
 *
 * @returns the catalog entries
 */
export function buildYncaCatalog(): YncaEntry[] {
  const entries: YncaEntry[] = [];
  for (const zone of ZONES) {
    for (const fn of AMP_FUNCS) {
      entries.push({
        id: `${zone.prefix}${fn.state}`,
        name: fn.name,
        spec: fn.spec,
        write: fn.write,
        role: fn.role,
        subunit: zone.subunit,
        func: fn.func,
      });
    }
  }
  for (const fn of GLOBAL_FUNCS) {
    entries.push({
      id: fn.state,
      name: fn.name,
      spec: fn.spec,
      write: fn.write,
      role: fn.role,
      subunit: fn.subunit,
      func: fn.func,
    });
  }
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
    const key = `${entry.subunit}:${entry.func}`;
    if (!seen.has(key)) {
      seen.add(key);
      gets.push({ subunit: entry.subunit, func: entry.func });
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
  return new Map(entries.map(entry => [`${entry.subunit}:${entry.func}`, entry]));
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
  const present = buildYncaCatalog().filter(entry => capabilities.subunits[entry.subunit]?.[entry.func] !== undefined);
  return catalogToObjects(present);
}

/**
 * Turn a device line into a typed state update via the func map, or undefined
 * when the function is not catalogued or the value is not decodable.
 *
 * @param message the decoded YNCA message (subunit/func/value)
 * @param message.subunit
 * @param message.func
 * @param message.value
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
  return { subunit: entry.subunit, func: entry.func, value: encode(entry.spec, value as boolean | number | string) };
}
