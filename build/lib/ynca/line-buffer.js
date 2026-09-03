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
var line_buffer_exports = {};
__export(line_buffer_exports, {
  LineBuffer: () => LineBuffer
});
module.exports = __toCommonJS(line_buffer_exports);
const MAX_BUFFER = 64 * 1024;
class LineBuffer {
  buffer = "";
  /**
   * Add a received chunk and return the complete lines it makes available. The
   * trailing partial line stays buffered until its terminator arrives.
   *
   * @param chunk newly received text
   * @returns the complete, non-empty lines now available
   */
  push(chunk) {
    var _a;
    this.buffer += chunk;
    const parts = this.buffer.split(/\r\n|\r|\n/);
    this.buffer = (_a = parts.pop()) != null ? _a : "";
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer = "";
    }
    return parts.filter((line) => line.length > 0);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  LineBuffer
});
//# sourceMappingURL=line-buffer.js.map
