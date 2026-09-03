"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all) __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if ((from && typeof from === "object") || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, {
          get: () => from[key],
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable,
        });
  }
  return to;
};
var __toCommonJS = mod => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var xml_client_exports = {};
__export(xml_client_exports, {
  XmlClient: () => XmlClient,
});
module.exports = __toCommonJS(xml_client_exports);
var import_node_http = require("node:http");
var import_protocol = require("./protocol");
var import_util = require("../util");
const CONTROL_PATH = "/YamahaRemoteControl/ctrl";
const REQUEST_TIMEOUT_MS = 5e3;
function defaultPoster(ip, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(payload, "utf8");
    const req = (0, import_node_http.request)(
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
          bytes += chunk.length;
          if (bytes > import_util.MAX_HTTP_BODY_BYTES) {
            res.destroy(new Error("XML response too large"));
            return;
          }
          data += String(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          if (res.statusCode !== void 0 && (res.statusCode < 200 || res.statusCode >= 300)) {
            reject(
              new import_protocol.XmlHttpError(`device refused the request (HTTP ${res.statusCode})`, res.statusCode),
            );
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
class XmlClient {
  /**
   * @param ip the receiver IP
   * @param post the XML poster (defaults to a node:http POST)
   * @param gate the device's command gate — when given, every request runs through it, so
   *   these 1990s-era HTTP stacks never face parallel requests and a stopped adapter
   *   cancels what is still queued
   */
  constructor(ip, post = defaultPoster, gate) {
    this.ip = ip;
    this.request = gate
      ? (ip_, body) => gate.run(() => post(ip_, body), body.includes('cmd="PUT"') ? "user" : "background")
      : post;
  }
  request;
  /**
   * Send a zone command (wrapped in a PUT envelope). Throws when the device refuses
   * it — the response's return code IS the device saying "I did not do that", and
   * swallowing it left every refused write invisible (#613/#615).
   *
   * @param zone the zone element (e.g. `Main_Zone`)
   * @param inner the inner command XML
   */
  async send(zone, inner) {
    (0, import_protocol.assertXmlOk)(
      await this.request(this.ip, (0, import_protocol.encodePut)(zone, inner)),
      `<${zone}>${inner}`,
    );
  }
  /**
   * Read a zone's Basic_Status. A refusal throws — an absent zone must not look
   * like a present zone with an empty status.
   *
   * @param zone the zone element (e.g. `Main_Zone`)
   * @returns the parsed amplifier fields
   */
  async getStatus(zone) {
    const response = await this.request(
      this.ip,
      (0, import_protocol.encodeGet)(zone, "<Basic_Status>GetParam</Basic_Status>"),
    );
    return (0, import_protocol.parseBasicStatus)((0, import_protocol.assertXmlOk)(response, `<${zone}> Basic_Status`));
  }
  /**
   * Read the device's model name (System > Config).
   *
   * @returns the model name, or undefined when the device does not report one
   */
  async getModelName() {
    const response = await this.request(this.ip, (0, import_protocol.encodeGet)("System", "<Config>GetParam</Config>"));
    return (0, import_protocol.parseModelName)(response);
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
  getXml(element, inner) {
    return this.request(this.ip, (0, import_protocol.encodeGet)(element, inner));
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 &&
  (module.exports = {
    XmlClient,
  });
//# sourceMappingURL=xml-client.js.map
