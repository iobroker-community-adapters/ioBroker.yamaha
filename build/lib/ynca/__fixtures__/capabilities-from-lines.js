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
var capabilities_from_lines_exports = {};
__export(capabilities_from_lines_exports, {
  capabilitiesFromLines: () => capabilitiesFromLines
});
module.exports = __toCommonJS(capabilities_from_lines_exports);
var import_capability = require("../capability");
var import_protocol = require("../protocol");
function capabilitiesFromLines(lines) {
  const messages = [];
  for (const line of lines) {
    const response = (0, import_protocol.decodeLine)(line);
    if (response.status === "ok") {
      messages.push({ subunit: response.subunit, func: response.func, value: response.value });
    }
  }
  return (0, import_capability.buildCapabilities)(messages);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  capabilitiesFromLines
});
//# sourceMappingURL=capabilities-from-lines.js.map
