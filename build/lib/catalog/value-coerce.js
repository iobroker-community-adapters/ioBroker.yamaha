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
  formatWireNumber: () => formatWireNumber,
  isWritableValue: () => isWritableValue,
  specToCommon: () => specToCommon
});
module.exports = __toCommonJS(value_coerce_exports);
function specToCommon(spec, opts = {}) {
  var _a, _b, _c, _d, _e, _f, _g;
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
    case "code": {
      const states = {};
      for (const [code, label] of Object.entries(spec.labels)) {
        states[code] = label;
      }
      return { type: "number", role: (_f = opts.role) != null ? _f : "value", read: true, write, states };
    }
    case "button":
      return { type: "boolean", role: (_g = opts.role) != null ? _g : "button", read: false, write: true };
  }
}
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
function decode(spec, wire) {
  switch (spec.kind) {
    case "onoff":
      if (wire === spec.on) {
        return true;
      }
      if (wire === spec.off) {
        return false;
      }
      return void 0;
    case "number": {
      const trimmed = wire.trim();
      return DECIMAL_RE.test(trimmed) ? Number(trimmed) : void 0;
    }
    case "enum":
    case "text":
      return wire;
    case "code": {
      const code = spec.codes[wire];
      return code === void 0 ? void 0 : code;
    }
    case "button":
      return void 0;
  }
}
function isWritableValue(value, numeric) {
  if (value === null || value === void 0) {
    return false;
  }
  if (!numeric) {
    return true;
  }
  if (typeof value === "string" && value.trim() === "") {
    return false;
  }
  return Number.isFinite(Number(value));
}
function formatWireNumber(value, decimals, step) {
  const snapped = step ? Math.round(value / step) * step : value;
  const magnitude = Math.abs(snapped).toFixed(decimals);
  const sign = snapped < 0 && Number(magnitude) !== 0 ? "-" : "";
  return sign + magnitude;
}
function encode(spec, value) {
  switch (spec.kind) {
    case "onoff":
      return value ? spec.on : spec.off;
    case "number":
      if (spec.decimals !== void 0) {
        return formatWireNumber(Number(value), spec.decimals, spec.step);
      }
      return String(value);
    case "enum":
    case "text":
      return String(value);
    case "code": {
      const code = Number(value);
      const token = Object.keys(spec.codes).find((w) => spec.codes[w] === code);
      return token != null ? token : String(value);
    }
    case "button":
      return "";
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  decode,
  encode,
  formatWireNumber,
  isWritableValue,
  specToCommon
});
//# sourceMappingURL=value-coerce.js.map
