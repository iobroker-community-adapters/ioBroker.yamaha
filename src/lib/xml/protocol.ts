import { decodeXmlText } from "./entities";

/**
 * The device's own verdict on a request: every `<YAMAHA_AV rsp=…>` answer carries an
 * `RC` attribute (0 = executed, 2 = the node does not exist on this model, 3/4 =
 * value refused / not executable right now). The predecessor code threw this away —
 * which is why a refused scene recall or menu command looked exactly like success
 * and user reports stayed undiagnosable (#613/#615).
 *
 * @param xml the response body
 * @returns the return code, or undefined when the body carries none
 */
export function parseReturnCode(xml: string): number | undefined {
  const match = /<YAMAHA_AV[^>]*\bRC="(\d+)"/.exec(xml);
  return match ? Number(match[1]) : undefined;
}

/**
 * Throw when a response reports a non-zero return code — the device REFUSED the
 * request. An empty body counts as a refusal too: the firmware answers unknown
 * nodes with a bodyless HTTP 400 (captured RX-V6A behaviour).
 *
 * @param xml the response body
 * @param what the request, for the error message
 * @returns the body, for chaining
 */
export function assertXmlOk(xml: string, what: string): string {
  if (xml.length === 0) {
    throw new Error(`device refused ${what} (empty response)`);
  }
  const code = parseReturnCode(xml);
  if (code !== undefined && code !== 0) {
    throw new Error(`device refused ${what} (RC=${code})`);
  }
  return xml;
}

/**
 * A transport-level refusal carrying the HTTP status. The firmware answers a request for
 * a node the model does not have with a BODYLESS HTTP 400 (captured RX-V6A behaviour) —
 * a PERMANENT verdict ("this node does not exist here"), unlike a timeout or a connection
 * error. Callers that remember answers per device need the distinction:
 * {@link isPermanentXmlRefusal}.
 */
export class XmlHttpError extends Error {
  /**
   * @param message the error message
   * @param statusCode the HTTP status the device answered with
   */
  public constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "XmlHttpError";
  }
}

/**
 * Whether a failed XML read is the model's permanent verdict (the node does not exist:
 * bodyless HTTP 400) rather than a transient failure (timeout, connection error, HTTP 5xx).
 * A device that was merely busy or asleep must be asked again, or a probe that is
 * remembered per device would record "declares none" for good.
 *
 * @param e the caught value
 * @returns true when the refusal is permanent for this model
 */
export function isPermanentXmlRefusal(e: unknown): boolean {
  // 400 without a body: an unknown control node. 404: no device description on this model — the
  // 2020 generation answers exactly that for /YamahaRemoteControl/desc.xml (RX-V6A harvest).
  return e instanceof XmlHttpError && (e.statusCode === 400 || e.statusCode === 404);
}

/** One scene as the device declares it in `<Scene_Sel_Item>`. */
export interface XmlScene {
  /** The 1-based scene number (from the `<Param>Scene N</Param>` write value). */
  num: number;
  /** The scene's title (e.g. "Movie Viewing"), possibly renamed by the user. */
  title: string;
}

/**
 * Parse a `<Scene_Sel_Item>` response into the scenes the device DECLARES for the
 * zone: each `<Item_N>` carries the write value (`<Param>Scene N</Param>`), whether
 * it is writable (`<RW>W</RW>`) and its title. This is the device's own contract —
 * the RX-V6A capture shows `Scene_Sel` as the declared write element, not the
 * predecessor's `Scene_Load` (#615).
 *
 * @param xml the Scene_Sel_Item response body
 * @returns the declared writable scenes, empty when the zone has none
 */
export function parseSceneList(xml: string): XmlScene[] {
  const scenes: XmlScene[] = [];
  const pattern = /<Item_\d+>\s*<Param>Scene (\d+)<\/Param>\s*<RW>([^<]*)<\/RW>\s*<Title>([^<]*)<\/Title>/g;
  for (let match = pattern.exec(xml); match; match = pattern.exec(xml)) {
    if (match[2].includes("W")) {
      scenes.push({ num: Number(match[1]), title: decodeXmlText(match[3]) });
    }
  }
  return scenes;
}

/**
 * Parse an `<Input_Sel_Item>` response into the zone's selectable input values (the
 * `<Param>` of every item). The device's own list — per zone, it differs between
 * Main and Zone 2 on real hardware (RX-V6A capture: 4.4 KB vs 3.3 KB) — becomes the
 * input dropdown, replacing a free-text state on XML-owned devices.
 *
 * @param xml the Input_Sel_Item response body
 * @returns the selectable input values, empty when the zone reports none
 */
export function parseInputList(xml: string): string[] {
  const inputs: string[] = [];
  const pattern = /<Item_\d+>\s*<Param>([^<]+)<\/Param>/g;
  for (let match = pattern.exec(xml); match; match = pattern.exec(xml)) {
    inputs.push(decodeXmlText(match[1]));
  }
  return inputs;
}

/**
 * Parse an `<Input_Sel_Item>` response into the LABEL of every input: the `<Title>` the device
 * carries for a socket, keyed by the `<Param>` that switches it.
 *
 * A receiver stores the name its owner gave a socket ("Apple TV" on HDMI1) and hands it out here,
 * while the switching value stays the protocol's own (`HDMI1`). An item without a title — or with
 * a blank one — is labelled with its value, so a dropdown never shows an empty entry.
 *
 * @param xml the Input_Sel_Item response body
 * @returns value → label for every item the zone lists, empty when it lists none
 */
export function parseInputLabels(xml: string): Record<string, string> {
  const labels: Record<string, string> = {};
  const item = /<Item_\d+>([\s\S]*?)<\/Item_\d+>/g;
  for (let match = item.exec(xml); match; match = item.exec(xml)) {
    const value = /<Param>([^<]*)<\/Param>/.exec(match[1]);
    if (!value) {
      continue;
    }
    const param = decodeXmlText(value[1]);
    const title = /<Title>([^<]*)<\/Title>/.exec(match[1]);
    const label = title ? decodeXmlText(title[1]).trim() : "";
    labels[param] = label.length > 0 ? label : param;
  }
  return labels;
}

/** The tuner fields a classic `<Tuner><Play_Info>` response can carry. */
export interface XmlTunerInfo {
  /** The active preset slot (0 = none). */
  preset?: number;
  /** The tuned frequency, scaled by the response's own exponent. */
  frequency?: number;
  /** The frequency's unit as the device reports it (MHz/kHz). */
  frequencyUnit?: string;
  /** RDS station name. */
  rdsService?: string;
  /** RDS radio text. */
  rdsText?: string;
  /** Whether the tuner is locked onto a station. */
  tuned?: boolean;
  /** Whether reception is stereo. */
  stereo?: boolean;
}

/**
 * Parse a classic `<Tuner><Play_Info>` response, presence-checked across the
 * generation dialects (flat vs band-wrapped — the shared field shapes are verified
 * against the captured `<DAB>` sibling: Preset/Preset_Sel, Tuning/Freq Val+Exp+Unit,
 * Signal_Info Tuned/Stereo as Assert/Negate, Meta_Info Program_Service/Radio_Text).
 * Only the XML-only generation (pre-2010, the third transport as the only one) ever
 * OWNS these states — newer devices carry the tuner via YNCA/YXC.
 *
 * @param xml the Play_Info response body
 * @returns the fields the response carries
 */
export function parseTunerInfo(xml: string): XmlTunerInfo {
  const info: XmlTunerInfo = {};
  const preset = /<Preset>\s*<Preset_Sel>([^<]+)<\/Preset_Sel>/.exec(xml);
  if (preset) {
    const slot = Number(preset[1]);
    info.preset = Number.isFinite(slot) ? slot : 0;
  }
  const freq = /<Freq>\s*(?:<Current>\s*)?<Val>(-?\d+)<\/Val>\s*<Exp>(\d+)<\/Exp>\s*<Unit>([^<]*)<\/Unit>/.exec(xml);
  if (freq) {
    info.frequency = Number(freq[1]) / 10 ** Number(freq[2]);
    info.frequencyUnit = freq[3];
  }
  const service = /<Program_Service>([^<]*)<\/Program_Service>/.exec(xml);
  if (service) {
    info.rdsService = decodeXmlText(service[1]);
  }
  const text = /<Radio_Text>([^<]*)<\/Radio_Text>/.exec(xml);
  if (text) {
    info.rdsText = decodeXmlText(text[1]);
  }
  const tuned = /<Tuned>(Assert|Negate)<\/Tuned>/.exec(xml);
  if (tuned) {
    info.tuned = tuned[1] === "Assert";
  }
  const stereo = /<Stereo>(Assert|Negate)<\/Stereo>/.exec(xml);
  if (stereo) {
    info.stereo = stereo[1] === "Assert";
  }
  return info;
}

/**
 * Wrap an inner command in the YAMAHA_AV PUT envelope for a zone.
 *
 * @param zone the zone element (e.g. `Main_Zone`)
 * @param inner the inner command XML
 * @returns the full request body
 */
export function encodePut(zone: string, inner: string): string {
  return `<YAMAHA_AV cmd="PUT"><${zone}>${inner}</${zone}></YAMAHA_AV>`;
}

/**
 * Wrap an inner request in the YAMAHA_AV GET envelope for a zone.
 *
 * @param zone the zone element (e.g. `Main_Zone`)
 * @param inner the inner request XML
 * @returns the full request body
 */
export function encodeGet(zone: string, inner: string): string {
  return `<YAMAHA_AV cmd="GET"><${zone}>${inner}</${zone}></YAMAHA_AV>`;
}

/** What a classic receiver declares about itself in `<System><Config>`. */
export interface XmlSystemConfig {
  /** `<Model_Name>`, when reported. */
  model?: string;
  /** `<System_ID>`, when reported (2008+). */
  systemId?: string;
  /**
   * The firmware as the device prints it — `<Version>1.80/3.14</Version>` from 2012 on; the 2008
   * generation nests it as `<Version><Main>…</Main><Sub>…</Sub></Version>`, joined here as `Main/Sub`.
   */
  version?: string;
  /** The zone flags of `<Feature_Existence>` — absent when the block is missing (2008 generation). */
  zones?: Partial<Record<"Main_Zone" | "Zone_2" | "Zone_3" | "Zone_4", boolean>>;
  /** Every other `<Feature_Existence>` flag by its XML key (Tuner, DAB, Spotify, JUKE, …). */
  features?: Record<string, boolean>;
  /** The inputs of `<Name><Input>` by XML key (HDMI_1 → the name the user gave it). */
  inputNames?: Record<string, string>;
}

const ZONE_FLAGS = new Set(["Main_Zone", "Zone_2", "Zone_3", "Zone_4"]);

/**
 * Parse a `<System><Config>` answer into the device's own declaration of itself.
 *
 * The block is the receiver's feature list, not a status: `<Feature_Existence>` names every zone
 * and every source as 0/1, `<Name><Input>` every renameable input with its (user-given) name,
 * and `<System_ID>` + `<Version>` identify the unit. Measured on three generations (RX-S601D 2015,
 * HTR-4069 2017, RX-V6A 2020 — all with the block; the 2008 RX-V3900 without). The predecessor
 * adapter read exactly this block for its input list; the rewrite had reduced it to `Model_Name`.
 *
 * @param xml the System/Config response body
 * @returns the declaration (an empty object for a malformed body)
 */
export function parseSystemConfig(xml: string): XmlSystemConfig {
  const config: XmlSystemConfig = {};
  const text = (tag: string): string | undefined => {
    const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
    return match && match[1].length > 0 ? decodeXmlText(match[1]) : undefined;
  };
  const model = text("Model_Name");
  if (model !== undefined) {
    config.model = model;
  }
  const systemId = text("System_ID");
  if (systemId !== undefined) {
    config.systemId = systemId;
  }
  const version = text("Version");
  if (version !== undefined) {
    config.version = version.trim();
  } else {
    const nested = /<Version>\s*<Main>([^<]*)<\/Main>\s*<Sub>([^<]*)<\/Sub>\s*<\/Version>/.exec(xml);
    if (nested) {
      config.version = `${decodeXmlText(nested[1]).trim()}/${decodeXmlText(nested[2]).trim()}`;
    }
  }
  const existence = /<Feature_Existence>([\s\S]*?)<\/Feature_Existence>/.exec(xml);
  if (existence) {
    const zones: NonNullable<XmlSystemConfig["zones"]> = {};
    const features: Record<string, boolean> = {};
    const flag = /<([A-Za-z0-9_]+)>([01])<\/\1>/g;
    for (let match = flag.exec(existence[1]); match; match = flag.exec(existence[1])) {
      if (ZONE_FLAGS.has(match[1])) {
        zones[match[1] as keyof typeof zones] = match[2] === "1";
      } else {
        features[match[1]] = match[2] === "1";
      }
    }
    config.zones = zones;
    config.features = features;
  }
  const names = /<Name>\s*<Input>([\s\S]*?)<\/Input>/.exec(xml);
  if (names) {
    const inputNames: Record<string, string> = {};
    const entry = /<([A-Za-z0-9_]+)>([^<]*)<\/\1>/g;
    for (let match = entry.exec(names[1]); match; match = entry.exec(names[1])) {
      inputNames[match[1]] = decodeXmlText(match[2]);
    }
    config.inputNames = inputNames;
  }
  return config;
}

/** The enumerations and ranges a classic receiver declares in its device description (`desc.xml`). */
export interface XmlDescriptor {
  /** `Surround,Program_Sel,Current,Sound_Program` — the SOUNDPRG spelling of Yamaha's lists. */
  programs: string[];
  /** `Power_Control,Sleep` — "120 min" … "Off" (the 2008 generation says "120" … "Off"). */
  sleep: string[];
  /** `Sound_Video,Adaptive_DRC` — Auto/Off. */
  adaptiveDrc: string[];
  /** `Sound_Video,HDMI,Output,OUT_2` — may carry "Unavailable" where the second output is optional. */
  hdmiOut2?: string[];
  /** `Sound_Video,Dialogue_Adjust,Dialogue_Lvl` range, when declared. */
  dialogueLevel?: { min: number; max: number; step: number };
  /** The zone elements whose `Cmd_List` defines `Cursor_Control,Cursor` — the zone-wide cursor pad. */
  cursorZones?: string[];
  /** The zone elements with `Cursor_Control,Menu_Control` — the zone-wide menu keys. */
  menuZones?: string[];
  /** The zone elements with `Play_Control,Playback` — transport keys per zone. */
  playbackZones?: string[];
  /** The zone elements with `Volume,Output` — the pre-out level mode (zones 2–4). */
  volumeOutputZones?: string[];
}

/**
 * The zone elements whose `Cmd_List` defines the given command path (`<Define ID="P18">
 * Main_Zone,Cursor_Control,Cursor</Define>`), in document order, each once.
 *
 * @param xml the desc.xml body
 * @param path the command path after the zone element
 * @returns the zone elements declaring it
 */
function definingZones(xml: string, path: string): string[] {
  const zones: string[] = [];
  const pattern = new RegExp(`<Define ID="[PG]\\d+">(Main_Zone|Zone_[234]),${path.replace(/,/g, ",")}</Define>`, "g");
  for (const match of xml.matchAll(pattern)) {
    if (!zones.includes(match[1])) {
      zones.push(match[1]);
    }
  }
  return zones;
}

/**
 * The `<Direct>` values or the `<Range>` of one command's first parameter in desc.xml. The
 * command text is matched as the whole `<Cmd>` content (`…=Param_1`); the zone lives in the
 * `Cmd_List` defines, not in the command text, so the first block found is the main zone's.
 *
 * @param xml the device description
 * @param command the command path (`Power_Control,Sleep`)
 * @returns the values and, for a numeric parameter, its range
 */
function descriptorParam(
  xml: string,
  command: string,
): { values: string[]; range?: { min: number; max: number; step: number } } {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(`<Cmd[^>]*>${escaped}=Param_1</Cmd>\\s*<Param_1>([\\s\\S]*?)</Param_1>`).exec(xml);
  if (!block) {
    return { values: [] };
  }
  const values: string[] = [];
  const direct = /<Direct(?:\s[^>]*)?>([^<]+)<\/Direct>/g;
  for (let match = direct.exec(block[1]); match; match = direct.exec(block[1])) {
    values.push(decodeXmlText(match[1]));
  }
  const range = /<Range>(-?\d+),(-?\d+),(\d+)/.exec(block[1]);
  return range
    ? { values, range: { min: Number(range[1]), max: Number(range[2]), step: Number(range[3]) } }
    : { values };
}

/**
 * Parse the enumerations the adapter uses out of `/YamahaRemoteControl/desc.xml`.
 *
 * Measured on nine models 2012–2017 (RX-V473 … RX-A2060, HTR-4069, RX-S601D): 19 or 25 programs
 * spelled exactly like the YNCA SOUNDPRG values of Yamaha's official lists, five sleep steps,
 * Adaptive DRC Auto/Off, the second HDMI output with an `Unavailable` state on the models whose
 * second output is optional, and the dialogue-level range. The 2008 generation (RX-V3900)
 * carries only its own sleep words and the volume range; the 2020 generation no desc.xml at
 * all (HTTP 404). The predecessor adapter read the programs from this very file.
 *
 * @param xml the device description
 * @returns the enumerations (empty lists where the description carries none)
 */
export function parseDescriptor(xml: string): XmlDescriptor {
  const descriptor: XmlDescriptor = {
    programs: descriptorParam(xml, "Surround,Program_Sel,Current,Sound_Program").values,
    sleep: descriptorParam(xml, "Power_Control,Sleep").values,
    adaptiveDrc: descriptorParam(xml, "Sound_Video,Adaptive_DRC").values,
  };
  const hdmiOut2 = descriptorParam(xml, "Sound_Video,HDMI,Output,OUT_2").values;
  if (hdmiOut2.length > 0) {
    descriptor.hdmiOut2 = hdmiOut2;
  }
  descriptor.cursorZones = definingZones(xml, "Cursor_Control,Cursor");
  descriptor.menuZones = definingZones(xml, "Cursor_Control,Menu_Control");
  descriptor.playbackZones = definingZones(xml, "Play_Control,Playback");
  descriptor.volumeOutputZones = definingZones(xml, "Volume,Output");
  const dialogue = descriptorParam(xml, "Sound_Video,Dialogue_Adjust,Dialogue_Lvl").range;
  if (dialogue) {
    descriptor.dialogueLevel = dialogue;
  }
  return descriptor;
}

/**
 * The two spellings of the amplifier block. The 2008 generation (RX-V3900, openHAB capture,
 * its own desc.xml) answers `<Vol><Lvl>`, `<Vol><Mute>` and `<Surr><Pgm_Sel><Pgm>`; every
 * generation from 2010 on `<Volume><Lvl>`, `<Volume><Mute>` and
 * `<Surround><Program_Sel><Current><Sound_Program>`. A write follows the spelling the device
 * itself answered with — the dialect is a property of the model.
 */
export type XmlDialect = "classic" | "legacy";

/** The amplifier fields a Basic_Status response can carry. */
export interface BasicStatus {
  /** Which spelling the block used — set when it carried a volume or a program element at all. */
  dialect?: XmlDialect;
  /** Power state (true = on). */
  power?: boolean;
  /** Volume in decibels. */
  volume?: number;
  /** Mute state. */
  mute?: boolean;
  /** Selected input. */
  input?: string;
  /** Selected sound program (DSP). */
  soundProgram?: string;
  /** Pure Direct mode. */
  pureDirect?: boolean;
  /** Straight (surround off) mode. */
  straight?: boolean;
  /** Direct mode (Sound_Video/Direct). */
  direct?: boolean;
  /** Adaptive DRC (e.g. "Auto", "Off"). */
  adaptiveDrc?: string;
  /** Dialogue level. */
  dialogueLevel?: number;
  /** Sleep timer (e.g. "Off", "30 min"). */
  sleep?: string;
  /** Bass tone control (dB). */
  bass?: number;
  /** Treble tone control (dB). */
  treble?: number;
  /** Subwoofer trim (dB). */
  subwooferTrim?: number;
  /** Extra Bass (device reports Auto/Off, mapped to a boolean). */
  extraBass?: boolean;
  /** YPAO Volume (device reports Auto/Off, mapped to a boolean). */
  ypaoVolume?: boolean;
  /** HDMI output OUT_1 on/off. */
  hdmiOut1?: boolean;
  /** HDMI output OUT_2 on/off. */
  hdmiOut2?: boolean;
  /** Party mode (device reports Party_Info On/Off). */
  party?: boolean;
  /** Dialogue lift. */
  dialogueLift?: number;
  /** Compressed Music Enhancer (`Surround,Program_Sel,Current,Enhancer`, 9 of 10 descriptors). */
  enhancer?: boolean;
  /** CINEMA DSP 3D (`Surround,_3D_Cinema_DSP` Auto/Off, mapped to a boolean like YNCA's 3DCINEMA). */
  cinemaDsp3d?: boolean;
  /** Speaker terminal A on/off (`Speaker_Preout,Speaker_AB,Speaker_A`). */
  speakerA?: boolean;
  /** Speaker terminal B on/off. */
  speakerB?: boolean;
  /** Zone B availability (`Volume,Zone_B,Feature_Availability` Ready / Not Ready). */
  zoneBAvailable?: string;
  /** Zone B volume interlock with the main zone. */
  zoneBInterlock?: boolean;
  /** Zone B volume in decibels. */
  zoneBVolume?: number;
  /** Zone B mute. */
  zoneBMute?: boolean;
  /** Zone B power (`Power_Control,Zone_B_Power_Info` On / Standby; Unavailable is no state). */
  zoneBPower?: boolean;
  /** A zone's pre-out level mode (`Volume,Output_Info` Fixed / Variable — zones 2–4 only). */
  volumeOutput?: string;
}

/**
 * Parse a Basic_Status response into the amplifier fields it carries. Only fields
 * the response actually contains are returned; a malformed response yields an
 * empty object. Volume comes as tenths of a decibel (`<Val>-300</Val>` = -30 dB).
 *
 * @param body the Basic_Status response body
 * @returns the parsed fields
 */
export function parseBasicStatus(body: string): BasicStatus {
  const status: BasicStatus = {};
  // Zone B (the HTR-4069 class) nests its own Lvl/Mute inside <Volume>: read that block first
  // and take it OUT before the main zone's fields are matched, so neither side reads the other's.
  const zoneB = /<Zone_B>([\s\S]*?)<\/Zone_B>/.exec(body);
  const xml = zoneB ? body.replace(zoneB[0], "") : body;
  if (zoneB) {
    const inner = zoneB[1];
    const availability = /<Feature_Availability>([^<]+)<\/Feature_Availability>/.exec(inner);
    if (availability) {
      status.zoneBAvailable = decodeXmlText(availability[1]);
    }
    const interlock = /<Interlock>(On|Off)<\/Interlock>/.exec(inner);
    if (interlock) {
      status.zoneBInterlock = interlock[1] === "On";
    }
    const level = /<Lvl>\s*<Val>(-?\d+)<\/Val>/.exec(inner);
    if (level) {
      status.zoneBVolume = Number(level[1]) / 10;
    }
    const zoneBMute = /<Mute>(On|Off)<\/Mute>/.exec(inner);
    if (zoneBMute) {
      status.zoneBMute = zoneBMute[1] === "On";
    }
  }
  const power = /<Power>(On|Standby)<\/Power>/.exec(xml);
  if (power) {
    status.power = power[1] === "On";
  }
  const zoneBPower = /<Zone_B_Power_Info>(On|Standby)<\/Zone_B_Power_Info>/.exec(xml);
  if (zoneBPower) {
    status.zoneBPower = zoneBPower[1] === "On";
  }
  // Both dialects are read (see XmlDialect): the 2008 generation had NO volume, mute or
  // program on this transport until 2.6.0 — the very generation the transport exists for.
  if (/<Vol>|<Pgm_Sel>/.test(xml)) {
    status.dialect = "legacy";
  } else if (/<Volume>|<Program_Sel>/.test(xml)) {
    status.dialect = "classic";
  }
  // Scope the volume to its <Volume><Lvl> parent — a bare <Val> also matches
  // Dialogue_Lvl and other <Val>-carrying fields, so an unscoped match would read
  // the wrong field as the volume.
  const volume = /<(?:Volume|Vol)>\s*<Lvl>\s*<Val>(-?\d+)<\/Val>/.exec(xml);
  if (volume) {
    status.volume = Number(volume[1]) / 10;
  }
  const mute = /<Mute>(On|Off)<\/Mute>/.exec(xml);
  if (mute) {
    status.mute = mute[1] === "On";
  }
  const input = /<Input_Sel>([^<]+)<\/Input_Sel>/.exec(xml);
  if (input) {
    status.input = decodeXmlText(input[1]);
  }
  const soundProgram = /<(?:Sound_Program|Pgm)>([^<]+)<\/(?:Sound_Program|Pgm)>/.exec(xml);
  if (soundProgram) {
    status.soundProgram = decodeXmlText(soundProgram[1]);
  }
  const pureDirect = /<Pure_Direct>\s*<Mode>(On|Off)<\/Mode>/.exec(xml);
  if (pureDirect) {
    status.pureDirect = pureDirect[1] === "On";
  }
  const straight = /<Straight>(On|Off)<\/Straight>/.exec(xml);
  if (straight) {
    status.straight = straight[1] === "On";
  }
  const direct = /<Direct>\s*<Mode>(On|Off)<\/Mode>/.exec(xml);
  if (direct) {
    status.direct = direct[1] === "On";
  }
  const adaptiveDrc = /<Adaptive_DRC>(Auto|Off)<\/Adaptive_DRC>/.exec(xml);
  if (adaptiveDrc) {
    status.adaptiveDrc = decodeXmlText(adaptiveDrc[1]);
  }
  const dialogueLevel = /<Dialogue_Lvl>\s*<Val>(-?\d+)<\/Val>/.exec(xml);
  if (dialogueLevel) {
    status.dialogueLevel = Number(dialogueLevel[1]);
  }
  const sleepMatch = /<Sleep>([^<]+)<\/Sleep>/.exec(xml);
  if (sleepMatch) {
    status.sleep = decodeXmlText(sleepMatch[1]);
  }
  // Tone/subwoofer/extra-bass/YPAO — the fields the predecessor adapter (via
  // yamaha-nodejs-soef) read on real pre-2010 devices. Val is scoped to its own
  // element, so Subwoofer_Trim's <Val> is never read as the volume. Like the volume,
  // these carry the Val/Exp=1/Unit=dB structure (the soef library builds the identical
  // envelope for setVolumeTo and setBassTo), so Val is tenths of a decibel: /10 here,
  // *10 in the PUT builders.
  const bass = /<Bass>\s*<Val>(-?\d+)<\/Val>/.exec(xml);
  if (bass) {
    status.bass = Number(bass[1]) / 10;
  }
  const treble = /<Treble>\s*<Val>(-?\d+)<\/Val>/.exec(xml);
  if (treble) {
    status.treble = Number(treble[1]) / 10;
  }
  const subwooferTrim = /<Subwoofer_Trim>\s*<Val>(-?\d+)<\/Val>/.exec(xml);
  if (subwooferTrim) {
    status.subwooferTrim = Number(subwooferTrim[1]) / 10;
  }
  const extraBass = /<Extra_Bass>([^<]+)<\/Extra_Bass>/.exec(xml);
  if (extraBass) {
    status.extraBass = extraBass[1] !== "Off";
  }
  const ypaoVolume = /<YPAO_Volume>([^<]+)<\/YPAO_Volume>/.exec(xml);
  if (ypaoVolume) {
    status.ypaoVolume = ypaoVolume[1] !== "Off";
  }
  // HDMI outputs, party and dialogue lift — read from the main zone's Basic_Status
  // (Sound_Video/HDMI, Party_Info, Dialogue_Adjust), as the predecessor adapter did.
  const hdmiOut1 = /<OUT_1>(On|Off)<\/OUT_1>/.exec(xml);
  if (hdmiOut1) {
    status.hdmiOut1 = hdmiOut1[1] === "On";
  }
  const hdmiOut2 = /<OUT_2>(On|Off)<\/OUT_2>/.exec(xml);
  if (hdmiOut2) {
    status.hdmiOut2 = hdmiOut2[1] === "On";
  }
  const party = /<Party_Info>([^<]+)<\/Party_Info>/.exec(xml);
  if (party) {
    status.party = party[1] === "On";
  }
  // The zone commands desc.xml declares on 2012–2017 receivers, read from the same status
  // (coverage audit 2026-09-09; measured on the HTR-4069 and RX-S601D captures).
  const enhancer = /<Enhancer>(On|Off)<\/Enhancer>/.exec(xml);
  if (enhancer) {
    status.enhancer = enhancer[1] === "On";
  }
  const cinema = /<_3D_Cinema_DSP>(Auto|Off)<\/_3D_Cinema_DSP>/.exec(xml);
  if (cinema) {
    status.cinemaDsp3d = cinema[1] === "Auto";
  }
  const speakerA = /<Speaker_A>(On|Off)<\/Speaker_A>/.exec(xml);
  if (speakerA) {
    status.speakerA = speakerA[1] === "On";
  }
  const speakerB = /<Speaker_B>(On|Off)<\/Speaker_B>/.exec(xml);
  if (speakerB) {
    status.speakerB = speakerB[1] === "On";
  }
  const output = /<Output_Info>(Fixed|Variable)<\/Output_Info>/.exec(xml);
  if (output) {
    status.volumeOutput = output[1];
  }
  const dialogueLift = /<Dialogue_Lift>(-?\d+)<\/Dialogue_Lift>/.exec(xml);
  if (dialogueLift) {
    status.dialogueLift = Number(dialogueLift[1]);
  }
  return status;
}
