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
var protocol_exports = {};
__export(protocol_exports, {
  decodeLine: () => decodeLine,
  encodeCommand: () => encodeCommand,
  encodeGet: () => encodeGet,
});
module.exports = __toCommonJS(protocol_exports);
function decodeLine(line) {
  if (line === "@UNDEFINED") {
    return { status: "undefined" };
  }
  if (line === "@RESTRICTED") {
    return { status: "restricted" };
  }
  if (!line.startsWith("@")) {
    return { status: "unknown" };
  }
  const colon = line.indexOf(":");
  const equals = line.indexOf("=");
  if (colon < 2 || equals < colon + 2) {
    return { status: "unknown" };
  }
  return {
    status: "ok",
    subunit: line.slice(1, colon),
    func: line.slice(colon + 1, equals),
    value: line.slice(equals + 1),
  };
}
function encodeCommand(subunit, func, value) {
  return `@${subunit}:${func}=${value}`;
}
function encodeGet(subunit, func) {
  return encodeCommand(subunit, func, "?");
}
// Annotate the CommonJS export names for ESM import in node:
0 &&
  (module.exports = {
    decodeLine,
    encodeCommand,
    encodeGet,
  });
//# sourceMappingURL=protocol.js.map
