"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var discovery_exports = {};
__export(discovery_exports, {
  discoverYamaha: () => discoverYamaha,
  parseYamahaDescription: () => parseYamahaDescription
});
module.exports = __toCommonJS(discovery_exports);
var import_util = require("./util");
const YAMAHA_MANUFACTURER = /<manufacturer>[^<]*yamaha[^<]*<\/manufacturer>/i;
const FRIENDLY_NAME = /<friendlyName>([^<]*)<\/friendlyName>/;
const ROOT_DEVICE = "upnp:rootdevice";
const SEARCH_TIMEOUT_MS = 5e3;
function parseYamahaDescription(xml) {
  if (!YAMAHA_MANUFACTURER.test(xml)) {
    return void 0;
  }
  const match = FRIENDLY_NAME.exec(xml);
  return { name: match ? match[1] : "" };
}
async function discoverYamaha(deps) {
  const found = await deps.search(ROOT_DEVICE, SEARCH_TIMEOUT_MS);
  const devices = [];
  const seen = /* @__PURE__ */ new Set();
  for (const { location, address } of found) {
    if (seen.has(address)) {
      continue;
    }
    try {
      const description = await deps.fetch(location);
      const yamaha = parseYamahaDescription(description);
      if (yamaha) {
        devices.push({ ip: address, name: yamaha.name });
        seen.add(address);
      }
    } catch (e) {
      deps.log.debug(`discovery: ${address} description fetch failed: ${(0, import_util.errorMessage)(e)}`);
    }
  }
  return devices;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  discoverYamaha,
  parseYamahaDescription
});
//# sourceMappingURL=discovery.js.map
