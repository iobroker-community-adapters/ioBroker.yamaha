import { request } from "node:http";
import { encodeGet, encodePut, parseBasicStatus, parseModelName, type BasicStatus } from "./protocol";

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
 * @param body the XML request body
 * @returns the response body
 */
function defaultPoster(ip: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: ip, port: 80, path: CONTROL_PATH, method: "POST", timeout: REQUEST_TIMEOUT_MS },
      res => {
        let data = "";
        res.on("data", chunk => (data += String(chunk)));
        res.on("end", () => resolve(data));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("XML request timeout")));
    req.write(body);
    req.end();
  });
}

/** An XML/YNC transport client for one receiver over HTTP (port 80). */
export class XmlClient {
  /**
   * @param ip the receiver IP
   * @param post the XML poster (defaults to a node:http POST)
   */
  public constructor(
    private readonly ip: string,
    private readonly post: XmlPoster = defaultPoster,
  ) {}

  /**
   * Send a zone command (wrapped in a PUT envelope).
   *
   * @param zone the zone element (e.g. `Main_Zone`)
   * @param inner the inner command XML
   */
  public async send(zone: string, inner: string): Promise<void> {
    await this.post(this.ip, encodePut(zone, inner));
  }

  /**
   * Read a zone's Basic_Status.
   *
   * @param zone the zone element (e.g. `Main_Zone`)
   * @returns the parsed amplifier fields
   */
  public async getStatus(zone: string): Promise<BasicStatus> {
    const response = await this.post(this.ip, encodeGet(zone, "<Basic_Status>GetParam</Basic_Status>"));
    return parseBasicStatus(response);
  }

  /**
   * Read the device's model name (System > Config).
   *
   * @returns the model name, or undefined when the device does not report one
   */
  public async getModelName(): Promise<string | undefined> {
    const response = await this.post(this.ip, encodeGet("System", "<Config>GetParam</Config>"));
    return parseModelName(response);
  }
}
