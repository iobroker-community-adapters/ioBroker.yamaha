import { XML_BROWSE_SOURCES } from "../browse/xml-browse-driver";
import { ZONES } from "../catalog/zones";
import { errText } from "../err-text";
import { HttpStatusError } from "../util";
import { descriptorPuts, parseSystemConfig } from "../xml/protocol";
import { availGets, sweepGets, YNCA_CATALOG } from "../ynca/catalog";
import { decodeLine } from "../ynca/protocol";
import { parseYxcFeatures } from "../yxc/capability";
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

/** One YNCA read: the functions it asked, and whether it ran to its closing marker. */
interface YncaBatch {
  gets: ReadonlyArray<{ subunit: string; func: string }>;
  complete: boolean;
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
  const batches: YncaBatch[] = [];
  const read = async (gets: ReadonlyArray<{ subunit: string; func: string }>): Promise<string[]> => {
    // Recorded before the wait: a read that throws counts as one that did not reach its end.
    const batch: YncaBatch = { gets, complete: false };
    batches.push(batch);
    const result = await client.capture(gets);
    lines.push(...result.lines);
    batch.complete = result.complete;
    return result.lines;
  };
  let error: string | undefined;
  try {
    const probe = await read(availGets(YNCA_CATALOG));
    // Asked even when the probe's closing marker came late: a slow answer is no drop, and a dropped
    // connection ends the second read at once.
    await read(targetedGets(probe));
  } catch (e) {
    error = errText(e);
  }
  return yncaCapture(started, lines, batches, error);
}

/**
 * The functions to read after the AVAIL probe: every catalogued one of the subunits that answered
 * AVAIL, plus SYS — or all of them when no subunit answered (a firmware without AVAIL loses nothing).
 * Only an AVAIL answer counts as presence; the closing marker's `@SYS:VERSION` is no proof of
 * anything (the read-in's dead blind-sweep fallback, review 2026-10-05, A1).
 *
 * @param probe the lines the AVAIL probe received
 * @returns the functions to read
 */
function targetedGets(probe: readonly string[]): Array<{ subunit: string; func: string }> {
  const present = new Set<string>();
  for (const line of probe) {
    const decoded = decodeLine(line);
    if (decoded.status === "ok" && decoded.func === "AVAIL") {
      present.add(decoded.subunit);
    }
  }
  const all = sweepGets(YNCA_CATALOG);
  return present.size > 0 ? all.filter(get => get.subunit === "SYS" || present.has(get.subunit)) : all;
}

/**
 * Assemble the YNCA capture from the received lines. A read that did not reach its closing marker
 * (a drop, a closed connection, a device that went silent) counts every function it got no value for
 * as failed — whether the device would have refused it cannot be told any more.
 *
 * @param started when the read started (ms)
 * @param lines the received lines
 * @param batches the reads, in order
 * @param thrown the failure that ended the read, if one threw
 * @returns the capture
 */
function yncaCapture(
  started: number,
  lines: string[],
  batches: readonly YncaBatch[],
  thrown: string | undefined,
): TransportCapture {
  const answers: Record<string, string> = {};
  for (const line of lines) {
    const decoded = decodeLine(line);
    if (decoded.status === "ok") {
      answers[`${decoded.subunit}:${decoded.func}`] = decoded.value;
    }
  }
  const keysOf = (gets: YncaBatch["gets"]): string[] => [...new Set(gets.map(get => `${get.subunit}:${get.func}`))];
  const unanswered = keysOf(batches.flatMap(batch => batch.gets)).filter(key => !(key in answers));
  const failed = batches
    .filter(batch => !batch.complete)
    .reduce((sum, batch) => sum + keysOf(batch.gets).filter(key => !(key in answers)).length, 0);
  const complete = thrown === undefined && batches.length > 0 && batches.every(batch => batch.complete);
  return {
    transport: "ynca",
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    complete,
    asked: batches.reduce((sum, batch) => sum + batch.gets.length, 0),
    failed,
    answers,
    lines,
    unanswered,
    ...(complete
      ? {}
      : {
          error:
            thrown ??
            "the read ended before the device confirmed its end — the connection dropped or the device stopped answering",
        }),
  };
}

/**
 * After this many transport failures in a row the device is taken as gone and the rest is not asked:
 * every further question would only wait for its timeout (4–5 s each), and the report of a receiver
 * that lost its power would take minutes.
 */
const GONE_AFTER_FAILURES = 3;

/**
 * What a failed request says about the device: its own verdict — a MusicCast refusal (`response_code`),
 * an HTTP status (an XML firmware answers an unknown node with a bodyless 400), a body that is not JSON —
 * or nothing, when no answer came at all (a timeout, a refused or reset connection, a closed gate). Only
 * the latter is a transport failure.
 *
 * @param e the failure
 * @returns the verdict as the capture keeps it, or undefined for a transport failure
 */
function verdictOf(e: unknown): Record<string, unknown> | undefined {
  if (e instanceof YxcRefusalError) {
    return { response_code: e.code };
  }
  if (e instanceof HttpStatusError) {
    return { httpStatus: e.statusCode };
  }
  if (e instanceof SyntaxError) {
    return { invalidBody: errText(e) };
  }
  return undefined;
}

/**
 * The bookkeeping of one HTTP capture (MusicCast and XML alike): every question is put, its answer — or
 * the device's verdict — kept under the fixture key, a transport failure kept as `{ error }` and counted.
 * The read is complete when every question was put and none failed in transport: the same meaning the
 * YNCA capture gives the word (review 2026-10-05, B5 — it used to mean "anything answered").
 */
class HttpCapture {
  /** The answers, keyed like the inventory fixtures. */
  public readonly answers: Record<string, unknown> = {};
  private readonly started = Date.now();
  private asked = 0;
  private failed = 0;
  private inARow = 0;
  /** Questions not put because the device had stopped answering. */
  private skipped = 0;
  private firstError: string | undefined;

  /**
   * Ask one question — unless the device is gone (see {@link GONE_AFTER_FAILURES}).
   *
   * @param key the fixture key the answer is kept under; undefined keeps it out of `answers` (the XML
   *   description has a field of its own)
   * @param request sends the question
   * @returns the answer, or undefined when there is none to use (a verdict, a failure, not asked)
   */
  public async ask<T>(key: string | undefined, request: () => Promise<T>): Promise<T | undefined> {
    if (this.inARow >= GONE_AFTER_FAILURES) {
      this.skipped++;
      return undefined;
    }
    this.asked++;
    const keep = (value: unknown): void => {
      if (key !== undefined) {
        this.answers[key] = value;
      }
    };
    try {
      const answer = await request();
      keep(answer);
      this.inARow = 0;
      return answer;
    } catch (e) {
      const verdict = verdictOf(e);
      if (verdict) {
        keep(verdict);
        this.inARow = 0;
      } else {
        keep({ error: errText(e) });
        this.failed++;
        this.inARow++;
        this.firstError ??= errText(e);
      }
      return undefined;
    }
  }

  /**
   * The capture.
   *
   * @param transport the protocol read
   * @param extra transport-specific fields
   * @returns the capture
   */
  public result(transport: TransportCapture["transport"], extra: Partial<TransportCapture> = {}): TransportCapture {
    return {
      transport,
      startedAt: new Date(this.started).toISOString(),
      durationMs: Date.now() - this.started,
      complete: this.failed === 0,
      asked: this.asked,
      failed: this.failed,
      answers: this.answers,
      ...extra,
      ...(this.firstError === undefined
        ? {}
        : {
            error:
              this.skipped > 0
                ? `${this.firstError} — the device stopped answering, ${this.skipped} more question(s) not asked`
                : this.firstError,
          }),
    };
  }
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
 * declares, and the tuner presets of each band it declares — `getFeatures` read by the adapter's own
 * parser (`parseYxcFeatures`), which also survives a malformed answer. A refusal is kept as the device's
 * own answer (`response_code`), a failure as `error`.
 *
 * @param client the device's MusicCast client (its gate serialises the requests)
 * @returns the capture
 */
export async function captureYxc(client: YxcCaptureClient): Promise<TransportCapture> {
  const capture = new HttpCapture();
  const ask = (path: string): Promise<unknown> => capture.ask(path.replace(/^\//, ""), () => client.read(path));
  for (const path of YXC_SYSTEM_READS) {
    await ask(path);
  }
  const features = parseYxcFeatures(capture.answers["system/getFeatures"]);
  const zones = features.zones.map(zone => zone.id);
  for (const zone of zones.length > 0 ? zones : ["main"]) {
    for (const read of YXC_ZONE_READS) {
      await ask(`/${encodeURIComponent(zone)}/${read}`);
    }
  }
  // One list for every band (`common`), or one per band the tuner offers (YXC Basic §8.5).
  const tuner = features.tuner;
  for (const band of !tuner ? [] : tuner.presetType === "common" ? ["common"] : tuner.bands) {
    await ask(`/tuner/getPresetInfo?band=${band}`);
  }
  return capture.result("yxc");
}

/**
 * The GET body of a node path in the notation desc.xml uses: `Play_Control,Preset,Preset_Sel_Item` →
 * `<Play_Control><Preset><Preset_Sel_Item>GetParam</Preset_Sel_Item></Preset></Play_Control>`.
 *
 * @param path the node path, comma separated
 * @returns the inner GET request
 */
function getParam(path: string): string {
  const nodes = path.split(",");
  return `${nodes.map(node => `<${node}>`).join("")}GetParam${[...nodes]
    .reverse()
    .map(node => `</${node}>`)
    .join("")}`;
}

/** The System reads of the XML API: what the receiver declares about itself. */
const XML_SYSTEM_READS = ["Config", "Power_Control,Power", "Party_Mode,Mode", "Unit_Desc", "Misc,Network,Info"];

/** The zone reads of the XML API. */
const XML_ZONE_READS = ["Basic_Status", "Config", "Input,Input_Sel_Item", "Scene,Scene_Sel_Item"];

/** The reads of every source element. */
const XML_SOURCE_READS = ["Config", "Play_Info"];

/** The tuner's preset list. */
const XML_TUNER_PRESETS = "Play_Control,Preset,Preset_Sel_Item";

/** The 2008 generation's zone name — asked where the description declares it, as the adapter does (RX-V3900). */
const XML_RENAME = "Rename,Rename_Latin_1";

/** The sources a 2008 receiver may have — it declares no `Feature_Existence`. */
const XML_LEGACY_SOURCES = ["Tuner", "NET_USB", "iPod", "XM", "Rhapsody", "SIRIUS"] as const;

/**
 * Read the XML API: the device description, the System block, and per zone and source the reads the
 * adapter itself uses (status, config, input and scene lists, the 2008 zone name, Play_Info, the menu
 * list). Which zones and sources exist comes from the device's own `Feature_Existence`, read by the
 * adapter's parser (`parseSystemConfig`), and the zones are the ones the adapter probes: every zone not
 * flagged 0 — all of them when the block is missing (2008) or flags the main zone 0. A 2008 receiver is
 * asked for the sources of its generation; the tuner and the menu sources are asked on every receiver,
 * as the adapter does. GET only.
 *
 * @param client the device's XML client (its gate serialises the requests)
 * @returns the capture
 */
export async function captureXml(client: XmlCaptureClient): Promise<TransportCapture> {
  const capture = new HttpCapture();
  const ask = (element: string, path: string): Promise<string | undefined> =>
    capture.ask(`${element}/${path.split(",")[0]}`, () => client.getXml(element, getParam(path)));
  // A model without a description answers 404 — the adapter's own reading of that is "none".
  const descriptor = (await capture.ask(undefined, () => client.getDescriptor())) ?? null;
  for (const path of XML_SYSTEM_READS) {
    await ask("System", path);
  }
  const config = capture.answers["System/Config"];
  const declared = parseSystemConfig(typeof config === "string" ? config : "");
  const flags = declared.zones;
  const zones = flags && flags.Main_Zone !== false ? ZONES.filter(zone => flags[zone.xml] !== false) : ZONES;
  const sources =
    declared.features === undefined
      ? XML_LEGACY_SOURCES
      : Object.entries(declared.features)
          .filter(([, on]) => on)
          .map(([element]) => element);
  // What the device declares, plus what the adapter asks regardless (the tuner and the menu sources it
  // probes on every receiver) — a refusal there is a finding too.
  const elements = new Set([
    ...zones.map(zone => zone.xml),
    ...sources,
    "Tuner",
    ...XML_BROWSE_SOURCES.map(source => source.element),
  ]);
  const puts = descriptor ? descriptorPuts(descriptor) : {};
  for (const element of elements) {
    if (ZONES.some(zone => zone.xml === element)) {
      for (const path of XML_ZONE_READS) {
        await ask(element, path);
      }
      if (puts[element]?.[XML_RENAME]) {
        await ask(element, XML_RENAME);
      }
      continue;
    }
    for (const path of XML_SOURCE_READS) {
      await ask(element, path);
    }
    if (element === "Tuner") {
      await ask(element, XML_TUNER_PRESETS);
    }
    for (const list of new Set(XML_BROWSE_SOURCES.filter(s => s.element === element).map(s => s.list))) {
      await ask(element, list);
    }
  }
  return capture.result("xml", { descriptor });
}
