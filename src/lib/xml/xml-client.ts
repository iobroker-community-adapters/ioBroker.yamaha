import { request, type IncomingMessage } from "node:http";
import {
  assertXmlOk,
  encodeGet,
  encodePut,
  parseBasicStatus,
  parseSystemConfig,
  type BasicStatus,
  type XmlSystemConfig,
} from "./protocol";
import type { CommandGate, CommandPriority } from "../lifecycle/command-gate";
import { readDeviceResponse } from "../util";
import { localAddressOption } from "../source-address";

/** The receiver's XML control endpoint. */
const CONTROL_PATH = "/YamahaRemoteControl/ctrl";
/** Per-request timeout so an unreachable device fails fast. */
const REQUEST_TIMEOUT_MS = 5000;

/** Posts an XML body to a device and resolves with the response body (a seam for testing). */
export type XmlPoster = (ip: string, body: string) => Promise<string>;

/** GETs a plain path from a device (the device description) and resolves with the body (a seam for testing). */
export type XmlGetter = (ip: string, path: string) => Promise<string>;

/** The receiver's device description — a plain file next to the control endpoint. */
const DESCRIPTOR_PATH = "/YamahaRemoteControl/desc.xml";

/**
 * Settle a request with the device's answer: the body of a 2xx, or the device's verdict — the firmware
 * answers a request for an unknown node with a BODYLESS HTTP 400 and a missing device description with a
 * 404 (captured RX-V6A behaviour). Those are device verdicts, not transport noise, and they reach the
 * caller as `HttpStatusError` instead of masquerading as an empty success; the status travels with
 * the error so a per-device probe can tell the permanent "no such node" from a transient failure.
 *
 * @param res the response
 * @param resolve resolves the request with the body
 * @param reject rejects the request
 */
function readResponse(res: IncomingMessage, resolve: (body: string) => void, reject: (e: Error) => void): void {
  readDeviceResponse(res, "the request").then(resolve, reject);
}

/**
 * Default poster backed by node:http — POSTs to the device's control endpoint on port 80.
 *
 * @param ip the device IP
 * @param payload the XML request body
 * @returns the response body
 */
export function defaultPoster(ip: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Content-Length, not chunked: without a length header node streams the body with
    // `Transfer-Encoding: chunked`, and the 2000s-era firmware this transport exists for
    // is not reliably able to read that. EVERY reference for this path sends a length —
    // the predecessor adapter through the `request` library, rxv through python-requests,
    // the openHAB binding through its HTTP client. We were the only one that did not.
    const body = Buffer.from(payload, "utf8");
    const req = request(
      {
        host: ip,
        port: 80,
        ...localAddressOption(),
        path: CONTROL_PATH,
        method: "POST",
        timeout: REQUEST_TIMEOUT_MS,
        headers: { "Content-Type": "text/xml; charset=utf-8", "Content-Length": body.length },
      },
      res => readResponse(res, resolve, reject),
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("XML request timeout")));
    req.end(body);
  });
}

/**
 * Default getter backed by node:http — a plain GET of a file on the device's port 80.
 *
 * @param ip the device IP
 * @param path the path to fetch
 * @returns the response body
 */
export function defaultGetter(ip: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: ip, port: 80, ...localAddressOption(), path, method: "GET", timeout: REQUEST_TIMEOUT_MS },
      res => readResponse(res, resolve, reject),
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("XML request timeout")));
    req.end();
  });
}

/** An XML/YNC transport client for one receiver over HTTP (port 80). */
export class XmlClient {
  private readonly request: (ip: string, body: string, priority?: CommandPriority) => Promise<string>;
  private readonly fetch: XmlGetter;

  /**
   * @param ip the receiver IP
   * @param post the XML poster (defaults to a node:http POST)
   * @param gate the device's command gate — when given, every request runs through it, so
   *   these embedded 2008+ HTTP stacks never face parallel requests and a stopped adapter
   *   cancels what is still queued
   * @param get the plain-file getter for the device description (defaults to a node:http GET)
   */
  public constructor(
    private readonly ip: string,
    post: XmlPoster = defaultPoster,
    gate?: CommandGate,
    get: XmlGetter = defaultGetter,
  ) {
    // A command is the user's; a read is background work — unless the caller says it reads back what the user just
    // wrote: that read must not wait behind a poll sweep (review 2026-10-05, A58).
    this.request = gate
      ? (ip_, body, priority) =>
          gate.run(() => post(ip_, body), priority ?? (body.includes('cmd="PUT"') ? "user" : "background"))
      : (ip_, body) => post(ip_, body);
    this.fetch = gate ? (ip_, path) => gate.run(() => get(ip_, path), "background") : get;
  }

  /**
   * Read the device description (`/YamahaRemoteControl/desc.xml`) — the classic generation's
   * own enumeration of programs, sleep steps, value lists and ranges (2008–2017). A model without
   * one answers HTTP 404, which travels as a permanent `HttpStatusError`.
   *
   * @returns the raw description body
   */
  public getDescriptor(): Promise<string> {
    return this.fetch(this.ip, DESCRIPTOR_PATH);
  }

  /**
   * Send a zone command (wrapped in a PUT envelope). Throws when the device refuses
   * it — the response's return code IS the device saying "I did not do that", and
   * swallowing it left every refused write invisible (#613/#615).
   *
   * @param zone the zone element (e.g. `Main_Zone`)
   * @param inner the inner command XML
   */
  public async send(zone: string, inner: string): Promise<void> {
    assertXmlOk(await this.request(this.ip, encodePut(zone, inner)), `<${zone}>${inner}`);
  }

  /**
   * Read a zone's Basic_Status. A refusal throws — an absent zone must not look
   * like a present zone with an empty status.
   *
   * @param zone the zone element (e.g. `Main_Zone`)
   * @param priority the gate priority — `user` for the read-back of a user's write; background by default
   * @returns the parsed amplifier fields
   */
  public async getStatus(zone: string, priority?: CommandPriority): Promise<BasicStatus> {
    const response = await this.request(this.ip, encodeGet(zone, "<Basic_Status>GetParam</Basic_Status>"), priority);
    return parseBasicStatus(assertXmlOk(response, `<${zone}> Basic_Status`));
  }

  /**
   * Read the device's declaration of itself (System > Config): model, system id, firmware, the
   * zones and sources it has (`Feature_Existence`) and its input names. A refusal throws like
   * every other read.
   *
   * @returns the parsed declaration (empty when the device answers nothing about itself)
   */
  public async getSystemConfig(): Promise<XmlSystemConfig> {
    const response = await this.request(this.ip, encodeGet("System", "<Config>GetParam</Config>"));
    return parseSystemConfig(assertXmlOk(response, "<System> Config"));
  }

  /**
   * Read an element's inner GET request and return the raw response body — the
   * browse driver reads the menu lists (`List_Info`/`List_Info_2`) from source elements
   * with it.
   *
   * @param element the XML element (a zone or a source)
   * @param inner the inner request XML
   * @param priority the gate priority — `user` for the read-back of a user's write or a menu step; background by
   *   default
   * @returns the raw response body
   */
  public getXml(element: string, inner: string, priority?: CommandPriority): Promise<string> {
    return this.request(this.ip, encodeGet(element, inner), priority);
  }
}
