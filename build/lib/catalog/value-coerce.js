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
var value_coerce_exports = {};
__export(value_coerce_exports, {
  decode: () => decode,
  encode: () => encode,
  specToCommon: () => specToCommon
});
module.exports = __toCommonJS(value_coerce_exports);
function specToCommon(spec, opts = {}) {
  var _a, _b, _c, _d, _e;
  const write = (_a = opts.write) != null ? _a : false;
  switch (spec.kind) {
    case "onoff":
      return { type: "boolean", role: (_b = opts.role) != null ? _b : "switch", read: true, write };
    case "enum":
      return { type: "string", role: (_c = opts.role) != null ? _c : "state", read: true, write, states: spec.states };
    case "number": {
      const common = { type: "number", role: (_d = opts.role) != null ? _d : write ? "level" : "value", read: true, write };
      if (spec.unit !== void 0) {
        common.unit = spec.unit;
      }
      if (spec.min !== void 0) {
        common.min = spec.min;
      }
      if (spec.max !== void 0) {
        common.max = spec.max;
      }
      if (spec.step !== void 0) {
        common.step = spec.step;
      }
      return common;
    }
    case "text":
      return { type: "string", role: (_e = opts.role) != null ? _e : "text", read: true, write };
  }
}
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
function decode(spec, wire) {
  switch (spec.kind) {
    case "onoff":
      return wire === spec.on;
    case "number": {
      const trimmed = wire.trim();
      return DECIMAL_RE.test(trimmed) ? Number(trimmed) : void 0;
    }
    case "enum":
    case "text":
      return wire;
  }
}
function encode(spec, value) {
  switch (spec.kind) {
    case "onoff":
      return value ? spec.on : spec.off;
    case "number":
    case "enum":
    case "text":
      return String(value);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  decode,
  encode,
  specToCommon
});
//# sourceMappingURL=value-coerce.js.map
