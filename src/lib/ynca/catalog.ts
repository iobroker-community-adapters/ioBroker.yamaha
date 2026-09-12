import { catalogToObjects, type StatesResolver } from "../catalog/build-objects";
import type { CatalogEntry, ObjectDef } from "../catalog/types";
import { decode, encode, formatWireNumber, isWritableValue, type ValueSpec } from "../catalog/value-coerce";
import type { StateValue } from "../types";
import type { YncaCapabilities } from "./capability";
import type { I18nKey } from "../i18n";
import { parsePlayTime } from "../catalog/play-time";

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
  /**
   * Optional wire-value pre-transform applied before {@link decode} — for a reported
   * value whose sentinel form does not fit the spec (PRESET answers "No Preset" for
   * an empty slot, which becomes 0 on the number state).
   */
  wireDecode?: (wire: string) => string;
  /**
   * The state is DERIVED from another entry's value, not mapped from the wire. It carries
   * the same read function only so the object is created exactly where the source state is
   * — the device→state map skips it, because two entries cannot share one wire function
   * there (the map is keyed `SUBUNIT:FUNC`, so the second would displace the first).
   * The controller writes it alongside its source; the readable playback times use this.
   */
  derived?: boolean;
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

/**
 * The physical inputs a Yamaha may have — the union of the 21 official YNCA command lists
 * (2010–2015), the XML `Input_Sel_Item` lists of the 2015–2020 generation and the reference
 * protocols. YNCA proves NONE of them absent (a jack answers no function), so every one stays
 * a candidate on every device; wherever XML is live its declared `Input_Sel_Item` list replaces
 * this one on the dropdown (coordinator, #619), and an XML `Name/Input` entry may ADD one — that
 * block is the renameable set, never the complete one (the RX-V6A names 20 of its 27 inputs).
 */
export const PHYSICAL_INPUTS: readonly string[] = [
  "AUDIO",
  "AUDIO1",
  "AUDIO2",
  "AUDIO3",
  "AUDIO4",
  "AUDIO5",
  "AUX",
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
  "MULTI CH",
  "NET",
  "OPTICAL1",
  "OPTICAL2",
  "PHONO",
  "TV",
  "USB/NET",
  "V-AUX",
];

/**
 * The source inputs, each with the YNCA subunit(s) that prove it present and the XML
 * `Feature_Existence` flag(s) that prove it absent. `subunits: []` = not judgeable over YNCA
 * (the 2015+ streaming services have no YNCA subunit); `xmlFlags: []` = not judgeable over XML.
 * The tuner input has three subunits: the AM/FM `TUN`, the `DAB` of the European DAB+ models and
 * the `HDRADIO` of the US models (7 of the 21 official lists, 4 of them WITHOUT `TUN`).
 * A source is absent when its subunits were ALL probed and none answered, or when ALL its XML
 * flags are 0 — the tuner input covers three flags, and `Tuner=0` next to `DAB=1` keeps TUNER
 * (RX-V6A, measured). Wire values and subunit names follow ynca-python's `Input` enum.
 */
export const SOURCE_INPUTS: ReadonlyArray<{ value: string; subunits: readonly string[]; xmlFlags: readonly string[] }> =
  [
    { value: "AirPlay", subunits: ["AIRPLAY"], xmlFlags: ["AirPlay"] },
    { value: "Alexa", subunits: [], xmlFlags: ["Alexa"] },
    { value: "Amazon Music", subunits: [], xmlFlags: ["Amazon_Music"] },
    { value: "Bluetooth", subunits: ["BT"], xmlFlags: ["Bluetooth"] },
    { value: "Deezer", subunits: ["DEEZER"], xmlFlags: ["Deezer"] },
    { value: "JUKE", subunits: [], xmlFlags: ["JUKE"] },
    { value: "MusicCast Link", subunits: ["MCLINK"], xmlFlags: ["MusicCast_Link"] },
    { value: "NET RADIO", subunits: ["NETRADIO"], xmlFlags: ["NET_RADIO"] },
    { value: "Napster", subunits: ["NAPSTER"], xmlFlags: ["Napster"] },
    { value: "PC", subunits: ["PC"], xmlFlags: [] },
    { value: "Pandora", subunits: ["PANDORA"], xmlFlags: ["Pandora"] },
    { value: "Qobuz", subunits: [], xmlFlags: ["Qobuz"] },
    { value: "Rhapsody", subunits: ["RHAP"], xmlFlags: ["Rhapsody"] },
    { value: "SERVER", subunits: ["SERVER"], xmlFlags: ["SERVER"] },
    { value: "SIRIUS", subunits: ["SIRIUS"], xmlFlags: [] },
    { value: "SIRIUS InternetRadio", subunits: ["SIRIUSIR"], xmlFlags: [] },
    { value: "SiriusXM", subunits: ["SIRIUSXM"], xmlFlags: ["SiriusXM"] },
    { value: "Spotify", subunits: ["SPOTIFY"], xmlFlags: ["Spotify"] },
    { value: "TIDAL", subunits: ["TIDAL"], xmlFlags: ["TIDAL"] },
    { value: "TUNER", subunits: ["TUN", "DAB", "HDRADIO"], xmlFlags: ["Tuner", "DAB", "HD_Radio"] },
    { value: "UAW", subunits: [], xmlFlags: [] },
    { value: "USB", subunits: ["USB"], xmlFlags: ["USB"] },
    { value: "iPod", subunits: ["IPOD"], xmlFlags: [] },
    { value: "iPod (USB)", subunits: ["IPODUSB"], xmlFlags: ["iPod_USB"] },
  ];

/** Inputs that exist on zones only (a zone follows the main zone's source). */
export const ZONE_ONLY_INPUTS: readonly string[] = ["Main Zone Sync"];

/** What the controller learned about one device's inputs — the evidence {@link deviceInputStates} judges by. */
export interface InputEvidence {
  /** Subunits that answered AVAIL (or any function) this run. */
  present: ReadonlySet<string>;
  /** Subunits the AVAIL probe ASKED — empty when the device ignored the probe (blind sweep). */
  probed: ReadonlySet<string>;
  /** XML `Feature_Existence` flags, when remembered (System>Config). */
  xmlFeatures?: Record<string, boolean>;
  /** XML `Name/Input` entries, when remembered — presence only. */
  xmlInputNames?: Record<string, string>;
}

/**
 * The classic (YNCA) spelling of an XML input key: `HDMI_1` → `HDMI1`, `AUDIO_3` → `AUDIO3`,
 * `AV_1` → `AV1`, `V_AUX` → `V-AUX`, `MusicCast_Link` → `MusicCast Link`, `NET_RADIO` →
 * `NET RADIO` — measured against the three System>Config captures.
 *
 * @param key the XML input key
 * @returns the classic spelling
 */
export function classicInputName(key: string): string {
  if (key.replace(/_/g, "") === "VAUX") {
    return "V-AUX";
  }
  return key.replace(/_(\d)/g, "$1").replace(/_/g, " ");
}

/**
 * The input dropdown of one zone, from PROOF: physical inputs always (YNCA cannot judge them),
 * a source only while nothing proved it absent, the zone-only inputs on zones, and whatever the
 * zone reports right now. Silence is not proof — a device that ignored the AVAIL probe keeps
 * every source; a snapshot from another firmware is never handed in here (the controller checks
 * the identity first). (#619: the union of every input any Yamaha ever had stood on every zone.)
 *
 * @param evidence what the controller learned about this device
 * @param zone the zone key (`main`, `zone2`, …)
 * @param current the value the zone reports right now, if known
 * @returns the states map for the zone's input dropdown
 */
export function deviceInputStates(evidence: InputEvidence, zone: string, current?: string): Record<string, string> {
  const values: string[] = [...PHYSICAL_INPUTS];
  for (const source of SOURCE_INPUTS) {
    const judgedByYnca =
      source.subunits.length > 0 &&
      source.subunits.every(subunit => evidence.probed.has(subunit)) &&
      !source.subunits.some(subunit => evidence.present.has(subunit));
    const flags = source.xmlFlags
      .map(flag => evidence.xmlFeatures?.[flag])
      .filter((flag): flag is boolean => flag !== undefined);
    const judgedByXml =
      source.xmlFlags.length > 0 && flags.length === source.xmlFlags.length && flags.every(flag => !flag);
    if (!judgedByYnca && !judgedByXml) {
      values.push(source.value);
    }
  }
  if (zone !== "main") {
    values.push(...ZONE_ONLY_INPUTS);
  }
  for (const key of Object.keys(evidence.xmlInputNames ?? {})) {
    const classic = classicInputName(key);
    if (!values.includes(classic)) {
      // An XML input name ADDS an input the tables did not know; it never removes one.
      values.push(classic);
    }
  }
  if (current && !values.includes(current)) {
    values.push(current);
  }
  return selfMap(values);
}

/**
 * The device-agnostic input list of the static catalog: every physical input, every source and
 * the zone-only inputs — what a device shows before any evidence narrows it. The controller
 * resolves the real list per zone through {@link deviceInputStates}.
 */
const INPUT_STATES = deviceInputStates({ present: new Set(), probed: new Set() }, "zone");

/**
 * What any evidence ever showed a ZONE answering — the functions the sweep asks a zone for
 * (2.7.0). ZONE2 and ZONE3 share one class, ZONE4 is the small one (power, input, sleep, its
 * name and its scene names — no volume, no mute on any model, list or capture). Sources: the 21
 * official YNCA lists 2010–2015, 16 ynca-python protocol logs 2010–2020, the adapter's own device
 * captures and 27 MusicCast `getFeatures` declarations, generated into
 * `__fixtures__/zone-function-evidence.json` by `Ressourcen/yamaha/device-data-2026-09-08/
 * build-zone-evidence.py`; the catalog test holds this table to that file in both directions.
 *
 * The table decides what is ASKED, never what is CREATED: a function that answers anyway (a
 * BASIC bundle, a push, a later sweep) becomes an object like any other. The blind sweep of a
 * device that ignores the AVAIL probe is not filtered at all — it runs exactly on the devices
 * this evidence does not cover, and its promise is "loses speed, never features".
 */
const ZONE_FUNCTIONS: Readonly<Record<"zone23" | "zone4", ReadonlySet<string>>> = {
  zone23: new Set([
    "PWR",
    "VOL",
    "MUTE",
    "INP",
    "SLEEP",
    "MAXVOL",
    "INITVOLLVL",
    "INITVOLMODE",
    "ZONENAME",
    "ENHANCER",
    "EXBASS",
    "TONEBASS",
    "TONETREBLE",
    "TONEMODE",
    "CONTENTSDISP",
    "BALANCE",
    "VOLFIXVAR",
    "BASS",
    "TREBLE",
    "SCENE1NAME",
    "SCENE2NAME",
    "SCENE3NAME",
    "SCENE4NAME",
  ]),
  zone4: new Set(["PWR", "INP", "SLEEP", "ZONENAME", "SCENE1NAME", "SCENE2NAME", "SCENE3NAME", "SCENE4NAME"]),
};

/**
 * Whether the sweep asks a subunit for a function. MAIN and every non-zone subunit: always; a
 * zone: only what {@link ZONE_FUNCTIONS} carries for its class.
 *
 * @param subunit the subunit
 * @param func the function
 * @returns true when the GET is worth sending
 */
export function zoneFunctionAsked(subunit: string, func: string): boolean {
  if (subunit === "ZONE2" || subunit === "ZONE3") {
    return ZONE_FUNCTIONS.zone23.has(func);
  }
  if (subunit === "ZONE4") {
    return ZONE_FUNCTIONS.zone4.has(func);
  }
  return true;
}

/**
 * The SYS function families a device has as a whole or not at all: the second trigger socket
 * (`TRIG2*`, 43 functions) and the second speaker pattern (`SPPATTERN2*`, 22) exist on 9 of the
 * 21 official lists, always together with their head. The head is asked in the first pass; the
 * members follow in a second pass only when the head answered — claim with proof at family level
 * (one GET decides up to 43). A head answering `@RESTRICTED` (standby) keeps the family unasked
 * this connect; the next awake sweep or refresh asks it again.
 */
export const SYS_FUNCTION_FAMILIES: ReadonlyArray<{ head: string; prefix: string }> = [
  { head: "TRIG2ZONE", prefix: "TRIG2" },
  { head: "SPPATTERN2AMP", prefix: "SPPATTERN2" },
];

/**
 * The family a SYS function is a MEMBER of (not its head), if any.
 *
 * @param func the SYS function
 * @returns the family, or undefined for a head or a function outside the families
 */
export function sysFamilyMemberOf(func: string): { head: string; prefix: string } | undefined {
  return SYS_FUNCTION_FAMILIES.find(family => func.startsWith(family.prefix) && func !== family.head);
}

/**
 * The sound programs of the classic (YNCA) generation — the union of the 21 official command
 * lists 2010–2015 (26 names; the entry class carries 19 of them, the Aventage class all 26) plus
 * `5ch Stereo`, which the entry class declares in its `desc.xml`. A device's own additions
 * (`Enhanced`, `All-Ch Stereo`, `9ch Stereo` and the 2015+ MusicCast generation's names) reach
 * the dropdown as OBSERVED values — every program the device ever reported is offered — or as
 * the declared `sound_program_list` through the MusicCast dictionary. The fifteen names the
 * list used to carry beyond these (`Disco`, `Pavilion`, `Hall in USA A`, …) were never on any
 * official list; a device that has one reports it and gets it that way.
 */
const SOUNDPRG_STATES = selfMap([
  "2ch Stereo",
  "5ch Stereo",
  "7ch Stereo",
  "9ch Stereo",
  "Action Game",
  "Adventure",
  "Cellar Club",
  "Chamber",
  "Church in Freiburg",
  "Church in Royaumont",
  "Drama",
  "Hall in Amsterdam",
  "Hall in Munich",
  "Hall in Vienna",
  "Mono Movie",
  "Music Video",
  "Recital/Opera",
  "Roleplaying Game",
  "Sci-Fi",
  "Spectacle",
  "Sports",
  "Standard",
  "Surround Decoder",
  "The Bottom Line",
  "The Roxy Theatre",
  "Village Vanguard",
  "Warehouse Loft",
]);

const SLEEP_STATES = selfMap(["Off", "30 min", "60 min", "90 min", "120 min"]);
const TVAUDIN_STATES = selfMap(["AV1", "AV2", "AV3", "AV4", "AV5", "AV6", "AUDIO1", "AUDIO2"]);
// `OUT` is the single-output spelling of the RX-A700/RX-V671 class (official lists), the
// OUT1/OUT2 pair the two-output class.
const HDMIOUT_STATES = selfMap(["Off", "OUT", "OUT1", "OUT2", "OUT1 + 2"]);
const ADAPTIVEDRC_STATES = selfMap(["Off", "Auto"]);
/**
 * The surround decoders identical on all 21 official command lists 2010–2015 — the nine-value
 * core. `Auto`, `Dolby Surround`, `DTS Neural:X` and `AURO-3D` are 2015+ values (RX-A2070,
 * RX-V6A) that the device reports itself and reaches the dropdown as OBSERVED values; the
 * MusicCast generation declares its `surr_decoder_type_list` outright.
 */
const DECODER_STATES = selfMap([
  "Dolby PL",
  "Dolby PLII Movie",
  "Dolby PLII Music",
  "Dolby PLII Game",
  "Dolby PLIIx Movie",
  "Dolby PLIIx Music",
  "Dolby PLIIx Game",
  "DTS NEO:6 Cinema",
  "DTS NEO:6 Music",
]);

/** Amplifier functions shared by MAIN and each zone: state id + YNCA func + value spec. */
/** A per-function catalog definition, before its zone/subunit prefix and id are applied. */
interface FuncDef {
  func: string;
  state: string;
  nameKey: I18nKey;
  /** Explanation key — see {@link CatalogEntry.descKey}; absent means self-explanatory. */
  descKey?: I18nKey;
  spec: ValueSpec;
  write: boolean;
  role: string;
  /** Optional wire-value encoder overriding the generic encode (see {@link YncaEntry.wireEncode}). */
  wireEncode?: (value: boolean | number | string) => string;
  /** Optional wire-value pre-transform before decode (see {@link YncaEntry.wireDecode}). */
  wireDecode?: (wire: string) => string;
  /** The function the device reports under, when it differs (see {@link YncaEntry.readFunc}). */
  readFunc?: string;
  /** Write-only command, kept out of the device→state map (see {@link YncaEntry.writeOnly}). */
  writeOnly?: boolean;
  /** Values for the name key's `%s` placeholders (see {@link CatalogEntry.nameArgs}). */
  nameArgs?: Array<string | number>;
  /** Further functions the device answers this entry under (see {@link YncaEntry.readAliases}). */
  readAliases?: string[];
}

const AMP_FUNCS: FuncDef[] = [
  {
    func: "PWR",
    state: "power",
    nameKey: "power",
    spec: { kind: "onoff", on: "On", off: "Standby" },
    write: true,
    role: "switch.power",
  },
  {
    func: "VOL",
    state: "volume",
    nameKey: "volume",
    descKey: "descVolume",
    spec: { kind: "number", unit: "dB", min: -80.5, max: 16.5, step: 0.5, decimals: 1 },
    write: true,
    role: "level.volume",
  },
  {
    func: "MUTE",
    state: "mute",
    nameKey: "mute",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "media.mute",
  },
  {
    func: "INP",
    state: "input",
    nameKey: "input",
    spec: { kind: "enum", states: INPUT_STATES },
    write: true,
    role: "media.input",
  },
  {
    func: "SOUNDPRG",
    state: "soundProgram",
    nameKey: "soundProgram",
    descKey: "descSoundProgram",
    spec: { kind: "enum", states: SOUNDPRG_STATES },
    write: true,
    role: "state",
  },
  {
    func: "STRAIGHT",
    state: "sound.straight",
    nameKey: "straight",
    descKey: "descStraight",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "ENHANCER",
    state: "sound.enhancer",
    nameKey: "enhancer",
    descKey: "descEnhancer",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "PUREDIRMODE",
    state: "sound.pureDirect",
    nameKey: "pureDirect",
    descKey: "descPureDirect",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "SLEEP",
    state: "sleep",
    nameKey: "sleepTimer",
    descKey: "descSleepTimer",
    spec: { kind: "enum", states: SLEEP_STATES },
    write: true,
    role: "state",
  },
  {
    func: "SPBASS",
    state: "sound.bass",
    nameKey: "bass",
    descKey: "descBass",
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5, decimals: 1 },
    write: true,
    role: "level",
  },
  {
    func: "SPTREBLE",
    state: "sound.treble",
    nameKey: "treble",
    descKey: "descTreble",
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5, decimals: 1 },
    write: true,
    role: "level",
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
    descKey: "descBass",
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5, decimals: 1 },
    write: true,
    role: "level",
  },
  {
    func: "TONETREBLE",
    state: "sound.treble",
    nameKey: "treble",
    descKey: "descTreble",
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5, decimals: 1 },
    write: true,
    role: "level",
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
    role: "state",
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
    role: "value",
  },
  {
    func: "DTSDIALOGUECONTROL",
    state: "sound.dtsDialogueControl",
    nameKey: "dtsDialogueControl",
    descKey: "descDtsDialogueControl",
    spec: { kind: "number", decimals: 0 },
    write: false,
    role: "value",
  },
  {
    func: "CONTENTSDISP",
    state: "sound.contentsDisplay",
    nameKey: "contentsDisplay",
    descKey: "descContentsDisplay",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: false,
    role: "indicator",
  },
  {
    func: "HDMIOUT",
    state: "hdmi.output",
    nameKey: "hdmiOutput",
    descKey: "descHdmiOutput",
    spec: { kind: "enum", states: HDMIOUT_STATES },
    write: true,
    role: "state",
  },
  {
    func: "ADAPTIVEDRC",
    state: "sound.adaptiveDrc",
    nameKey: "adaptiveDRC",
    descKey: "descAdaptiveDRC",
    spec: { kind: "enum", states: ADAPTIVEDRC_STATES },
    write: true,
    role: "state",
  },
  {
    func: "SURROUNDAI",
    state: "sound.surroundAI",
    nameKey: "surroundAI",
    descKey: "descSurroundAI",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "DIRMODE",
    state: "sound.direct",
    nameKey: "direct",
    descKey: "descDirect",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "2CHDECODER",
    state: "sound.surroundDecoder",
    nameKey: "surroundDecoder",
    descKey: "descSurroundDecoder",
    spec: { kind: "enum", states: DECODER_STATES },
    write: true,
    role: "state",
  },
  {
    func: "HPBASS",
    state: "sound.headphoneBass",
    nameKey: "headphoneBass",
    descKey: "descHeadphoneBass",
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5, decimals: 1 },
    write: true,
    role: "level",
  },
  {
    func: "HPTREBLE",
    state: "sound.headphoneTreble",
    nameKey: "headphoneTreble",
    descKey: "descHeadphoneTreble",
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5, decimals: 1 },
    write: true,
    role: "level",
  },
  {
    func: "EXBASS",
    state: "sound.extraBass",
    nameKey: "extraBass",
    descKey: "descExtraBass",
    spec: { kind: "onoff", on: "Auto", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "3DCINEMA",
    state: "sound.cinemaDsp3d",
    nameKey: "cinemaDSP3D",
    descKey: "descCinemaDSP3D",
    spec: { kind: "onoff", on: "Auto", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "INITVOLMODE",
    state: "advanced.initialVolume.mode",
    nameKey: "initialVolumeMode",
    descKey: "descInitialVolumeMode",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "INITVOLLVL",
    state: "advanced.initialVolume.level",
    nameKey: "initialVolumeLevel",
    descKey: "descInitialVolumeLevel",
    spec: { kind: "number", unit: "dB", min: -80.5, max: 16.5, step: 0.5, decimals: 1 },
    write: true,
    role: "level.volume",
  },
  {
    func: "MAXVOL",
    state: "advanced.maxVolume",
    nameKey: "maximumVolume",
    descKey: "descMaximumVolume",
    // 5 dB grid with one mandatory decimal — except the literal ceiling 16.5, which is
    // valid despite being off-grid (the ynca-python MAXVOL special case).
    wireEncode: value => (Number(value) === 16.5 ? "16.5" : formatWireNumber(Number(value), 1, 5)),
    spec: { kind: "number", unit: "dB", min: -30, max: 16.5, step: 5 },
    write: true,
    role: "level.volume",
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
    role: "level",
  },
  {
    func: "LIPSYNCHDMIOUT2OFFSET",
    state: "hdmi.lipSyncOut2",
    nameKey: "lipSyncHDMIOUT2Offset",
    descKey: "descLipSyncHDMIOUT2Offset",
    spec: { kind: "number", unit: "ms", decimals: 0 },
    write: true,
    role: "level",
  },
  {
    func: "ZONENAME",
    state: "zoneName",
    nameKey: "zoneName",
    descKey: "descZoneName",
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
  // --- Setup surface of the 2010 generation (audit 2026-09-06): answered by real receivers in
  // the bundled protocols, no datapoint until now. Values from the official command list.
  {
    func: "SWFRTRIM",
    state: "sound.subwooferTrim",
    nameKey: "subwooferTrim",
    descKey: "descSubwooferTrim",
    // The wire form carries one decimal (`0.0`, `3.0` in the CX-A5100/RX-V583/RX-V673/TSR-7810
    // protocols). The BOUNDS are the ones this adapter's XML catalog already uses for the same
    // physical trim — the RX-V671 list does not carry the function, so nothing tighter is
    // documented; the number stays readable either way.
    spec: { kind: "number", unit: "dB", min: -6, max: 6, step: 0.5, decimals: 1 },
    write: true,
    role: "level",
  },
  {
    func: "YPAOVOL",
    state: "sound.ypaoVolume",
    nameKey: "ypaoVolume",
    descKey: "descYpaoVolume",
    spec: { kind: "onoff", on: "Auto", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "HDMIAUDOUTAMP",
    state: "hdmi.audioToAmp",
    nameKey: "hdmiAudioToAmplifier",
    descKey: "descHdmiAudioToAmplifier",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "HDMIAUDOUT1",
    state: "hdmi.audioToOut1",
    nameKey: "hdmiAudioToOutput1",
    descKey: "descHdmiAudioToOutput1",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "HDMIAUDOUT2",
    state: "hdmi.audioToOut2",
    nameKey: "hdmiAudioToOutput2",
    descKey: "descHdmiAudioToOutput2",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "HDMIRESOL",
    state: "hdmi.resolution",
    nameKey: "hdmiVideoResolution",
    descKey: "descHdmiVideoResolution",
    spec: { kind: "enum", states: selfMap(["Auto", "480p / 576p", "720p", "1080i", "1080p", "4K", "Through"]) },
    write: true,
    role: "state",
  },
  {
    func: "HDMIASPECT",
    state: "hdmi.aspect",
    nameKey: "hdmiVideoAspect",
    descKey: "descHdmiVideoAspect",
    spec: { kind: "enum", states: selfMap(["Through", "16:9 Normal", "Smart Zoom"]) },
    write: true,
    role: "state",
  },
  {
    func: "HDMIPROCESSING",
    state: "hdmi.videoProcessing",
    nameKey: "hdmiVideoProcessing",
    descKey: "descHdmiVideoProcessing",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "LIPSYNCMODE",
    state: "hdmi.lipSyncMode",
    nameKey: "lipSyncMode",
    descKey: "descLipSyncMode",
    spec: { kind: "enum", states: selfMap(["Auto", "Manual"]) },
    write: true,
    role: "state",
  },
  {
    func: "LIPSYNCANLGOUT",
    state: "hdmi.lipSyncAnalogOut",
    nameKey: "lipSyncAnalogOutput",
    descKey: "descLipSyncAnalogOutput",
    spec: { kind: "number", unit: "ms", min: 0, max: 250, step: 1, decimals: 0 },
    write: true,
    role: "level",
  },
  {
    func: "LIPSYNCHDMIOUT1MANUAL",
    state: "hdmi.lipSyncOut1Manual",
    nameKey: "lipSyncHdmiOutput1Manual",
    descKey: "descLipSyncHdmiOutput1Manual",
    spec: { kind: "number", unit: "ms", min: 0, max: 250, step: 1, decimals: 0 },
    write: true,
    role: "level",
  },
  {
    func: "LIPSYNCHDMIOUT2MANUAL",
    state: "hdmi.lipSyncOut2Manual",
    nameKey: "lipSyncHdmiOutput2Manual",
    descKey: "descLipSyncHdmiOutput2Manual",
    spec: { kind: "number", unit: "ms", min: 0, max: 250, step: 1, decimals: 0 },
    write: true,
    role: "level",
  },
  {
    func: "LIPSYNCSELINFO",
    state: "hdmi.lipSyncSource",
    nameKey: "lipSyncActiveOutput",
    descKey: "descLipSyncActiveOutput",
    spec: { kind: "enum", states: selfMap(["Analog", "HDMI1 Auto", "HDMI1 Manual", "HDMI2 Auto", "HDMI2 Manual"]) },
    write: false,
    role: "state",
  },
  {
    func: "LIPSYNCOFFSETINFO",
    state: "hdmi.lipSyncOffset",
    nameKey: "lipSyncOffsetReportedByDisplay",
    descKey: "descLipSyncOffsetReportedByDisplay",
    spec: { kind: "number", unit: "ms", min: 0, max: 250, step: 1, decimals: 0 },
    write: false,
    role: "value",
  },
  {
    func: "DECODERSEL",
    state: "sound.decoderSelect",
    nameKey: "decoderSelect",
    descKey: "descDecoderSelect",
    spec: { kind: "enum", states: selfMap(["Auto", "DTS", "Unavailable"]) },
    write: true,
    role: "state",
  },
  {
    func: "EXSURDECODER",
    state: "sound.extendedSurround",
    nameKey: "extendedSurround",
    descKey: "descExtendedSurround",
    spec: {
      kind: "enum",
      states: selfMap(["Off", "Auto", "Dolby PLIIx Movie", "Dolby PLIIx Music", "EX/ES"]),
    },
    write: true,
    role: "state",
  },
  {
    func: "TVAUDIN1",
    state: "advanced.tvAudioIn1",
    nameKey: "tvAudioReturnInput",
    descKey: "descTvAudioReturnInput",
    spec: { kind: "enum", states: TVAUDIN_STATES },
    write: true,
    role: "state",
  },
  // The second return input (11 of the 21 official lists: the models with two HDMI outputs).
  {
    func: "TVAUDIN2",
    state: "advanced.tvAudioIn2",
    nameKey: "tvAudioReturnInput2",
    descKey: "descTvAudioReturnInput2",
    spec: { kind: "enum", states: TVAUDIN_STATES },
    write: true,
    role: "state",
  },
  // Audio select (9 lists): which terminal's sound the current input uses. `Unavailable` is
  // GET-only and reaches the dropdown as an observed value.
  {
    func: "AUDSEL",
    state: "advanced.audioSelect",
    nameKey: "audioSelect",
    descKey: "descAudioSelect",
    spec: { kind: "enum", states: selfMap(["Auto", "HDMI", "Coax/Opt", "Analog"]) },
    write: true,
    role: "state",
  },
  // The A/B toggles belong with the other speaker settings (v2.0.0).
  {
    func: "SPEAKERA",
    state: "advanced.speakers.speakerA",
    nameKey: "speakerA",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "SPEAKERB",
    state: "advanced.speakers.speakerB",
    nameKey: "speakerB",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "PWRB",
    state: "multiroom.zoneB.power",
    nameKey: "zoneBPower",
    spec: { kind: "onoff", on: "On", off: "Standby" },
    write: true,
    role: "switch.power",
  },
  {
    func: "ZONEBAVAIL",
    state: "multiroom.zoneB.available",
    nameKey: "zoneBAvailability",
    descKey: "descZoneBAvailability",
    spec: { kind: "enum", states: ZONEB_AVAIL_STATES },
    write: false,
    role: "state",
  },
  {
    func: "ZONEBMUTE",
    state: "multiroom.zoneB.mute",
    nameKey: "zoneBMute",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "media.mute",
  },
  {
    func: "ZONEBVOL",
    state: "multiroom.zoneB.volume",
    nameKey: "zoneBVolume",
    spec: { kind: "number", unit: "dB", min: -80.5, max: 16.5, step: 0.5, decimals: 1 },
    write: true,
    role: "level.volume",
  },
  {
    func: "ZONEBNAME",
    state: "multiroom.zoneB.name",
    nameKey: "zoneBName",
    spec: { kind: "text" },
    write: true,
    role: "text",
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
    role: "state",
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

/**
 * Functions the official lists give the ZONES only, never MAIN: the pre-out level mode and the
 * channel balance (RX-A1010–A3020 class), the 2010 generation's plain tone dialect (`BASS`/
 * `TREBLE` on ZONE2/3 next to MAIN's SPBASS/SPTREBLE — -10…10 dB in 2 dB steps, first decimal
 * mandatory) and the four zone scenes (ZONE2–4, `Scene 1`…`Scene 4`, names SCENE1–4NAME).
 * Claim with proof keeps a zone without them clean.
 */
const ZONE_ONLY_FUNCS: FuncDef[] = [
  {
    func: "BALANCE",
    state: "sound.balance",
    nameKey: "channelBalance",
    descKey: "descChannelBalance",
    spec: { kind: "number", min: -20, max: 20, step: 1, decimals: 0 },
    write: true,
    role: "level",
  },
  {
    func: "VOLFIXVAR",
    state: "volumeOutput",
    nameKey: "volumeOutputMode",
    descKey: "descVolumeOutputMode",
    spec: { kind: "enum", states: selfMap(["Variable", "Fixed"]) },
    write: true,
    role: "state",
  },
  {
    func: "BASS",
    state: "sound.bass",
    nameKey: "bass",
    descKey: "descBass",
    spec: { kind: "number", unit: "dB", min: -10, max: 10, step: 2, decimals: 1 },
    write: true,
    role: "level",
  },
  {
    func: "TREBLE",
    state: "sound.treble",
    nameKey: "treble",
    descKey: "descTreble",
    spec: { kind: "number", unit: "dB", min: -10, max: 10, step: 2, decimals: 1 },
    write: true,
    role: "level",
  },
  {
    func: "SCENE",
    state: "scene.recall",
    nameKey: "recallScene",
    descKey: "descRecallScene",
    spec: { kind: "number", min: 1, max: 4, step: 1 },
    write: true,
    role: "level",
    readFunc: "SCENE1NAME",
    readAliases: ["SCENE2NAME", "SCENE3NAME", "SCENE4NAME"],
    writeOnly: true,
    wireEncode: value => `Scene ${Math.round(Number(value))}`,
  },
];

/** Global (non-zone) functions: one subunit each. State id carries its own channel. */
const GLOBAL_FUNCS: Array<FuncDef & { subunit: string }> = [
  {
    subunit: "SYS",
    func: "PARTY",
    state: "multiroom.party",
    nameKey: "partyModeAllZones",
    descKey: "descPartyModeAllZones",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    subunit: "TUN",
    func: "BAND",
    state: "tuner.band",
    nameKey: "band",
    spec: { kind: "enum", states: BAND_STATES },
    write: true,
    role: "state",
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
    wireDecode: wire => (wire === "No Preset" ? "0" : wire),
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
    wireEncode: () => "Up",
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
    wireEncode: () => "Down",
  },
  {
    subunit: "TUN",
    func: "RDSCLOCK",
    state: "tuner.rdsClock",
    nameKey: "rdsClockTime",
    descKey: "descRdsClockTime",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  {
    subunit: "TUN",
    func: "RDSTXTA",
    state: "tuner.rdsText",
    nameKey: "rdsText",
    descKey: "descRdsText",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  {
    subunit: "TUN",
    func: "RDSPRGSERVICE",
    state: "tuner.rdsService",
    nameKey: "rdsStation",
    descKey: "descRdsStation",
    spec: { kind: "text" },
    write: false,
    role: "text",
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
    role: "level",
  },
  {
    subunit: "TUN",
    func: "FMFREQ",
    state: "tuner.frequency",
    nameKey: "frequency",
    spec: { kind: "number", unit: "kHz", decimals: 0 },
    write: true,
    role: "level",
    wireDecode: wire => String(Math.round(Number.parseFloat(wire) * 1000)),
  },
  {
    subunit: "TUN",
    func: "RDSTXTB",
    state: "tuner.rdsTextB",
    nameKey: "rdsTextB",
    descKey: "descRdsTextB",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  {
    subunit: "TUN",
    func: "RDSPRGTYPE",
    state: "tuner.rdsProgramType",
    nameKey: "rdsProgramType",
    descKey: "descRdsProgramType",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  {
    subunit: "TUN",
    func: "SEARCHMODE",
    state: "tuner.searchMode",
    nameKey: "searchMode",
    descKey: "descSearchMode",
    spec: { kind: "enum", states: TUN_SEARCHMODE_STATES },
    write: true,
    role: "state",
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
    role: "state",
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
    role: "indicator",
  },
  {
    subunit: "TUN",
    func: "SIGSTEREOMONO",
    state: "tuner.stereo",
    nameKey: "stereoReception",
    descKey: "descStereoReception",
    spec: { kind: "onoff", on: "Assert", off: "Negate" },
    write: false,
    role: "indicator",
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
    wireEncode: value => (Number(value) === 0 ? "Auto" : String(Math.round(Number(value)))),
  },
];

const SPPATTERN_STATES = selfMap(["Pattern 1", "Pattern 2"]);
const SWFR_CNFG_STATES = selfMap(["None", "Use"]);

/**
 * SYS (system-wide) functions beyond party: model/version info, the system power
 * (all zones), the party mute, the HDMI-output toggles and the speaker patterns.
 * The 29 assignable input names are generated separately from {@link INPUT_NAME_KEYS}.
 */
const SYS_FUNCS: FuncDef[] = [
  // Device metadata lives under the info channel (like govee's info.model/info.firmware),
  // not in the system grab-bag. Renamed from system.model/system.version (audit F7).
  { func: "MODELNAME", state: "info.model", nameKey: "model", spec: { kind: "text" }, write: false, role: "text" },
  {
    func: "VERSION",
    state: "info.firmware",
    nameKey: "firmwareVersion",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  {
    func: "PWR",
    state: "multiroom.masterPower",
    nameKey: "masterPowerAllZones",
    descKey: "descMasterPowerAllZones",
    spec: { kind: "onoff", on: "On", off: "Standby" },
    write: true,
    role: "switch.power",
  },
  {
    func: "PARTYMUTE",
    state: "multiroom.partyMute",
    nameKey: "partyMuteAllZones",
    descKey: "descPartyMuteAllZones",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "media.mute",
  },
  {
    func: "HDMIOUT1",
    state: "hdmi.out1",
    nameKey: "hdmiOUT1",
    descKey: "descHdmiOUT1",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "HDMIOUT2",
    state: "hdmi.out2",
    nameKey: "hdmiOUT2",
    descKey: "descHdmiOUT2",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "HDMIOUT3",
    state: "hdmi.out3",
    nameKey: "hdmiOUT3",
    descKey: "descHdmiOUT3",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "SPPATTERN",
    state: "advanced.speakers.pattern",
    nameKey: "speakerPattern",
    descKey: "descSpeakerPattern",
    spec: { kind: "enum", states: SPPATTERN_STATES },
    write: true,
    role: "state",
  },
  // Amp-assign for speaker pattern 1 (official RX-V671 list: PUT+GET with the three
  // documented values; the RX-V6A answers "Basic").
  // --- Setup surface of the 2010 generation and later (audit 2026-09-06). Measured against the
  // 15 bundled device protocols: these functions are ANSWERED by real receivers and had no
  // datapoint at all. Values come from the official command list
  // (`Ressourcen/yamaha/ynca-command-list-rx-v671.txt`), never from a guess.
  {
    func: "MEMGRD",
    state: "advanced.memoryGuard",
    nameKey: "memoryGuard",
    descKey: "descMemoryGuard",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "VIDANLGCONV",
    state: "advanced.analogVideoConversion",
    nameKey: "analogVideoConversion",
    descKey: "descAnalogVideoConversion",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "DMCCONTROL",
    state: "advanced.dmcControl",
    nameKey: "dmcControl",
    descKey: "descDmcControl",
    spec: { kind: "onoff", on: "Enable", off: "Disable" },
    write: true,
    role: "switch",
  },
  // Party-mode volume (17 of the 21 official lists; PUT-only Up/Down): two keys, offered
  // wherever the party mode itself is — its PARTY answer is the proof.
  {
    func: "PARTYVOL",
    state: "multiroom.partyVolumeUp",
    nameKey: "partyVolumeUp",
    descKey: "descPartyVolumeUp",
    spec: { kind: "button" },
    write: true,
    role: "button",
    readFunc: "PARTY",
    writeOnly: true,
    wireEncode: () => "Up",
  },
  {
    func: "PARTYVOL",
    state: "multiroom.partyVolumeDown",
    nameKey: "partyVolumeDown",
    descKey: "descPartyVolumeDown",
    spec: { kind: "button" },
    write: true,
    role: "button",
    readFunc: "PARTY",
    writeOnly: true,
    wireEncode: () => "Down",
  },
  // HDMI video mode and the lip-sync block (9 lists, the 2012 Aventage class).
  {
    func: "HDMIVIDEOMODE",
    state: "hdmi.videoMode",
    nameKey: "hdmiVideoMode",
    descKey: "descHdmiVideoMode",
    spec: { kind: "enum", states: selfMap(["Direct", "Processing"]) },
    write: true,
    role: "state",
  },
  {
    func: "LIPSYNCMODE",
    state: "hdmi.lipSyncMode",
    nameKey: "lipSyncMode",
    descKey: "descLipSyncMode",
    spec: { kind: "enum", states: selfMap(["Manual", "Auto"]) },
    write: true,
    role: "state",
  },
  {
    func: "LIPSYNCTOTALDELAY",
    state: "hdmi.lipSyncTotalDelay",
    nameKey: "lipSyncTotalDelay",
    descKey: "descLipSyncTotalDelay",
    spec: { kind: "number", unit: "ms", min: 0, max: 500, step: 1, decimals: 0 },
    write: true,
    role: "level",
  },
  {
    func: "LIPSYNCTOTALDELAYINFO",
    state: "hdmi.lipSyncTvOffset",
    nameKey: "lipSyncTvOffset",
    descKey: "descLipSyncTvOffset",
    spec: { kind: "number", unit: "ms", min: 0, max: 500, decimals: 0 },
    write: false,
    role: "value",
  },
  {
    func: "LIPSYNCSELINFO",
    state: "hdmi.lipSyncOutput",
    nameKey: "lipSyncOutput",
    descKey: "descLipSyncOutput",
    spec: {
      kind: "enum",
      states: selfMap(["Disable", "Analog", "HDMI1 Auto", "HDMI1 Manual", "HDMI2 Auto", "HDMI2 Manual"]),
    },
    write: false,
    role: "state",
  },
  // RS-232C standby (5 lists), the sales region and the tuner step it fixes (6 lists — GET
  // only, plain codes), the update notice switch (RX-A850).
  {
    func: "RS232CSTANDBY",
    state: "advanced.rs232Standby",
    nameKey: "rs232Standby",
    descKey: "descRs232Standby",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  {
    func: "DEST",
    state: "info.region",
    nameKey: "region",
    descKey: "descRegion",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  {
    func: "FREQSTEP",
    state: "tuner.frequencyStep",
    nameKey: "tunerFrequencyStep",
    descKey: "descTunerFrequencyStep",
    spec: { kind: "enum", states: selfMap(["FM50/AM9", "FM100/AM9", "FM100/AM10", "FM200/AM10"]) },
    write: false,
    role: "state",
  },
  {
    func: "UPDTNOTICEMSG",
    state: "advanced.updateNotice",
    nameKey: "updateNotice",
    descKey: "descUpdateNotice",
    spec: { kind: "onoff", on: "On", off: "Off" },
    write: true,
    role: "switch",
  },
  // REMOTECODE (PUT-only IR code, every list) has no datapoint: nothing readable proves it on
  // a device, and a blind claim is what #615 taught us not to make.
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
    role: "value",
  },
];

// The 29 assignable input names (SYS INPNAME<KEY>, read-only text). The wire
// function is INPNAME + the upper-cased key (audio1 → INPNAMEAUDIO1).
const INPUT_NAME_KEYS = [
  "audio1",
  "aux",
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
  "mclink",
  "multich",
  "netradio",
  "phono",
  "server",
  "tuner",
  "usb",
  "vaux",
  "bt",
];

/**
 * How an input key is written in the datapoint's NAME. The two that are not simply the
 * upper-cased key are spelled the way the device itself lists them in the input dropdown
 * ({@link INPUT_STATES}), so the name and the selectable value read alike.
 */
/**
 * The inputs the 21 official command lists give a `TRIG1INP<INPUT>` / `TRIG2INP<INPUT>` function
 * (their union, 2010–2015). Not the same set as {@link INPUT_NAME_KEYS}: a trigger can follow a
 * NETWORK source that carries no renameable input name. Claim with proof keeps a device's tree
 * to the inputs it answers for.
 */
const TRIGGER_INPUT_KEYS = [
  "airplay",
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
  "bt",
  "dock",
  "hdmi1",
  "hdmi2",
  "hdmi3",
  "hdmi4",
  "hdmi5",
  "hdmi6",
  "hdmi7",
  "ipod",
  "ipodusb",
  "multich",
  "napster",
  "net",
  "netradio",
  "pandora",
  "pc",
  "phono",
  "rhapsody",
  "server",
  "sirius",
  "siriusir",
  "siriusxm",
  "spotify",
  "tuner",
  "uaw",
  "usb",
  "vaux",
];

const INPUT_NAME_LABELS: Readonly<Record<string, string>> = {
  vaux: "V-AUX",
  multich: "MULTI CH",
  mclink: "MusicCast Link",
  netradio: "NET RADIO",
  bt: "Bluetooth",
  airplay: "AirPlay",
  ipod: "iPod",
  ipodusb: "iPod (USB)",
  napster: "Napster",
  pandora: "Pandora",
  rhapsody: "Rhapsody",
  siriusir: "SIRIUS InternetRadio",
  siriusxm: "SiriusXM",
  spotify: "Spotify",
};

/**
 * The SOURCE input a per-input SYS function (`TRIG<n>INP<KEY>`, `INPNAME<KEY>`) belongs to, in the
 * spelling of {@link SOURCE_INPUTS}. Undefined for a physical input (YNCA cannot judge those, so
 * they are always asked) and for any other function.
 *
 * @param func the SYS function
 * @returns the source value, or undefined
 */
export function perInputSource(func: string): string | undefined {
  const match = /^(?:TRIG[12]INP|INPNAME)([A-Z0-9]+)$/.exec(func);
  if (!match) {
    return undefined;
  }
  const key = match[1].toLowerCase();
  if (!TRIGGER_INPUT_KEYS.includes(key) && !INPUT_NAME_KEYS.includes(key)) {
    return undefined;
  }
  const label = INPUT_NAME_LABELS[key] ?? key.toUpperCase();
  return SOURCE_INPUTS.some(source => source.value === label) ? label : undefined;
}

/**
 * Plan a targeted sweep's paced GET lists from the evidence at hand: drop what the zone table
 * never showed on that zone, drop the per-input functions of a source the evidence proved absent
 * (the same rule the input dropdown follows — silence is no proof), and split the SYS family
 * members off into a second pass that runs only for the families whose head answered.
 *
 * @param gets the candidate GETs (already reduced to present subunits and bundle leftovers)
 * @param evidence what this connect learned about the device's inputs
 * @returns the first pass and the family members for the second pass
 */
export function planSweep(
  gets: ReadonlyArray<{ subunit: string; func: string }>,
  evidence: InputEvidence,
): { first: Array<{ subunit: string; func: string }>; families: Array<{ subunit: string; func: string }> } {
  const inputs = deviceInputStates(evidence, "main");
  const first: Array<{ subunit: string; func: string }> = [];
  const families: Array<{ subunit: string; func: string }> = [];
  for (const get of gets) {
    if (!zoneFunctionAsked(get.subunit, get.func)) {
      continue;
    }
    if (get.subunit === "SYS") {
      const source = perInputSource(get.func);
      if (source !== undefined && !(source in inputs)) {
        continue;
      }
      if (sysFamilyMemberOf(get.func)) {
        families.push(get);
        continue;
      }
    }
    first.push(get);
  }
  return { first, families };
}

/**
 * The trigger-output functions, once per socket (official lists: trigger 2 "Parameters are the
 * same as `@SYS:TRIG1…`"; 9 of the 21 lists have a second socket).
 *
 * @param n the trigger socket (1 or 2)
 * @returns the three per-socket functions
 */
function triggerFuncs(n: 1 | 2): FuncDef[] {
  return [
    {
      func: `TRIG${n}TYPE`,
      state: `advanced.trigger${n}Type`,
      nameKey: "triggerOutType",
      descKey: "descTriggerOutType",
      nameArgs: [n],
      spec: { kind: "enum", states: selfMap(["Manual", "Power", "Zone and Input"]) },
      write: true,
      role: "state",
    },
    {
      func: `TRIG${n}ZONE`,
      state: `advanced.trigger${n}Zone`,
      nameKey: "triggerOutZone",
      descKey: "descTriggerOutZone",
      nameArgs: [n],
      // The static maximum; the controller derives the real list from the zones the device has.
      spec: { kind: "enum", states: selfMap(["Main Zone", "Zone2", "Zone3", "Zone4", "All"]) },
      write: true,
      role: "state",
    },
    {
      func: `TRIG${n}MANUAL`,
      state: `advanced.trigger${n}Manual`,
      nameKey: "triggerOutManualLevel",
      descKey: "descTriggerOutManualLevel",
      nameArgs: [n],
      spec: { kind: "enum", states: selfMap(["Lo", "Hi"]) },
      write: true,
      role: "state",
    },
  ];
}

const CROSSOVER_STATES = selfMap([
  "40 Hz",
  "60 Hz",
  "80 Hz",
  "90 Hz",
  "100 Hz",
  "110 Hz",
  "120 Hz",
  "160 Hz",
  "200 Hz",
]);

/**
 * The speaker-pattern functions, identical for pattern 1 and 2 (official lists: pattern 2
 * "Parameters are the same as `@SYS:SPPATTERN1…`"). `suffix` follows `SPPATTERN<n>`, `state`
 * follows `advanced.speakers.pattern<n>`. The 2012 Aventage class adds a crossover per speaker
 * group, the rear presence pair, the second subwoofer's phase and the subwoofer layout; the
 * RX-A850 (2015) the front-presence size, crossover and layout and the surround layout. Values
 * from the lists, never guessed.
 */
const SPEAKER_PATTERN_FUNCS: ReadonlyArray<{
  suffix: string;
  state: string;
  nameKey: I18nKey;
  descKey: I18nKey;
  spec: ValueSpec;
  role?: string;
}> = [
  {
    suffix: "FRNTCNFG",
    state: "Front",
    nameKey: "speakerPatternFront",
    descKey: "descSpeakerPatternFront",
    spec: { kind: "enum", states: selfMap(["Small", "Large"]) },
  },
  {
    suffix: "CENTCNFG",
    state: "Center",
    nameKey: "speakerPatternCenter",
    descKey: "descSpeakerPatternCenter",
    spec: { kind: "enum", states: selfMap(["None", "Small", "Large"]) },
  },
  {
    suffix: "SURCNFG",
    state: "Surround",
    nameKey: "speakerPatternSurround",
    descKey: "descSpeakerPatternSurround",
    spec: { kind: "enum", states: selfMap(["None", "Small", "Large"]) },
  },
  {
    suffix: "SURBCNFG",
    state: "SurroundBack",
    nameKey: "speakerPatternSurroundBack",
    descKey: "descSpeakerPatternSurroundBack",
    spec: { kind: "enum", states: selfMap(["None", "Small x1", "Large x1", "Small x2", "Large x2"]) },
  },
  {
    suffix: "FRNTPRES",
    state: "FrontPresence",
    nameKey: "speakerPatternFrontPresence",
    descKey: "descSpeakerPatternFrontPresence",
    spec: { kind: "enum", states: selfMap(["None", "Use"]) },
  },
  {
    suffix: "REARPRES",
    state: "RearPresence",
    nameKey: "speakerPatternRearPresence",
    descKey: "descSpeakerPatternRearPresence",
    spec: { kind: "enum", states: selfMap(["None", "Use"]) },
  },
  {
    suffix: "EXBASS",
    state: "ExtraBass",
    nameKey: "speakerPatternExtraBass",
    descKey: "descSpeakerPatternExtraBass",
    spec: { kind: "onoff", on: "On", off: "Off" },
    role: "switch",
  },
  {
    suffix: "SWFR1CNFG",
    state: "Swfr1",
    nameKey: "speakerPatternSubwoofer1",
    descKey: "descSpeakerPatternSubwoofer1",
    spec: { kind: "enum", states: SWFR_CNFG_STATES },
  },
  {
    suffix: "SWFR2CNFG",
    state: "Swfr2",
    nameKey: "speakerPatternSubwoofer2",
    descKey: "descSpeakerPatternSubwoofer2",
    spec: { kind: "enum", states: SWFR_CNFG_STATES },
  },
  {
    suffix: "SWFR1PHASE",
    state: "Subwoofer1Phase",
    nameKey: "speakerPatternSubwoofer1Phase",
    descKey: "descSpeakerPatternSubwoofer1Phase",
    spec: { kind: "enum", states: selfMap(["Normal", "Reverse"]) },
  },
  {
    suffix: "SWFR2PHASE",
    state: "Subwoofer2Phase",
    nameKey: "speakerPatternSubwoofer2Phase",
    descKey: "descSpeakerPatternSubwoofer2Phase",
    spec: { kind: "enum", states: selfMap(["Normal", "Reverse"]) },
  },
  {
    suffix: "SWFRCRSOVR",
    state: "SubwooferCrossover",
    nameKey: "speakerPatternSubwooferCrossover",
    descKey: "descSpeakerPatternSubwooferCrossover",
    spec: { kind: "enum", states: CROSSOVER_STATES },
  },
  {
    suffix: "SWFRLAYOUT",
    state: "SubwooferLayout",
    nameKey: "speakerPatternSubwooferLayout",
    descKey: "descSpeakerPatternSubwooferLayout",
    spec: { kind: "enum", states: selfMap(["Left & Right", "Front & Rear", "Monaural x2"]) },
  },
  // No candidates: the official lists carry 3 to 14 model-specific strings ("7ch +FPR",
  // "5ch BI-AMP", "Basic", …) with no common core. The dropdown holds what this device reported.
  {
    suffix: "AMP",
    state: "Amp",
    nameKey: "speakerPatternAmpAssign",
    descKey: "descSpeakerPatternAmpAssign",
    spec: { kind: "enum", states: {} },
  },
  {
    suffix: "FRNTCRSOVR",
    state: "FrontCrossover",
    nameKey: "speakerPatternFrontCrossover",
    descKey: "descSpeakerPatternFrontCrossover",
    spec: { kind: "enum", states: CROSSOVER_STATES },
  },
  {
    suffix: "CENTCRSOVR",
    state: "CenterCrossover",
    nameKey: "speakerPatternCenterCrossover",
    descKey: "descSpeakerPatternCenterCrossover",
    spec: { kind: "enum", states: CROSSOVER_STATES },
  },
  {
    suffix: "SURCRSOVR",
    state: "SurroundCrossover",
    nameKey: "speakerPatternSurroundCrossover",
    descKey: "descSpeakerPatternSurroundCrossover",
    spec: { kind: "enum", states: CROSSOVER_STATES },
  },
  {
    suffix: "SURBCRSOVR",
    state: "SurroundBackCrossover",
    nameKey: "speakerPatternSurroundBackCrossover",
    descKey: "descSpeakerPatternSurroundBackCrossover",
    spec: { kind: "enum", states: CROSSOVER_STATES },
  },
  {
    suffix: "FPLAYOUT",
    state: "FrontPresenceLayout",
    nameKey: "speakerPatternFrontPresenceLayout",
    descKey: "descSpeakerPatternFrontPresenceLayout",
    spec: { kind: "enum", states: selfMap(["Front", "Overhead", "Dolby"]) },
  },
  {
    suffix: "FPRESCNFG",
    state: "FrontPresenceConfig",
    nameKey: "speakerPatternFrontPresenceConfig",
    descKey: "descSpeakerPatternFrontPresenceConfig",
    spec: { kind: "enum", states: selfMap(["None", "Small", "Large"]) },
  },
  {
    suffix: "FPRESCRSOVR",
    state: "FrontPresenceCrossover",
    nameKey: "speakerPatternFrontPresenceCrossover",
    descKey: "descSpeakerPatternFrontPresenceCrossover",
    spec: { kind: "enum", states: CROSSOVER_STATES },
  },
  {
    suffix: "SURLAYOUT",
    state: "SurroundLayout",
    nameKey: "speakerPatternSurroundLayout",
    descKey: "descSpeakerPatternSurroundLayout",
    spec: { kind: "enum", states: selfMap(["Rear", "Front"]) },
  },
];

/**
 * The speaker-pattern entries of one pattern.
 *
 * @param pattern the pattern (1 or 2)
 * @returns the entries, ids `advanced.speakers.pattern<n><State>`
 */
function speakerPatternEntries(pattern: 1 | 2): YncaEntry[] {
  return SPEAKER_PATTERN_FUNCS.map(fn => ({
    id: `advanced.speakers.pattern${pattern}${fn.state}`,
    nameKey: fn.nameKey,
    descKey: fn.descKey,
    nameArgs: [pattern],
    spec: fn.spec,
    write: true,
    role: fn.role ?? "state",
    subunit: "SYS",
    func: `SPPATTERN${pattern}${fn.suffix}`,
  }));
}

/**
 * DAB tuner functions (the `@DAB` subunit on DAB+-capable receivers). Mapped under
 * a `dab` channel of their own so DAB/FM labels never collide with the AM/FM `@TUN`
 * tuner's `tuner.*` states. The subunit also carries an FM frequency (FMFREQ).
 */
const DAB_FUNCS: FuncDef[] = [
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
    role: "state",
  },
  {
    func: "DABCHLABEL",
    state: "dab.channelLabel",
    nameKey: "dabChannel",
    descKey: "descDabChannel",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  {
    func: "DABDLSLABEL",
    state: "dab.dls",
    nameKey: "dabDLSText",
    descKey: "descDabDLSText",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  {
    func: "DABENSEMBLELABEL",
    state: "dab.ensembleLabel",
    nameKey: "dabEnsemble",
    descKey: "descDabEnsemble",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  {
    func: "DABSERVICELABEL",
    state: "dab.serviceLabel",
    nameKey: "dabService",
    descKey: "descDabService",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  {
    func: "DABPRESET",
    state: "preset",
    nameKey: "presetRecallByNumber",
    descKey: "descPresetRecallByNumber",
    spec: { kind: "number", min: 0, max: 40, step: 1, decimals: 0 },
    write: true,
    role: "level",
    wireDecode: wire => (wire === "No Preset" ? "0" : wire),
  },
  {
    func: "DABPRGTYPE",
    state: "dab.programType",
    nameKey: "dabProgramType",
    descKey: "descDabProgramType",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  {
    func: "FMPRESET",
    state: "preset",
    nameKey: "presetRecallByNumber",
    descKey: "descPresetRecallByNumber",
    spec: { kind: "number", min: 0, max: 40, step: 1, decimals: 0 },
    write: true,
    role: "level",
    wireDecode: wire => (wire === "No Preset" ? "0" : wire),
  },
  {
    func: "FMRDSPRGSERVICE",
    state: "rdsService",
    nameKey: "rdsStation",
    descKey: "descRdsStation",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  {
    func: "FMRDSPRGTYPE",
    state: "rdsProgramType",
    nameKey: "rdsProgramType",
    descKey: "descRdsProgramType",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  {
    func: "FMRDSTXT",
    state: "rdsText",
    nameKey: "rdsText",
    descKey: "descRdsText",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  {
    func: "FMSEARCHMODE",
    state: "searchMode",
    nameKey: "searchMode",
    descKey: "descSearchMode",
    spec: { kind: "enum", states: TUN_SEARCHMODE_STATES },
    write: true,
    role: "state",
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
    wireDecode: wire => String(Math.round(Number.parseFloat(wire) * 1000)),
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
    role: "state",
  },
  {
    func: "DABBITRATE",
    state: "dab.bitRate",
    nameKey: "bitRate",
    descKey: "descBitRate",
    spec: { kind: "number", decimals: 0 },
    write: false,
    role: "value",
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
    wireDecode: wire => {
      const trimmed = wire.trim();
      return /[A-Za-z1-9]/.test(trimmed) ? trimmed : "";
    },
  },
  {
    func: "DABOFFAIR",
    state: "dab.offAir",
    nameKey: "offAir",
    descKey: "descOffAir",
    spec: { kind: "onoff", on: "Assert", off: "Negate" },
    write: false,
    role: "indicator",
  },
  {
    func: "FMRDSCLOCK",
    state: "rdsClock",
    nameKey: "rdsClock",
    descKey: "descRdsClock",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  {
    func: "FMSIGSTEREOMONO",
    state: "stereo",
    nameKey: "stereoReception",
    descKey: "descStereoReception",
    spec: { kind: "onoff", on: "Assert", off: "Negate" },
    write: false,
    role: "indicator",
  },
  {
    func: "FMTUNED",
    state: "tuned",
    nameKey: "tunedToAStation",
    descKey: "descTunedToAStation",
    spec: { kind: "onoff", on: "Assert", off: "Negate" },
    write: false,
    role: "indicator",
  },
];

/**
 * The HD Radio tuner of the US models (`@HDRADIO`, 7 of the 21 official lists 2010–2012, four of
 * them without `TUN` — those receivers had NO tuner in the adapter before 2026-09-09). Like DAB,
 * its AM/FM half lands on the flat `tuner.*` ids (band, frequency, presets, search mode, tuned,
 * stereo); what is HD Radio's own lives under `tuner.hdRadio`. Values from the lists.
 */
const HDRADIO_FUNCS: FuncDef[] = [
  {
    func: "BAND",
    state: "band",
    nameKey: "band",
    spec: { kind: "enum", states: BAND_STATES },
    write: true,
    role: "state",
  },
  {
    func: "AMFREQ",
    state: "frequency",
    nameKey: "frequency",
    spec: { kind: "number", unit: "kHz", decimals: 0 },
    write: true,
    role: "level",
  },
  {
    func: "FMFREQ",
    state: "frequency",
    nameKey: "frequency",
    spec: { kind: "number", unit: "kHz", decimals: 0 },
    write: true,
    role: "level",
    wireDecode: wire => String(Math.round(Number.parseFloat(wire) * 1000)),
  },
  {
    func: "PRESET",
    state: "preset",
    nameKey: "presetRecallByNumber",
    descKey: "descPresetRecallByNumber",
    spec: { kind: "number", min: 0, max: 40, step: 1, decimals: 0 },
    write: true,
    role: "level",
    wireDecode: wire => (wire === "No Preset" ? "0" : wire),
  },
  {
    func: "PRESET",
    state: "presetUp",
    nameKey: "nextPreset",
    spec: { kind: "button" },
    write: true,
    role: "button",
    readFunc: "PRESET",
    writeOnly: true,
    wireEncode: () => "Up",
  },
  {
    func: "PRESET",
    state: "presetDown",
    nameKey: "previousPreset",
    spec: { kind: "button" },
    write: true,
    role: "button",
    readFunc: "PRESET",
    writeOnly: true,
    wireEncode: () => "Down",
  },
  {
    func: "MEM",
    state: "presetSave",
    nameKey: "saveToPreset0FirstFreeSlot",
    descKey: "descSaveToPreset0FirstFreeSlot",
    spec: { kind: "number", min: 0, max: 40, step: 1 },
    write: true,
    role: "level",
    readFunc: "PRESET",
    writeOnly: true,
    wireEncode: value => (Number(value) === 0 ? "Auto" : String(Math.round(Number(value)))),
  },
  {
    func: "SEARCHMODE",
    state: "searchMode",
    nameKey: "searchMode",
    descKey: "descSearchMode",
    spec: { kind: "enum", states: TUN_SEARCHMODE_STATES },
    write: true,
    role: "state",
  },
  {
    func: "TUNED",
    state: "tuned",
    nameKey: "tunedToAStation",
    descKey: "descTunedToAStation",
    spec: { kind: "onoff", on: "Assert", off: "Negate" },
    write: false,
    role: "indicator",
  },
  {
    func: "SIGSTEREOMONO",
    state: "stereo",
    nameKey: "stereoReception",
    descKey: "descStereoReception",
    spec: { kind: "onoff", on: "Assert", off: "Negate" },
    write: false,
    role: "indicator",
  },
  {
    func: "AUDIOMODE",
    state: "hdRadio.audioMode",
    nameKey: "hdRadioAudioMode",
    descKey: "descHdRadioAudioMode",
    spec: { kind: "enum", states: selfMap(["Auto", "Mono"]) },
    write: true,
    role: "state",
  },
  // PRGSEL selects and reports the programme; PRGNUM reports the same thing (GET only) — one
  // datapoint, both answers feed it.
  {
    func: "PRGSEL",
    state: "hdRadio.program",
    nameKey: "hdRadioProgram",
    descKey: "descHdRadioProgram",
    spec: { kind: "enum", states: selfMap(["---", "HD1", "HD2", "HD3", "HD4", "HD5", "HD6", "HD7", "HD8"]) },
    write: true,
    role: "state",
    readAliases: ["PRGNUM"],
  },
  // The programme type: PRGTYPE on the 2010 lists, CATEGORY on the 2012 lists — same text.
  {
    func: "PRGTYPE",
    state: "hdRadio.programType",
    nameKey: "hdRadioProgramType",
    descKey: "descHdRadioProgramType",
    spec: { kind: "text" },
    write: false,
    role: "text",
    readAliases: ["CATEGORY"],
  },
  {
    func: "HDSIGINFO",
    state: "hdRadio.digitalSignal",
    nameKey: "hdRadioDigitalSignal",
    descKey: "descHdRadioDigitalSignal",
    spec: { kind: "onoff", on: "Assert", off: "Negate" },
    write: false,
    role: "indicator",
  },
  ...Array.from({ length: 8 }, (_, i): FuncDef => {
    const n = i + 1;
    return {
      func: `AVAILPRG${n}`,
      state: `hdRadio.program${n}Available`,
      nameKey: "hdRadioProgramAvailable",
      descKey: "descHdRadioProgramAvailable",
      nameArgs: [n],
      spec: { kind: "onoff", on: "Available", off: "Unavailable" },
      write: false,
      role: "indicator",
    };
  }),
  {
    func: "TAGINFO",
    state: "hdRadio.tagAvailable",
    nameKey: "hdRadioTagAvailable",
    descKey: "descHdRadioTagAvailable",
    spec: { kind: "onoff", on: "Available", off: "Unavailable" },
    write: false,
    role: "indicator",
  },
  {
    func: "TAGSET",
    state: "hdRadio.tagSave",
    nameKey: "hdRadioTagSave",
    descKey: "descHdRadioTagSave",
    spec: { kind: "button" },
    write: true,
    role: "button",
    readFunc: "TAGINFO",
    writeOnly: true,
    wireEncode: () => "Add",
  },
  {
    func: "STATION",
    state: "hdRadio.station",
    nameKey: "station",
    descKey: "descHdRadioMetadata",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  {
    func: "ARTIST",
    state: "hdRadio.artist",
    nameKey: "artist",
    descKey: "descHdRadioMetadata",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  {
    func: "SONG",
    state: "hdRadio.track",
    nameKey: "track",
    descKey: "descHdRadioMetadata",
    spec: { kind: "text" },
    write: false,
    role: "text",
  },
  {
    func: "ALBUM",
    state: "hdRadio.album",
    nameKey: "album",
    descKey: "descHdRadioMetadata",
    spec: { kind: "text" },
    write: false,
    role: "text",
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
  { subunit: "SIRIUSIR", channel: "siriusInternetRadio" },
  { subunit: "SIRIUSXM", channel: "siriusXm" },
  { subunit: "AIRPLAY", channel: "airplay" },
  { subunit: "BT", channel: "bluetooth" },
  { subunit: "PC", channel: "pc" },
  { subunit: "MCLINK", channel: "musicCastLink" },
  { subunit: "IPOD", channel: "ipod" },
  { subunit: "IPODUSB", channel: "ipodUsb" },
];

/**
 * The player-source subunits with a PRESET recall: the preset mixin in ynca-python's
 * `subunits/*.py` (NETRADIO/NAPSTER/PANDORA/PC/RHAP/SIRIUS/USB), the official 2010–2011 lists
 * (SIRIUSIR) and the RX-A850 list of 2015 (AIRPLAY, BT, SPOTIFY, SERVER, SIRIUSXM).
 */
const PRESET_SUBUNITS = [
  "NETRADIO",
  "NAPSTER",
  "PANDORA",
  "PC",
  "RHAP",
  "SIRIUS",
  "SIRIUSIR",
  "SIRIUSXM",
  "USB",
  "AIRPLAY",
  "BT",
  "SPOTIFY",
  "SERVER",
];

/**
 * The player-source subunits with a preset STORE command (`@<SUB>:MEM` — official RX-V671
 * list NETRADIO/NAPSTER/PC/USB, the 2010–2011 lists SIRIUSIR/RHAP, the RX-A850 list AIRPLAY/BT/
 * SPOTIFY/SERVER/PANDORA/SIRIUSXM). A slot number stores the current station/item there, 0
 * stores to the first free slot ("Auto").
 */
const MEM_SUBUNITS = [
  "NETRADIO",
  "NAPSTER",
  "PC",
  "USB",
  "RHAP",
  "SIRIUSIR",
  "SIRIUSXM",
  "AIRPLAY",
  "BT",
  "SPOTIFY",
  "SERVER",
  "PANDORA",
];

/** The playback functions shared by every player source (the __init__ mixin in the lib). */
const PLAYER_FUNCS: Array<{
  func: string;
  readFunc?: string;
  readAliases?: string[];
  state: string;
  nameKey: I18nKey;
  /** Explanation key — see {@link CatalogEntry.descKey}; absent means self-explanatory. */
  descKey?: I18nKey;
  spec: ValueSpec;
  write: boolean;
  role: string;
  /** Fixed wire value for an action button (e.g. Skip Fwd), overriding the spec's encode. */
  wireEncode?: (value: boolean | number | string) => string;
  /** Wire-value pre-transform before decode (see {@link YncaEntry.wireDecode}). */
  wireDecode?: (wire: string) => string;
  /** Keep out of the device→state map (a write-only action, never read back). */
  writeOnly?: boolean;
  /** Written by the controller from another state's value (see {@link YncaEntry.derived}). */
  derived?: boolean;
}> = [
  {
    func: "PLAYBACK",
    readFunc: "PLAYBACKINFO",
    state: "playback",
    nameKey: "playback",
    // media.state must be a number for the type-detector media-player slot; PLAYBACKINFO
    // reports Play/Pause/Stop (Skip Fwd/Rev are the separate next/prev buttons below).
    spec: { kind: "code", codes: { Play: 0, Stop: 1, Pause: 2 }, labels: { 0: "Play", 1: "Stop", 2: "Pause" } },
    write: true,
    role: "media.state",
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
    role: "media.title",
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
    wireDecode: wire => String(parsePlayTime(wire) ?? ""),
  },
  {
    func: "TOTALTIME",
    state: "totalTimeText",
    nameKey: "totalTimeReadable",
    descKey: "descTotalTimeReadable",
    spec: { kind: "text" },
    write: false,
    role: "media.duration.text",
    derived: true,
  },
  {
    func: "ELAPSEDTIME",
    state: "elapsedTime",
    nameKey: "elapsedTime",
    descKey: "descElapsedTime",
    spec: { kind: "number", unit: "s", decimals: 0 },
    write: false,
    role: "media.elapsed",
    wireDecode: wire => String(parsePlayTime(wire) ?? ""),
  },
  {
    func: "ELAPSEDTIME",
    state: "elapsedTimeText",
    nameKey: "elapsedTimeReadable",
    descKey: "descElapsedTimeReadable",
    spec: { kind: "text" },
    write: false,
    role: "media.elapsed.text",
    derived: true,
  },
  {
    func: "REPEAT",
    state: "repeat",
    nameKey: "repeat",
    // media.mode.repeat is a number in the type-detector (off/one/all); code-mapped so it fills
    // the REPEAT slot and still reads/writes as labels.
    spec: { kind: "code", codes: { Off: 0, Single: 1, All: 2 }, labels: { 0: "Off", 1: "Single", 2: "All" } },
    write: true,
    role: "media.mode.repeat",
  },
  {
    func: "SHUFFLE",
    state: "shuffle",
    nameKey: "shuffle",
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
    nameKey: "next",
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
    nameKey: "previous",
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
    writeOnly: fn.writeOnly,
    ...(fn.nameArgs ? { nameArgs: fn.nameArgs } : {}),
    ...(fn.readAliases ? { readAliases: fn.readAliases } : {}),
  }));
}

/**
 * The one-GET-answers-many functions of the official lists, for the subunits a device has: a
 * zone's BASIC (15–25 amplifier functions) and SCENENAME (every scene name), the tuner's SIGINFO
 * and RDSINFO, a player's METAINFO (artist, album, song, station …). Everything a bundle answers
 * is proof and is not asked again individually; what it lacks is still asked, so a subunit
 * without the bundle (`@UNDEFINED` carries no subunit) loses nothing. Never asked for an absent
 * subunit.
 *
 * @param present the subunits that answered the AVAIL probe
 * @returns the bundle GETs, one request list
 */
export function bundleGets(present: ReadonlySet<string>): Array<{ subunit: string; func: string }> {
  const gets: Array<{ subunit: string; func: string }> = [];
  for (const zone of ZONES) {
    if (present.has(zone.subunit)) {
      gets.push({ subunit: zone.subunit, func: "BASIC" }, { subunit: zone.subunit, func: "SCENENAME" });
    }
  }
  if (present.has("TUN")) {
    gets.push({ subunit: "TUN", func: "SIGINFO" }, { subunit: "TUN", func: "RDSINFO" });
  }
  for (const subunit of ["HDRADIO", "SIRIUS"]) {
    if (present.has(subunit)) {
      gets.push({ subunit, func: "SIGINFO" });
    }
  }
  for (const source of PLAYER_SOURCES) {
    if (present.has(source.subunit)) {
      gets.push({ subunit: source.subunit, func: "METAINFO" });
    }
  }
  if (present.has("HDRADIO")) {
    gets.push({ subunit: "HDRADIO", func: "METAINFO" });
  }
  return gets;
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
    if (zone.subunit !== "MAIN") {
      entries.push(...fnEntries(ZONE_ONLY_FUNCS, zone.subunit, zone.prefix));
    }
  }
  // MAIN-only functions (Zone B sub-zone, speaker toggles).
  entries.push(...fnEntries(MAIN_ONLY_FUNCS, "MAIN"));
  // Scene recall (write-only): a settable 1..12 that triggers a scene via @MAIN:SCENE=Scene N
  // (ynca lib zone.py: `_put("SCENE", f"Scene {id}")`). Gated on the scene NAMES so it appears
  // only where the device reports scenes; ALL twelve name functions ride along as read aliases,
  // so the sweep still asks them — the controller turns the answers into the recall dropdown's
  // title labels and the one `scene.list` state (v2.0.0: no per-name datapoints any more).
  // Kept out of the device→state map (writeOnly), so a name answer never writes the state.
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
    wireEncode: value => `Scene ${Math.round(Number(value))}`,
  });
  // Global functions each carry their own subunit.
  for (const fn of GLOBAL_FUNCS) {
    entries.push(...fnEntries([fn], fn.subunit));
  }
  entries.push(...fnEntries(SYS_FUNCS, "SYS"));
  for (const pattern of [1, 2] as const) {
    entries.push(...speakerPatternEntries(pattern));
  }
  // Trigger-out 1 and 2: mode, zone, manual level, and the level per input (official lists
  // `@SYS:TRIG<n>INP<INPUT>`, Lo/Hi). Answered by the 2010 generation and unmapped until the
  // 2026-09-06 audit: the adapter carried the manual trigger level but not the per-input
  // assignment that decides WHEN the trigger fires; the second socket followed on 2026-09-09.
  for (const n of [1, 2] as const) {
    entries.push(...fnEntries(triggerFuncs(n), "SYS"));
    for (const key of TRIGGER_INPUT_KEYS) {
      entries.push({
        id: `advanced.trigger${n}Inputs.${key}`,
        nameKey: "triggerOutForInput",
        descKey: "descTriggerOutForInput",
        nameArgs: [n, INPUT_NAME_LABELS[key] ?? key.toUpperCase()],
        spec: { kind: "enum", states: selfMap(["Lo", "Hi"]) },
        write: true,
        role: "state",
        subunit: "SYS",
        func: `TRIG${n}INP${key.toUpperCase()}`,
      });
    }
  }
  for (const key of INPUT_NAME_KEYS) {
    const upper = key.toUpperCase();
    entries.push({
      id: `advanced.inputNames.${key}`,
      // Each of the 23 carries the input it names — they all read "Input names" before,
      // the folder's own label, so the object tree showed the folder and 23 children with
      // one and the same text and only the id told them apart.
      nameKey: "inputName",
      descKey: "descInputName",
      nameArgs: [INPUT_NAME_LABELS[key] ?? upper],
      spec: { kind: "text" },
      write: false,
      role: "text",
      subunit: "SYS",
      func: `INPNAME${upper}`,
    });
  }
  entries.push(...fnEntries(DAB_FUNCS, "DAB", "tuner."));
  // After DAB and TUN on purpose: on a receiver with TUN and HDRADIO the per-device write map
  // (last entry per id wins) hands the shared tuner ids to the HD-capable subunit.
  entries.push(...fnEntries(HDRADIO_FUNCS, "HDRADIO", "tuner."));
  for (const source of PLAYER_SOURCES) {
    // v2.0.0 player unification: every source's playback functions land on the ONE
    // flat player block — the controller routes reads and writes by which source
    // each zone is listening to (INPUT → subunit). Only genuinely source-own states
    // below (preset, presetSave, bookmark) keep their per-source paths.
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
        derived: fn.derived,
      });
    }
    // Favourite recall (#613): PRESET is writable on the sources whose spec subunit
    // carries the preset mixin (ynca-python; NETRADIO/USB/PC/…, not Spotify & co).
    // Write-only — these sources do not answer a PRESET read (spec: only TUN/SIRIUS
    // do) — and gated on PLAYBACKINFO like the transport buttons, so the datapoint
    // appears exactly where the source exists.
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
        writeOnly: true,
      });
    }
    // Favourite STORE (#613 companion): save the current station/item to a preset
    // slot from ioBroker instead of at the device.
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
        wireEncode: value => (Number(value) === 0 ? "Auto" : String(Math.round(Number(value)))),
      });
    }
  }
  // iPod control mode (@IPOD:MODE / @IPODUSB:MODE, official list: Normal/Extended). Source-own,
  // so it lives in the source folder — the v2.0.0 cut removed those folders because nothing but
  // the shared playback block was left in them; this puts genuine content back (audit 2026-09-06).
  for (const source of ["ipod", "ipodUsb"] as const) {
    entries.push({
      id: `player.${source}.mode`,
      nameKey: "ipodControlMode",
      descKey: "descIpodControlMode",
      spec: { kind: "enum", states: selfMap(["Normal", "Extended"]) },
      write: true,
      role: "state",
      subunit: source === "ipod" ? "IPOD" : "IPODUSB",
      func: "MODE",
    });
  }
  // The SIRIUS satellite tuner's own surface (6 of the 21 official lists, 2010–2011 US models):
  // channel selection and number, category stepping, search mode, antenna level, category and
  // composer names, parental lock. 255 on the channel = no adapter / no station (the list).
  entries.push(
    {
      id: "player.sirius.channel",
      nameKey: "siriusChannel",
      descKey: "descSiriusChannel",
      spec: { kind: "number", min: 0, max: 255, step: 1, decimals: 0 },
      write: true,
      role: "level",
      subunit: "SIRIUS",
      func: "CHSEL",
    },
    {
      id: "player.sirius.channelNumber",
      nameKey: "siriusChannelNumber",
      descKey: "descSiriusChannelNumber",
      spec: { kind: "number", min: 0, max: 255, decimals: 0 },
      write: false,
      role: "value",
      subunit: "SIRIUS",
      func: "CHNUM",
    },
    {
      id: "player.sirius.categoryUp",
      nameKey: "siriusCategoryUp",
      descKey: "descSiriusCategoryUp",
      spec: { kind: "button" },
      write: true,
      role: "button",
      subunit: "SIRIUS",
      func: "CATSEL",
      readFunc: "CATNAME",
      writeOnly: true,
      wireEncode: () => "Up",
    },
    {
      id: "player.sirius.categoryDown",
      nameKey: "siriusCategoryDown",
      descKey: "descSiriusCategoryDown",
      spec: { kind: "button" },
      write: true,
      role: "button",
      subunit: "SIRIUS",
      func: "CATSEL",
      readFunc: "CATNAME",
      writeOnly: true,
      wireEncode: () => "Down",
    },
    {
      id: "player.sirius.searchMode",
      nameKey: "siriusSearchMode",
      descKey: "descSiriusSearchMode",
      spec: { kind: "enum", states: selfMap(["All Ch", "Category", "Preset"]) },
      write: true,
      role: "state",
      subunit: "SIRIUS",
      func: "SEARCHMODE",
    },
    {
      id: "player.sirius.antennaLevel",
      nameKey: "siriusAntennaLevel",
      descKey: "descSiriusAntennaLevel",
      spec: { kind: "enum", states: selfMap(["No Signal", "Weak", "Good", "Excellent"]) },
      write: false,
      role: "state",
      subunit: "SIRIUS",
      func: "ANTLVL",
    },
    {
      id: "player.sirius.categoryName",
      nameKey: "siriusCategoryName",
      descKey: "descSiriusCategoryName",
      spec: { kind: "text" },
      write: false,
      role: "text",
      subunit: "SIRIUS",
      func: "CATNAME",
    },
    {
      id: "player.sirius.composer",
      nameKey: "composer",
      descKey: "descComposer",
      spec: { kind: "text" },
      write: false,
      role: "text",
      subunit: "SIRIUS",
      func: "COMPOSER",
    },
    {
      id: "player.sirius.parentalLock",
      nameKey: "siriusParentalLock",
      descKey: "descSiriusParentalLock",
      spec: { kind: "onoff", on: "Locked", off: "Unlocked" },
      write: false,
      role: "indicator",
      subunit: "SIRIUS",
      func: "PLOCK",
    },
  );
  // Net-radio bookmark (@NETRADIO:BOOKMARK, official list + attested): true bookmarks
  // the currently playing station, false removes the bookmark — the "save a favourite
  // from ioBroker" path the #613 workflow asked for.
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
    writeOnly: true,
  });
  // Bluetooth connection control (@BT:CONNECT/PAIRING/CONNECTINFO, official list):
  // the connected indicator is readable; connect and pairing are write-only actions
  // gated on the same CONNECTINFO report.
  entries.push(
    {
      id: "player.bluetooth.connected",
      nameKey: "connected",
      spec: { kind: "onoff", on: "Connected", off: "Disconnected" },
      write: false,
      role: "indicator",
      subunit: "BT",
      func: "CONNECTINFO",
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
      writeOnly: true,
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
      wireEncode: () => "Start",
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
      wireEncode: () => "Cancel",
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
      func: "DEVICENAME",
    },
    {
      id: "player.airplay.volumeInterlock",
      nameKey: "volumeInterlock",
      descKey: "descVolumeInterlock",
      spec: { kind: "text" },
      write: false,
      role: "text",
      subunit: "AIRPLAY",
      func: "VOLINTERLOCK",
    },
  );
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
      .filter(entry => !entry.writeOnly && !entry.derived)
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
 * @param resolve optional resolver of the selectable values on this device (see `StatesResolver`)
 * @returns the object definitions to create
 */
export function yncaObjectsFor(
  capabilities: YncaCapabilities,
  catalog: readonly YncaEntry[] = YNCA_CATALOG,
  resolve?: StatesResolver,
): ObjectDef[] {
  return catalogToObjects(presentYncaEntries(capabilities, catalog), resolve);
}

/**
 * The dropdown of a YNCA enum on one device: the candidates of the generation that has the
 * function (the entry's static list) plus every value THIS device ever reported, plus what it
 * reports right now. YNCA declares no value lists, so a device's own spelling (RX-V1067
 * `Dolby ProLogicII(Movie)`, RX-A700 `OUT`) is learned by observation and never lost — and an
 * entry without candidates offers exactly what was observed.
 *
 * @param entry the catalog entry (an enum)
 * @param observed the values this device reported for the function so far
 * @param current the value it reports right now, if known
 * @returns the states map, in candidate order, observed and current values appended
 */
export function enumStatesFor(entry: YncaEntry, observed: readonly string[], current?: string): Record<string, string> {
  const values = entry.spec.kind === "enum" ? Object.keys(entry.spec.states) : [];
  for (const value of [...observed, ...(current ? [current] : [])]) {
    if (!values.includes(value)) {
      values.push(value);
    }
  }
  return selfMap(values);
}

/**
 * The catalog entries this DEVICE actually reported (via their read functions) — the
 * claim-with-proof filter behind both the object tree and the per-device write map.
 * Writes route through the same filter so a state is only ever written with the wire
 * function the device itself answered: where one capability has two generation
 * dialects (SPBASS vs TONEBASS for the bass), the device's own answer picks the
 * dialect, instead of a fixed table sending the wrong generation's command.
 *
 * @param capabilities the device's YNCA capabilities from the init sweep
 * @param catalog the (possibly group-filtered) catalog to filter
 * @returns the entries the device reported
 */
export function presentYncaEntries(
  capabilities: YncaCapabilities,
  catalog: readonly YncaEntry[] = YNCA_CATALOG,
): YncaEntry[] {
  const present = catalog.filter(entry =>
    readFuncsOf(entry).some(func => capabilities.subunits[entry.subunit]?.[func] !== undefined),
  );
  return unionSharedDropdowns(present);
}

/**
 * Give entries that share one state id the SAME dropdown, built from the union of their
 * options.
 *
 * `tuner.band` is fed by two subunits: TUN offers {AM, FM}, DAB offers {DAB, FM}. Every one of
 * the sixteen reference device logs answers on one subunit or the other, so today the two never
 * meet — but if a device ever answered both, the object tree would keep whichever definition was
 * written last and AM would silently vanish from a receiver that has it. Unioning the options
 * costs nothing on a single-subunit device (the union of one list is that list) and keeps the
 * dropdown honest on a dual one; which subunit a band write actually goes to is decided by the
 * controller's tuner router, not by this list.
 *
 * @param entries the entries this device reported
 * @returns the same entries, with shared enum dropdowns unioned
 */
function unionSharedDropdowns(entries: YncaEntry[]): YncaEntry[] {
  const merged = new Map<string, Record<string, string>>();
  for (const entry of entries) {
    if (entry.spec.kind !== "enum") {
      continue;
    }
    const seen = merged.get(entry.id);
    merged.set(entry.id, { ...(seen ?? {}), ...entry.spec.states });
  }
  return entries.map(entry => {
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
  const wire = entry.wireDecode ? entry.wireDecode(message.value) : message.value;
  const value = decode(entry.spec, wire);
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
  // A read-only entry maps no write: without this check a script writing e.g. the
  // (deliberately read-only) YNCA port state would still put a PUT on the wire.
  if (!entry?.write) {
    return undefined;
  }
  // Guard the write value: a null/undefined or non-finite-number write must not be
  // turned into a bogus command (e.g. `@TUN:AMFREQ=null`). A CODED entry is a number
  // state too (playback/repeat carry 0/1/2), so it is held to the same check — that is
  // also what lets `encode` accept a numeric string for it.
  if (!isWritableValue(value, entry.spec.kind === "number" || entry.spec.kind === "code")) {
    return undefined;
  }
  const wire = entry.wireEncode
    ? entry.wireEncode(value as boolean | number | string)
    : encode(entry.spec, value as boolean | number | string);
  return { subunit: entry.subunit, func: entry.func, value: wire };
}
