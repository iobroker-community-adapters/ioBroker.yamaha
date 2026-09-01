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

/**
 * Extract the model name from a `<System><Config>` response, if it carries one.
 *
 * @param xml the System>Config response body
 * @returns the model name, or undefined
 */
export function parseModelName(xml: string): string | undefined {
  const match = /<Model_Name>([^<]*)<\/Model_Name>/.exec(xml);
  return match && match[1].length > 0 ? decodeXmlText(match[1]) : undefined;
}

/** The amplifier fields a Basic_Status response can carry. */
export interface BasicStatus {
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
}

/**
 * Parse a Basic_Status response into the amplifier fields it carries. Only fields
 * the response actually contains are returned; a malformed response yields an
 * empty object. Volume comes as tenths of a decibel (`<Val>-300</Val>` = -30 dB).
 *
 * @param xml the Basic_Status response body
 * @returns the parsed fields
 */
export function parseBasicStatus(xml: string): BasicStatus {
  const status: BasicStatus = {};
  const power = /<Power>(On|Standby)<\/Power>/.exec(xml);
  if (power) {
    status.power = power[1] === "On";
  }
  // Scope the volume to its <Volume><Lvl> parent — a bare <Val> also matches
  // Dialogue_Lvl and other <Val>-carrying fields, so an unscoped match would read
  // the wrong field as the volume.
  const volume = /<Volume>\s*<Lvl>\s*<Val>(-?\d+)<\/Val>/.exec(xml);
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
  const soundProgram = /<Sound_Program>([^<]+)<\/Sound_Program>/.exec(xml);
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
  const dialogueLift = /<Dialogue_Lift>(-?\d+)<\/Dialogue_Lift>/.exec(xml);
  if (dialogueLift) {
    status.dialogueLift = Number(dialogueLift[1]);
  }
  return status;
}
