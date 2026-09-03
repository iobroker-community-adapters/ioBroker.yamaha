import { request } from "node:http";
import {
  assertXmlOk,
  encodeGet,
  encodePut,
  parseBasicStatus,
  parseModelName,
  XmlHttpError,
  type BasicStatus,
} from "./protocol";
import type { CommandGate } from "../lifecycle/command-gate";
import { MAX_HTTP_BODY_BYTES } from "../util";

/** The receiver's XML control endpoint. */
const CONTROL_PATH = "/YamahaRemoteControl/ctrl";
/** Per-request timeout so an unreachable device fails fast. */
const REQUEST_TIMEOUT_MS = 5000;

/** Posts an XML body to a device and resolves with the response body (a seam for testing). */
export type XmlPoster = (ip: string, body: string) => Promise<string>;

/**
 * Default poster backed by node:http — POSTs to the device's control endpoint on port 80.
 *
 * @param ip the device IP
 * @param payload the XML request body
 * @returns the response body
 */
function defaultPoster(ip: string, payload: string): Promise<string> {
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
        path: CONTROL_PATH,
        method: "POST",
        timeout: REQUEST_TIMEOUT_MS,
        headers: { "Content-Type": "text/xml; charset=utf-8", "Content-Length": body.length },
      },
      res => {
        let data = "";
        let bytes = 0;
        res.on("data", chunk => {
          bytes += (chunk as Buffer).length;
          if (bytes > MAX_HTTP_BODY_BYTES) {
            // A Basic_Status or a menu window is a few KB — past the cap this is no
            // receiver answer but a stream that would grow memory without bound.
            res.destroy(new Error("XML response too large"));
            return;
          }
          data += String(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          // The firmware answers a request for an unknown node with a BODYLESS HTTP 400
          // (captured RX-V6A behaviour) — that is a device verdict, not transport noise,
          // and must reach the caller instead of masquerading as an empty success. The
          // status travels with the error so a per-device probe can tell this permanent
          // "no such node" from a transient failure.
          if (res.statusCode !== undefined && (res.statusCode < 200 || res.statusCode >= 300)) {
            reject(new XmlHttpError(`device refused the request (HTTP ${res.statusCode})`, res.statusCode));
            return;
          }
          resolve(data);
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("XML request timeout")));
    req.end(body);
  });
}

/** An XML/YNC transport client for one receiver over HTTP (port 80). */
export class XmlClient {
  private readonly request: XmlPoster;

  /**
   * @param ip the receiver IP
   * @param post the XML poster (defaults to a node:http POST)
   * @param gate the device's command gate — when given, every request runs through it, so
   *   these 1990s-era HTTP stacks never face parallel requests and a stopped adapter
   *   cancels what is still queued
   */
  public constructor(
    private readonly ip: string,
    post: XmlPoster = defaultPoster,
    gate?: CommandGate,
  ) {
    this.request = gate
      ? (ip_, body) => gate.run(() => post(ip_, body), body.includes('cmd="PUT"') ? "user" : "background")
      : post;
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
   * @returns the parsed amplifier fields
   */
  public async getStatus(zone: string): Promise<BasicStatus> {
    const response = await this.request(this.ip, encodeGet(zone, "<Basic_Status>GetParam</Basic_Status>"));
    return parseBasicStatus(assertXmlOk(response, `<${zone}> Basic_Status`));
  }

  /**
   * Read the device's model name (System > Config).
   *
   * @returns the model name, or undefined when the device does not report one
   */
  public async getModelName(): Promise<string | undefined> {
    const response = await this.request(this.ip, encodeGet("System", "<Config>GetParam</Config>"));
    return parseModelName(response);
  }

  /**
   * Read an element's inner GET request and return the raw response body — the
   * browse driver reads `<List_Info>` from source elements (NET_RADIO, SERVER, USB)
   * with it.
   *
   * @param element the XML element (a zone or a source)
   * @param inner the inner request XML
   * @returns the raw response body
   */
  public getXml(element: string, inner: string): Promise<string> {
    return this.request(this.ip, encodeGet(element, inner));
  }
}
