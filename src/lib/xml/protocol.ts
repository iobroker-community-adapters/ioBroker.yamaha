import { MEDIA_STATE } from "../catalog/media-state";
import { ZONES } from "../catalog/zones";
import { HttpStatusError } from "../util";
import { decodeXmlText, escapeXmlText } from "./entities";

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
 * The device answered — and said no: a return code other than 0 in its `<YAMAHA_AV>` answer (2 = the node does not
 * exist on this model, 3/4 = value refused / not executable right now), or an empty answer to a command. Proof that
 * the device is there, like MusicCast's `YxcRefusalError`: a refused write is read back, and it is never a reason to
 * ask whether the device is still alive. The controller told a refusal from a lost connection by the MESSAGE text
 * (`startsWith("device refused")`), which a reworded message or any other error with those words broke (review
 * 2026-10-05, E).
 */
export class XmlRefusalError extends Error {
  /**
   * @param what the request the device refused
   * @param code the return code, undefined for an empty answer
   */
  public constructor(
    what: string,
    public readonly code?: number,
  ) {
    super(`device refused ${what} (${code === undefined ? "empty response" : `RC=${code}`})`);
    this.name = "XmlRefusalError";
  }
}

/**
 * The refusal an answer body carries, if any — the ONE reading of the return code, for commands and probes alike
 * (it stood twice, in `assertXmlOk` and `definiteXmlBody`; review 2026-10-05, E).
 *
 * @param xml the response body
 * @param what the request, for the error message
 * @returns the refusal, or undefined when the device executed the request (RC 0, or no return code at all)
 */
function refusalIn(xml: string, what: string): XmlRefusalError | undefined {
  const code = parseReturnCode(xml);
  return code !== undefined && code !== 0 ? new XmlRefusalError(what, code) : undefined;
}

/**
 * Throw when a response reports a non-zero return code — the device REFUSED the
 * request. An empty body counts as a refusal too: a command answered with nothing was not executed.
 *
 * @param xml the response body
 * @param what the request, for the error message
 * @returns the body, for chaining
 */
export function assertXmlOk(xml: string, what: string): string {
  const refusal = xml.length === 0 ? new XmlRefusalError(what) : refusalIn(xml, what);
  if (refusal) {
    throw refusal;
  }
  return xml;
}

/**
 * Whether a failed XML request is the model's permanent verdict — the node does not exist (RC 2, or the
 * bodyless HTTP 400 the firmware answers an unknown node with), or the model has no device description
 * (HTTP 404) — rather than a transient failure (timeout, connection error, HTTP 5xx, RC 3/4 "not now").
 * A device that was merely busy or asleep must be asked again, or a probe that is remembered per device
 * would record "declares none" for good.
 *
 * @param e the caught value
 * @returns true when the refusal is permanent for this model
 */
export function isPermanentXmlRefusal(e: unknown): boolean {
  // 404: the 2020 generation answers exactly that for /YamahaRemoteControl/desc.xml (RX-V6A harvest).
  return (
    (e instanceof HttpStatusError && (e.statusCode === 400 || e.statusCode === 404)) ||
    (e instanceof XmlRefusalError && e.code === 2)
  );
}

/**
 * A probe's body with the device's verdict applied, for answers that are REMEMBERED per device: a
 * node the model does not have (RC 2, or the bodyless HTTP 400/404) is a definite "" — remembered;
 * RC 3/4 ("not now", a receiver in standby or busy) and every transport error throw — never
 * remembered. The menu probe checked the body only, so a busy receiver's RC 4 was stored as "no menu"
 * for good (audit 2026-09-24, D4).
 *
 * @param request the request
 * @param what the probe, for the error message
 * @returns the body, or "" when the model has no such node
 */
export async function definiteXmlBody(request: () => Promise<string>, what: string): Promise<string> {
  try {
    const body = await request();
    const refusal = refusalIn(body, what);
    if (refusal) {
      throw refusal;
    }
    return body;
  } catch (e) {
    if (isPermanentXmlRefusal(e)) {
      return "";
    }
    throw e;
  }
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
 * A blank title stays blank (trimmed to ""): the scene exists and is recalled by its number, but it has no name — the
 * RX-V6A declares all eight that way, and the blank titles became eight empty dropdown labels and eight empty title
 * datapoints (review 2026-10-05, A23).
 *
 * @param xml the Scene_Sel_Item response body
 * @returns the declared writable scenes, empty when the zone has none
 */
export function parseSceneList(xml: string): XmlScene[] {
  const scenes: XmlScene[] = [];
  const pattern = /<Item_\d+>\s*<Param>Scene (\d+)<\/Param>\s*<RW>([^<]*)<\/RW>\s*<Title>([^<]*)<\/Title>/g;
  for (let match = pattern.exec(xml); match; match = pattern.exec(xml)) {
    if (match[2].includes("W")) {
      scenes.push({ num: Number(match[1]), title: decodeXmlText(match[3]).trim() });
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
  /** RDS radio text (the A line, or the one line where only one is declared). */
  rdsText?: string;
  /** RDS radio text, B line. */
  rdsTextB?: string;
  /** Whether the tuner is locked onto a station. */
  tuned?: boolean;
  /** Whether reception is stereo. */
  stereo?: boolean;
  /** The band the tuner is on (`Tuning,Band`, 9 of 10 descriptors; D6). */
  band?: string;
  /**
   * How the frequency is spelled: `band` = `Freq,Current` read / `Freq,FM|AM` written (2009+), `flat` =
   * `Freq,Val/Exp/Unit` read and written (the 2008 RX-V3900).
   */
  freqForm?: "band" | "flat";
}

/** What a source's `Play_Info` says about the playback (D3). */
export interface XmlPlayInfo {
  /** Play / Pause / Stop as the `media.state` code (catalog/media-state.ts). */
  playback?: number;
  /** The artist, as the source names it. */
  artist?: string;
  /** The album. */
  album?: string;
  /** The track (`Song`, or `Track` on the streaming services). */
  track?: string;
  /** The station (radio sources). */
  station?: string;
  /** The repeat mode as the `media.mode.repeat` code: 0 off, 1 one, 2 all. */
  repeat?: number;
  /** Whether shuffle is on. */
  shuffle?: boolean;
  /** The cover path the device serves, unless it is Yamaha's encrypted `YMF`. */
  albumArt?: string;
  /** The cover's `ID` — it changes with the cover while the path may stay the same (see C36). */
  albumArtId?: string;
}

/**
 * Parse an `<Input_Sel_Item>` response into the source element behind each input — the `<Src_Name>`
 * the device declares for it (RX-V6A: `NET RADIO` → `NET_RADIO`, `Amazon Music` → `Amazon_Music`;
 * RX-V3900: `NET RADIO`, `PC/MCX` and `USB` → `NET_USB`). That element answers `Play_Info` for what
 * the input plays (D3). A socket names none; the tuner (`Tuner`, `DAB`) has its own block and is left
 * out.
 *
 * @param xml the Input_Sel_Item response body
 * @returns input value → source element, for every input that has a player source
 */
export function parseInputSources(xml: string): Record<string, string> {
  const sources: Record<string, string> = {};
  const item = /<Item_\d+>([\s\S]*?)<\/Item_\d+>/g;
  for (let match = item.exec(xml); match; match = item.exec(xml)) {
    const param = /<Param>([^<]*)<\/Param>/.exec(match[1]);
    const source = /<Src_Name>([^<]*)<\/Src_Name>/.exec(match[1])?.[1].trim();
    if (param && source && source !== "Tuner" && source !== "DAB") {
      sources[decodeXmlText(param[1])] = source;
    }
  }
  return sources;
}

/**
 * The inputs an `<Input_Sel_Item>` answer declares as read-only (`<RW>R</RW>`): the zone reports them, but takes no
 * switch to them — the RX-V3900's iPod and Bluetooth (its iPod is reached through the write-only DOCK).
 *
 * @param xml the Input_Sel_Item response body
 * @returns the read-only input values
 */
export function parseReadOnlyInputs(xml: string): string[] {
  const readOnly: string[] = [];
  for (const match of xml.matchAll(/<Item_\d+>([\s\S]*?)<\/Item_\d+>/g)) {
    const param = /<Param>([^<]*)<\/Param>/.exec(match[1]);
    const rw = /<RW>([^<]*)<\/RW>/.exec(match[1]);
    if (param && rw && !rw[1].includes("W")) {
      readOnly.push(decodeXmlText(param[1]));
    }
  }
  return readOnly;
}

/**
 * Parse a source's `Play_Info` (2009+: `Playback_Info`, `Meta_Info`, `Play_Mode`, `Album_ART`; 2008:
 * `Status`, `Title`, `Play_Mode`) — what the player block of the listening zones shows (D3).
 *
 * @param xml the Play_Info response body
 * @returns the fields it carries
 */
export function parsePlayInfo(xml: string): XmlPlayInfo {
  const info: XmlPlayInfo = {};
  // The 2008 iPod reports `Not Connected`/`Not Ready` in the same field and titles both "Stop"
  // (RX-V3900 desc.xml, iPod `Playback`).
  const status = /<(?:Playback_Info|Status)>(Play|Pause|Stop|Not Ready|Not Connected)<\/(?:Playback_Info|Status)>/.exec(
    xml,
  )?.[1];
  if (status !== undefined) {
    info.playback = status === "Play" ? MEDIA_STATE.play : status === "Pause" ? MEDIA_STATE.pause : MEDIA_STATE.stop;
  }
  const text = (tag: string): string | undefined => {
    const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
    return match ? decodeXmlText(match[1]) : undefined;
  };
  info.artist = text("Artist");
  info.album = text("Album");
  info.track = text("Song") ?? text("Track");
  info.station = text("Station");
  const repeat = text("Repeat");
  if (repeat !== undefined) {
    info.repeat = repeat === "All" ? 2 : repeat === "One" || repeat === "Single" ? 1 : 0;
  }
  const shuffle = text("Shuffle");
  if (shuffle !== undefined) {
    info.shuffle = shuffle !== "Off";
  }
  const art = /<Album_ART>([\s\S]*?)<\/Album_ART>/.exec(xml)?.[1];
  if (art !== undefined) {
    const field = (tag: string): string => decodeXmlText(new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(art)?.[1] ?? "");
    // `YMF` is Yamaha's encrypted cover format no client can show (RX-V6A captures: every source).
    info.albumArt = field("Format") === "YMF" ? "" : field("URL");
    info.albumArtId = field("ID");
  }
  for (const key of Object.keys(info) as Array<keyof XmlPlayInfo>) {
    if (info[key] === undefined) {
      delete info[key];
    }
  }
  return info;
}

/** One stored station as the device declares it in `Preset_Sel_Item` (D2). */
export interface XmlPresetSlot {
  /** The slot as a number: the plain number, or a 2008 bank code (`A1` = 1 … `E8` = 40). */
  num: number;
  /** The value the device takes and reports (`12`, `A1`). */
  code: string;
  /** The slot's title as the device shows it. */
  title: string;
}

/**
 * A preset slot's number from its code: a plain number, or the 2008 generation's bank code — eight
 * slots per letter, `A1` = 1, `B1` = 9 (openHAB `InputWithPresetControlXML.convertToPresetNumber`).
 * "No Preset"/"Not Used" is no slot (0).
 *
 * @param code the value the device reports
 * @returns the slot number, 0 for none, undefined for a code of no known form
 */
export function presetSlotNumber(code: string): number | undefined {
  const trimmed = code.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const bank = /^([A-E])([1-8])$/.exec(trimmed);
  if (bank) {
    return (bank[1].charCodeAt(0) - 65) * 8 + Number(bank[2]);
  }
  return trimmed === "No Preset" || trimmed === "Not Used" ? 0 : undefined;
}

/**
 * Parse a `Tuner,Play_Control,Preset,Preset_Sel_Item` answer into the slots the device declares —
 * the values its preset takes (desc.xml `Indirect G3`), with their titles (D2). An unused slot
 * (`Not Used`) is none.
 *
 * @param xml the Preset_Sel_Item response body
 * @returns the declared slots
 */
export function parsePresetList(xml: string): XmlPresetSlot[] {
  const slots: XmlPresetSlot[] = [];
  const pattern = /<Item_\d+>\s*<Param>([^<]+)<\/Param>(?:\s*<RW>[^<]*<\/RW>)?(?:\s*<Title>([^<]*)<\/Title>)?/g;
  for (const match of xml.matchAll(pattern)) {
    const code = decodeXmlText(match[1]).trim();
    const num = presetSlotNumber(code);
    if (num !== undefined && num > 0) {
      slots.push({ num, code, title: match[2] !== undefined ? decodeXmlText(match[2]).trim() || code : code });
    }
  }
  return slots;
}

/**
 * Parse a classic `<Tuner><Play_Info>` response, presence-checked across the
 * generation dialects (flat vs band-wrapped — the shared field shapes are verified
 * against the captured `<DAB>` sibling: Preset/Preset_Sel, Tuning/Freq Val+Exp+Unit,
 * Signal_Info Tuned/Stereo as Assert/Negate, Meta_Info Program_Service/Radio_Text).
 * XML owns these states on the XML-only generation (pre-2010) and wherever the other transports
 * are not connected; otherwise YNCA/YXC carry the tuner.
 *
 * @param xml the Play_Info response body
 * @returns the fields the response carries
 */
export function parseTunerInfo(xml: string): XmlTunerInfo {
  const info: XmlTunerInfo = {};
  // `Preset,Preset_Sel` from 2009 on; the 2008 generation declares the slot directly as `Preset`
  // (RX-V3900 desc.xml) — "No Preset" is no slot (audit 2026-09-24, D7).
  const preset = /<Preset>\s*(?:<Preset_Sel>)?([^<]+?)\s*<\/(?:Preset_Sel|Preset)>/.exec(xml);
  if (preset) {
    // A plain slot, the 2008 bank code (`A1`), or "No Preset" = 0 — `A1` read as NaN before (D2).
    const slot = presetSlotNumber(preset[1]);
    if (slot !== undefined) {
      info.preset = slot;
    }
  }
  const band = /<Tuning>\s*<Band>(AM|FM)<\/Band>/.exec(xml);
  if (band) {
    info.band = band[1];
  }
  if (/<Freq>\s*<Current>/.test(xml)) {
    info.freqForm = "band";
  } else if (/<Freq>\s*<Val>/.test(xml)) {
    info.freqForm = "flat";
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
  // `Meta_Info,Radio_Text_A/_B` (2012–2017, six of ten descriptors) and `RDS,Radio_Text_A/_B` (2008);
  // the RX-S601D declares one bare `Radio_Text`. Only the bare form was read — the text of every
  // other generation never arrived (D7).
  const text = /<Radio_Text(?:_A)?>([^<]*)<\/Radio_Text(?:_A)?>/.exec(xml);
  if (text) {
    info.rdsText = decodeXmlText(text[1]);
  }
  const textB = /<Radio_Text_B>([^<]*)<\/Radio_Text_B>/.exec(xml);
  if (textB) {
    info.rdsTextB = decodeXmlText(textB[1]);
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

/** The zone flags of `<Feature_Existence>` — the XML elements of the one zone table. */
const ZONE_FLAGS: ReadonlySet<string> = new Set(ZONES.map(zone => zone.xml));

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

/**
 * The command form of a zone where it differs from the main zone's (audit 2026-09-24, D6): the RX-A2060's
 * zones 2/3 and the 2020 generation (RX-V6A capture) put bass and treble under `Tone,Manual` next to a
 * `Tone,Mode`, and the enhancer under `Surround,Current` instead of `Surround,Program_Sel,Current` —
 * the RX-S601D/V675/V775 zones 2 use the main zone's paths.
 */
export interface XmlZoneForm {
  /** Bass/treble under `Sound_Video,Tone,Manual`. */
  toneManual?: boolean;
  /** Enhancer under `Surround,Current`. */
  enhancerCurrent?: boolean;
  /** Per state, the step the zone declares for its level — the grid a written value snaps to (D10/D16). */
  steps?: Record<string, number>;
}

/** A numeric range as desc.xml declares it, in the datapoint's unit. */
export interface XmlRange {
  /** Lowest value. */
  min: number;
  /** Highest value. */
  max: number;
  /** Step. */
  step: number;
}

/** One write command desc.xml declares: its path exists, with the range or the words it takes. */
export interface XmlDeclaredPut {
  /** The numeric range (`Put_2`, a bare `Param_1` or `Val=Param_1:Exp=Param_2`), in the datapoint's unit. */
  range?: XmlRange;
  /** The words a `Put_1` group writes (`Auto`/`Bypass`/`Manual`). */
  words?: string[];
}

/**
 * Every write command desc.xml declares, per element and command path (`Zone_2` →
 * `Sound_Video,Tone,Mode` → words Auto/Bypass/Manual; `Main_Zone` → `Volume,Lvl` → −80.5…16.5/0.5):
 * the `Define` with a P id names the path, the `Put_1`/`Put_2` with that id in the same `YNC_Tag`
 * block carries what it takes. A level is `Val=Param_1:Exp=Param_2` with its range scaled by the
 * `Exp`; the dialogue level and lift are a bare `Param_1` (`Range 0,3,1`) and needed their own reader
 * until this one read both (audit 2026-09-29, D18). The ids are per block — a zone block can define a
 * `System` path (RX-A2060 Zone 2: `System,Sound_Video,HDMI,Output,OUT_2`).
 *
 * @param xml the desc.xml body
 * @returns element → command path → what the command takes
 */
export function descriptorPuts(xml: string): Record<string, Record<string, XmlDeclaredPut>> {
  const puts: Record<string, Record<string, XmlDeclaredPut>> = {};
  // Block boundaries: every `YNC_Tag` menu, and the text before the first one (an excerpt).
  const bounds = [0, ...[...xml.matchAll(/<Menu [^>]*YNC_Tag="[^"]+"/g)].map(match => match.index), xml.length];
  for (let index = 0; index + 1 < bounds.length; index++) {
    const block = xml.slice(bounds[index], bounds[index + 1]);
    const defines = new Map<string, XmlDeclaredPut>();
    for (const define of block.matchAll(/<Define ID="(P\d+)">\s*([A-Za-z_0-9]+),([^<]+?)\s*<\/Define>/g)) {
      const declared: XmlDeclaredPut = {};
      (puts[define[2]] ??= {})[define[3]] = declared;
      defines.set(define[1], declared);
    }
    for (const put of block.matchAll(/<Put_1[^>]*\sID="(P\d+)"[^>]*>([^<]*)<\/Put_1>/g)) {
      const declared = defines.get(put[1]);
      // A key the receiver marks `Assigned="No"` (RX-A2060 Zone 2: On Screen, Top Menu, Menu, Display) is listed but
      // does nothing there — desc.xml decides, so it is not offered (krobi 2026-10-05).
      if (declared && !/\sAssigned="No"/.test(put[0])) {
        (declared.words ??= []).push(decodeXmlText(put[2]));
      }
    }
    for (const put of block.matchAll(/<Put_2>([\s\S]*?)<\/Put_2>/g)) {
      const cmd = /<Cmd[^>]*ID="(P\d+)"[^>]*>\s*(Val=Param_1:Exp=Param_2[^<]*|Param_1)\s*<\/Cmd>/.exec(put[1]);
      const range = /<Param_1>\s*<Range>(-?\d+),(-?\d+),(\d+)<\/Range>/.exec(put[1]);
      const declared = cmd ? defines.get(cmd[1]) : undefined;
      if (!declared || !range) {
        continue;
      }
      const exp = cmd![2] === "Param_1" ? "0" : /<Param_2>\s*<Direct>(\d+)<\/Direct>/.exec(put[1])?.[1];
      if (exp !== undefined) {
        const scale = 10 ** Number(exp);
        declared.range = {
          min: Number(range[1]) / scale,
          max: Number(range[2]) / scale,
          step: Number(range[3]) / scale,
        };
      }
    }
  }
  return puts;
}

/** The enumerations and ranges a classic receiver declares in its device description (`desc.xml`). */
export interface XmlDescriptor {
  /** `Surround,Program_Sel,Current,Sound_Program` — the SOUNDPRG spelling of Yamaha's lists. */
  programs: string[];
  /** `Power_Control,Sleep` — "Off", "30 min" … "120 min" (the 2008 generation's "30" … "120" in that spelling). */
  sleep: string[];
  /** `Sound_Video,Adaptive_DRC` — Auto/Off. */
  adaptiveDrc: string[];
  /** The zone elements with `Play_Control,Playback` — transport keys per zone. */
  playbackZones?: string[];
  /** The zone elements with `Sound_Video,Tone,Manual,Bass` (see {@link XmlZoneForm}). */
  toneManualZones?: string[];
  /** The zone elements with `Surround,Current,Enhancer` (see {@link XmlZoneForm}). */
  enhancerCurrentZones?: string[];
  /**
   * Every write command it declares, per element and path (see {@link descriptorPuts}) — which
   * datapoints are writable, with which bounds. Empty where the description declares no command list.
   */
  puts?: Record<string, Record<string, XmlDeclaredPut>>;
  /**
   * The tuner's declared frequency grid per band, in kHz: `Tuning,Freq(,AM|,FM)` `<Range>` — EU
   * `531,1611,9` / `8750,10800,5` (Exp 2), US `530,1710,10` / `8750,10790,20` (D6).
   */
  tunerGrid?: { AM?: XmlRange; FM?: XmlRange };
}

/**
 * The band a frequency lies in, by its magnitude: AM below 2000 (kHz — the AM band ends at 1710 kHz, every FM band
 * starts above 76 MHz). The one classification for the declared ranges (where AM is counted in kHz and FM in
 * hundredths of a MHz, both far from the edge) and for a written frequency in kHz — a write took the band the tuner
 * last REPORTED instead, so a script that switched to FM and set 98.1 MHz right after tuned `AM 1710` (review
 * 2026-10-05, A20).
 *
 * @param value the frequency (kHz), or a declared range's upper end in the description's own unit
 * @returns the band
 */
export function tunerBandOf(value: number): "AM" | "FM" {
  return value < 2000 ? "AM" : "FM";
}

/**
 * The tuner's declared frequency grid (see {@link XmlDescriptor.tunerGrid}): every `<Range>` of a
 * `Tuning,Freq` reading, classified by magnitude ({@link tunerBandOf}) — AM in kHz, FM in hundredths of a MHz.
 *
 * @param xml the desc.xml body
 * @returns the grid per band, in kHz
 */
function tunerGridOf(xml: string): { AM?: XmlRange; FM?: XmlRange } | undefined {
  const grid: { AM?: XmlRange; FM?: XmlRange } = {};
  const blocks = xml.matchAll(/Tuning,Freq[^<]*Val=Param_1[^<]*<\/Cmd>\s*<Param_1>([\s\S]*?)<\/Param_1>/g);
  for (const block of blocks) {
    for (const range of block[1].matchAll(/<Range>(-?\d+),(-?\d+),(\d+)<\/Range>/g)) {
      const [min, max, step] = [Number(range[1]), Number(range[2]), Number(range[3])];
      if (tunerBandOf(max) === "AM") {
        grid.AM ??= { min, max, step };
      } else {
        grid.FM ??= { min: min * 10, max: max * 10, step: step * 10 };
      }
    }
  }
  return grid.AM || grid.FM ? grid : undefined;
}

/**
 * The zone elements that declare a write command, in document order.
 *
 * @param puts the declared write commands (see {@link descriptorPuts})
 * @param path the command path after the zone element
 * @returns the zone elements declaring it
 */
function zonesDeclaring(puts: Record<string, Record<string, XmlDeclaredPut>>, path: string): string[] {
  return Object.keys(puts).filter(element => /^(Main_Zone|Zone_[234])$/.test(element) && puts[element][path]);
}

/** One zone-wide pad command as desc.xml declares it: its path after the zone element, and its declared words. */
export interface XmlPadCommand {
  /** The command path (`Cursor_Control,Cursor`, or the 2012 entry class's `List_Control,Cursor`). */
  path: string;
  /** The wire words declared for it (`Up` … `Return to Home`); empty where the description names the path only. */
  words: string[];
}

/** A zone's pad as desc.xml declares it: the cursor keys and the menu keys, each where declared. */
export interface XmlZonePad {
  /** The cursor keys. */
  cursor?: XmlPadCommand;
  /** The menu keys. */
  menu?: XmlPadCommand;
}

/**
 * The zone-wide pad desc.xml declares for one zone element. Two declared forms: `Cursor_Control,Cursor` /
 * `Menu_Control` (7 of the 10 captured descriptors) and `List_Control,Cursor` / `Menu_Control` of the 2012 entry
 * class (RX-V473: the cross with Return and Return to Home, and only On Screen/Option/Display as menu keys). Only the
 * first was read, and a test called the second "menu-bound" on purpose — against the rule that desc.xml decides
 * (review 2026-10-05, decision C3). The words are the zone's own; where its block declares the path without words
 * (RX-V675 zone 2), the same command's words on the main zone.
 *
 * @param puts the declared write commands (see {@link descriptorPuts})
 * @param element the zone element
 * @returns the pad, empty where the zone declares none
 */
export function zonePad(puts: Record<string, Record<string, XmlDeclaredPut>>, element: string): XmlZonePad {
  const command = (key: "Cursor" | "Menu_Control"): XmlPadCommand | undefined => {
    const path = [`Cursor_Control,${key}`, `List_Control,${key}`].find(candidate => puts[element]?.[candidate]);
    if (path === undefined) {
      return undefined;
    }
    return { path, words: puts[element][path].words ?? puts.Main_Zone?.[path]?.words ?? [] };
  };
  const cursor = command("Cursor");
  const menu = command("Menu_Control");
  return { ...(cursor ? { cursor } : {}), ...(menu ? { menu } : {}) };
}

/**
 * A pad key on the wire in its declared path: `Cursor_Control,Cursor` + `Up` →
 * `<Cursor_Control><Cursor>Up</Cursor></Cursor_Control>`.
 *
 * @param path the declared command path
 * @param word the wire word
 * @returns the inner XML
 */
export function padInner(path: string, word: string): string {
  return path.split(",").reduceRight((inner, element) => `<${element}>${inner}</${element}>`, escapeXmlText(word));
}

/**
 * The `<Direct>` values of one command's first parameter in desc.xml. The command text is matched
 * as the whole `<Cmd>` content (`…=Param_1`); the zone lives in the `Cmd_List` defines, not in the
 * command text, so the first block found is the main zone's. Ranges come from {@link descriptorPuts}.
 *
 * @param xml the device description
 * @param command the command path (`Power_Control,Sleep`)
 * @returns the values
 */
function descriptorParam(xml: string, command: string): { values: string[] } {
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
  return { values };
}

/**
 * A sleep step in the one spelling every protocol shows: `Off`, `30 min` … `120 min`. The 2008 generation (RX-V3900)
 * says `30` … `120` on the wire; its datapoint looked different from every other receiver's (Werkbank parity
 * finding, accepted 2026-10-05, Y-30).
 *
 * @param word the step as the device wrote it
 * @returns the step in the shared spelling
 */
export function sleepStep(word: string): string {
  const text = word.trim();
  return /^\d+$/.test(text) ? `${Number(text)} min` : text;
}

/**
 * A sleep step in the spelling the device takes: the 2008 generation takes `30`, every later one `30 min`.
 *
 * @param value the written step (`Off`, `30 min`)
 * @param dialect the spelling the device answers with
 * @returns the wire word
 */
export function sleepWire(value: unknown, dialect?: XmlDialect): string {
  const text = String(value).trim();
  const minutes = /^(\d+) min$/.exec(text);
  return dialect === "legacy" && minutes ? minutes[1] : text;
}

/**
 * The sleep steps a device declares, in the shared spelling and the shared order: `Off` first, then the minutes.
 *
 * @param words the steps as the device declares them
 * @returns the steps
 */
function sleepSteps(words: readonly string[]): string[] {
  const minutesOf = (step: string): number => (step === "Off" ? 0 : parseInt(step, 10));
  return words.map(sleepStep).sort((a, b) => minutesOf(a) - minutesOf(b));
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
    sleep: sleepSteps(descriptorParam(xml, "Power_Control,Sleep").values),
    adaptiveDrc: descriptorParam(xml, "Sound_Video,Adaptive_DRC").values,
  };
  const puts = descriptorPuts(xml);
  descriptor.playbackZones = zonesDeclaring(puts, "Play_Control,Playback");
  descriptor.toneManualZones = zonesDeclaring(puts, "Sound_Video,Tone,Manual,Bass");
  descriptor.enhancerCurrentZones = zonesDeclaring(puts, "Surround,Current,Enhancer");
  descriptor.puts = puts;
  const tunerGrid = tunerGridOf(xml);
  if (tunerGrid) {
    descriptor.tunerGrid = tunerGrid;
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
  /** Adaptive DRC on ("Auto") or off. */
  adaptiveDrc?: boolean;
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
  /** DTS dialogue control (`Sound_Video,Dialogue_Adjust,DTS_Dialogue_Control`, RX-A2060, TSR-5810). */
  dtsDialogueControl?: number;
  /** Compressed Music Enhancer (`Surround,Program_Sel,Current,Enhancer`, 9 of 10 descriptors). */
  enhancer?: boolean;
  /** The tone-control mode (`Tone,Mode` — Auto/Manual/Bypass; RX-A2060 zones, the 2020 generation). */
  toneMode?: string;
  /** Which command form the zone's status shows (see {@link XmlZoneForm}); learned where no desc.xml says it. */
  zoneForm?: XmlZoneForm;
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
    status.adaptiveDrc = adaptiveDrc[1] === "Auto";
  }
  // A bare number (HTR-4069 `<Dialogue_Lvl>1</Dialogue_Lvl>`, RX-V6A `…>0<…`); the `<Val>` form the
  // parser expected exists on no device and in no desc.xml — the level was never read (audit
  // 2026-09-24, D9).
  const dialogueLevel = /<Dialogue_Lvl>\s*(-?\d+)\s*<\/Dialogue_Lvl>/.exec(xml);
  if (dialogueLevel) {
    status.dialogueLevel = Number(dialogueLevel[1]);
  }
  const sleepMatch = /<Sleep>([^<]+)<\/Sleep>/.exec(xml);
  if (sleepMatch) {
    status.sleep = sleepStep(decodeXmlText(sleepMatch[1]));
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
  // The RX-A2060 reports `OUT_n_Info` (On/Off/Unavailable) where the older models report `OUT_n`;
  // `Unavailable` says the output cannot be switched now — no value (audit 2026-09-29, D10).
  const hdmiOut1 = /<OUT_1(?:_Info)?>(On|Off)<\/OUT_1(?:_Info)?>/.exec(xml);
  if (hdmiOut1) {
    status.hdmiOut1 = hdmiOut1[1] === "On";
  }
  const hdmiOut2 = /<OUT_2(?:_Info)?>(On|Off)<\/OUT_2(?:_Info)?>/.exec(xml);
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
  const toneMode = /<Tone>\s*<Mode>([^<]+)<\/Mode>/.exec(xml);
  if (toneMode) {
    status.toneMode = decodeXmlText(toneMode[1]);
  }
  const form: XmlZoneForm = {
    ...(/<Tone>\s*(?:<Mode>[^<]*<\/Mode>\s*)?<Manual>/.test(xml) ? { toneManual: true } : {}),
    ...(/<Surround>\s*<Current>\s*<Enhancer>/.test(xml) ? { enhancerCurrent: true } : {}),
  };
  if (form.toneManual || form.enhancerCurrent) {
    status.zoneForm = form;
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
  const dts = /<DTS_Dialogue_Control>\s*(-?\d+)\s*<\/DTS_Dialogue_Control>/.exec(xml);
  if (dts) {
    status.dtsDialogueControl = Number(dts[1]);
  }
  return status;
}
