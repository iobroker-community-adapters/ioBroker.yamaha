import { XML_BROWSE_SOURCES } from "../browse/xml-browse-driver";
import { errText } from "../err-text";
import { availGets, sweepGets, YNCA_CATALOG } from "../ynca/catalog";
import { decodeLine } from "../ynca/protocol";
import { YxcRefusalError } from "../yxc/http-client";
import type { TransportCapture } from "./types";

/** The YNCA client surface a capture needs. */
export interface YncaCaptureClient {
  /** Read functions, keeping every received line. */
  capture(gets: ReadonlyArray<{ subunit: string; func: string }>): Promise<{ lines: string[]; complete: boolean }>;
}

/** The MusicCast client surface a capture needs. */
export interface YxcCaptureClient {
  /** Read one endpoint (reads only). */
  read(path: string): Promise<unknown>;
}

/** The XML client surface a capture needs. */
export interface XmlCaptureClient {
  /** Read the device description. */
  getDescriptor(): Promise<string>;
  /** Send one GET and return the raw body. */
  getXml(element: string, inner: string): Promise<string>;
}

/**
 * Read the YNCA functions the adapter knows, the way the read-in does: first `AVAIL=?` per subunit,
 * then every catalogued function of the subunits that answered, plus SYS (which never answers
 * AVAIL). A device that answers no AVAIL at all is read in full. Read only — `=?` changes nothing.
 *
 * @param client the device's YNCA client (its gate paces the lines)
 * @returns the capture
 */
export async function captureYnca(client: YncaCaptureClient): Promise<TransportCapture> {
  const started = Date.now();
  const lines: string[] = [];
  let complete = true;
  let asked = 0;
  try {
    const probe = availGets(YNCA_CATALOG);
    const first = await client.capture(probe);
    asked += probe.length;
    lines.push(...first.lines);
    complete = first.complete;
    const present = new Set<string>(["SYS"]);
    for (const line of first.lines) {
      const decoded = decodeLine(line);
      if (decoded.status === "ok" && decoded.func === "AVAIL") {
        present.add(decoded.subunit);
      }
    }
    const all = sweepGets(YNCA_CATALOG);
    const gets = present.size > 1 ? all.filter(get => present.has(get.subunit)) : all;
    // Asked even when the probe's closing marker came late: a slow answer is no drop, and a dropped
    // connection ends the second read at once.
    const second = await client.capture(gets);
    asked += gets.length;
    lines.push(...second.lines);
    complete = complete && second.complete;
    return yncaCapture(started, complete, asked, lines, [...probe, ...gets]);
  } catch (e) {
    return { ...yncaCapture(started, false, asked, lines, []), error: errText(e) };
  }
}

/**
 * Assemble the YNCA capture from the received lines.
 *
 * @param started when the read started (ms)
 * @param complete whether it ran to its end
 * @param asked how many lines were asked
 * @param lines the received lines
 * @param gets every function asked
 * @returns the capture
 */
function yncaCapture(
  started: number,
  complete: boolean,
  asked: number,
  lines: string[],
  gets: ReadonlyArray<{ subunit: string; func: string }>,
): TransportCapture {
  const answers: Record<string, string> = {};
  for (const line of lines) {
    const decoded = decodeLine(line);
    if (decoded.status === "ok") {
      answers[`${decoded.subunit}:${decoded.func}`] = decoded.value;
    }
  }
  const unanswered = [...new Set(gets.map(get => `${get.subunit}:${get.func}`))].filter(key => !(key in answers));
  return {
    transport: "ynca",
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    complete,
    asked,
    answers,
    lines,
    unanswered,
  };
}

/** The device-wide MusicCast reads — every `get` of the specification that takes no argument. */
const YXC_SYSTEM_READS = [
  "/system/getDeviceInfo",
  "/system/getFeatures",
  "/system/getNetworkStatus",
  "/system/getFuncStatus",
  "/system/getLocationInfo",
  "/system/getNameText",
  "/system/getStereoPairInfo",
  "/dist/getDistributionInfo",
  "/clock/getSettings",
  "/netusb/getPlayInfo",
  "/netusb/getPresetInfo",
  "/netusb/getRecentInfo",
  "/netusb/getSettings",
  "/netusb/getMcPlaylistName",
  "/netusb/getPlayQueue",
  "/tuner/getPlayInfo",
  "/cd/getPlayInfo",
] as const;

/** The per-zone MusicCast reads. */
const YXC_ZONE_READS = ["getStatus", "getSignalInfo", "getSoundProgramList"] as const;

/**
 * Read every MusicCast endpoint that only reports: the device-wide ones, each zone `getFeatures`
 * declares, and the tuner presets of each band it declares. A refusal is kept as the device's own
 * answer (`response_code`), a failure as `error`.
 *
 * @param client the device's MusicCast client (its gate serialises the requests)
 * @returns the capture
 */
export async function captureYxc(client: YxcCaptureClient): Promise<TransportCapture> {
  const started = Date.now();
  const answers: Record<string, unknown> = {};
  let asked = 0;
  const ask = async (path: string): Promise<unknown> => {
    asked++;
    const key = path.replace(/^\//, "");
    try {
      answers[key] = await client.read(path);
    } catch (e) {
      answers[key] = e instanceof YxcRefusalError ? { response_code: e.code } : { error: errText(e) };
    }
    return answers[key];
  };
  for (const path of YXC_SYSTEM_READS) {
    await ask(path);
  }
  const features = answers["system/getFeatures"] as
    { zone?: Array<{ id?: unknown }>; tuner?: { func_list?: unknown; preset?: { type?: unknown } } } | undefined;
  const zones = (features?.zone ?? []).map(zone => zone.id).filter((id): id is string => typeof id === "string");
  for (const zone of zones.length > 0 ? zones : ["main"]) {
    for (const read of YXC_ZONE_READS) {
      await ask(`/${encodeURIComponent(zone)}/${read}`);
    }
  }
  for (const band of tunerBands(features?.tuner)) {
    await ask(`/tuner/getPresetInfo?band=${band}`);
  }
  const reached = Object.values(answers).some(answer => !isFailure(answer));
  return {
    transport: "yxc",
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    complete: reached,
    asked,
    answers,
  };
}

/**
 * The preset bands to read: `common` when the device keeps one list for all bands, otherwise each
 * band its tuner lists (YXC Basic §8.5).
 *
 * @param tuner the tuner block of getFeatures
 * @returns the bands
 */
function tunerBands(tuner: { func_list?: unknown; preset?: { type?: unknown } } | undefined): string[] {
  if (!tuner) {
    return [];
  }
  if (tuner.preset?.type === "common") {
    return ["common"];
  }
  const list = Array.isArray(tuner.func_list) ? tuner.func_list : [];
  return ["am", "fm", "dab"].filter(band => list.includes(band));
}

/**
 * Whether a captured answer is a failure rather than a device answer.
 *
 * @param answer the captured answer
 * @returns true for `{ error }`
 */
function isFailure(answer: unknown): boolean {
  return typeof answer === "object" && answer !== null && "error" in answer;
}

/** The System reads of the XML API: what the receiver declares about itself. */
const XML_SYSTEM_READS: ReadonlyArray<readonly [string, string]> = [
  ["Config", "<Config>GetParam</Config>"],
  ["Power_Control", "<Power_Control><Power>GetParam</Power></Power_Control>"],
  ["Party_Mode", "<Party_Mode><Mode>GetParam</Mode></Party_Mode>"],
  ["Unit_Desc", "<Unit_Desc>GetParam</Unit_Desc>"],
  ["Misc", "<Misc><Network><Info>GetParam</Info></Network></Misc>"],
];

/** The zone reads of the XML API. */
const XML_ZONE_READS: ReadonlyArray<readonly [string, string]> = [
  ["Basic_Status", "<Basic_Status>GetParam</Basic_Status>"],
  ["Config", "<Config>GetParam</Config>"],
  ["Input", "<Input><Input_Sel_Item>GetParam</Input_Sel_Item></Input>"],
  ["Scene", "<Scene><Scene_Sel_Item>GetParam</Scene_Sel_Item></Scene>"],
];

/** The elements a 2008 receiver may have — it declares no `Feature_Existence`. */
const XML_LEGACY_ELEMENTS = ["Zone_2", "Tuner", "NET_USB", "iPod", "XM", "Rhapsody", "SIRIUS"] as const;

/**
 * Read the XML API: the device description, the System block, and per zone and source the reads the
 * adapter itself uses (status, config, input and scene lists, Play_Info, the menu list). Which zones
 * and sources exist comes from the device's own `Feature_Existence`; a 2008 receiver without one is
 * asked for the elements of its generation; the tuner and the menu sources are asked on every receiver,
 * as the adapter does. GET only.
 *
 * @param client the device's XML client (its gate serialises the requests)
 * @returns the capture
 */
export async function captureXml(client: XmlCaptureClient): Promise<TransportCapture> {
  const started = Date.now();
  const answers: Record<string, unknown> = {};
  let asked = 0;
  const ask = async (element: string, node: string, inner: string): Promise<string | undefined> => {
    asked++;
    const key = `${element}/${node}`;
    try {
      const body = await client.getXml(element, inner);
      answers[key] = body;
      return body;
    } catch (e) {
      answers[key] = { error: errText(e) };
      return undefined;
    }
  };
  let descriptor: string | null = null;
  asked++;
  try {
    descriptor = await client.getDescriptor();
  } catch {
    // A model without a description answers 404 — the adapter's own reading of that is "none".
    descriptor = null;
  }
  let config: string | undefined;
  for (const [node, inner] of XML_SYSTEM_READS) {
    const body = await ask("System", node, inner);
    if (node === "Config") {
      config = body;
    }
  }
  // What the device declares, plus what the adapter asks regardless (the tuner and the menu sources it
  // probes on every receiver) — a refusal there is a finding too.
  const declared = featureExistence(config);
  const elements = [
    ...new Set([
      "Main_Zone",
      ...(declared.size > 0 ? declared : XML_LEGACY_ELEMENTS),
      "Tuner",
      ...XML_BROWSE_SOURCES.map(source => source.element),
    ]),
  ];
  for (const element of elements) {
    if (/^(Main_Zone|Zone_\d)$/.test(element)) {
      for (const [node, inner] of XML_ZONE_READS) {
        await ask(element, node, inner);
      }
      continue;
    }
    await ask(element, "Config", "<Config>GetParam</Config>");
    await ask(element, "Play_Info", "<Play_Info>GetParam</Play_Info>");
    if (element === "Tuner") {
      await ask(
        element,
        "Play_Control",
        "<Play_Control><Preset><Preset_Sel_Item>GetParam</Preset_Sel_Item></Preset></Play_Control>",
      );
    }
    for (const list of new Set(XML_BROWSE_SOURCES.filter(s => s.element === element).map(s => s.list))) {
      await ask(element, list, `<${list}>GetParam</${list}>`);
    }
  }
  const reached = descriptor !== null || Object.values(answers).some(answer => typeof answer === "string");
  return {
    transport: "xml",
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    complete: reached,
    asked,
    answers,
    descriptor,
  };
}

/**
 * The elements a classic receiver declares as present (`<Feature_Existence>` flags set to 1).
 *
 * @param config the raw System/Config body
 * @returns the present elements, in the device's order
 */
export function featureExistence(config: string | undefined): Set<string> {
  const block = config ? /<Feature_Existence>([\s\S]*?)<\/Feature_Existence>/.exec(config)?.[1] : undefined;
  const present = new Set<string>();
  for (const match of (block ?? "").matchAll(/<([A-Za-z0-9_]+)>\s*1\s*<\/\1>/g)) {
    present.add(match[1]);
  }
  return present;
}
