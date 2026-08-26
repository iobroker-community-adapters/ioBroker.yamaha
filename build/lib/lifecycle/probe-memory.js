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
var probe_memory_exports = {};
__export(probe_memory_exports, {
  ProbeMemory: () => ProbeMemory
});
module.exports = __toCommonJS(probe_memory_exports);
class ProbeMemory {
  values = /* @__PURE__ */ new Map();
  /**
   * Return the remembered answer, or run the probe once and remember it.
   *
   * @param key what is being remembered (e.g. "xmlBrowseSources")
   * @param probe the probe to run when nothing is remembered yet
   * @returns the remembered or freshly probed value
   */
  async once(key, probe) {
    if (this.values.has(key)) {
      return this.values.get(key);
    }
    const value = await probe();
    this.values.set(key, value);
    return value;
  }
  /**
   * The remembered value, or undefined when nothing was stored under that key yet.
   *
   * @param key what was remembered
   * @returns the value, or undefined
   */
  remembered(key) {
    return this.values.get(key);
  }
  /**
   * Store a value directly — for answers that fall out of a bigger request rather than
   * being fetched on their own.
   *
   * @param key what is being remembered
   * @param value the value to keep
   */
  set(key, value) {
    this.values.set(key, value);
  }
  /** Forget everything — used when a device turns out to be a different one. */
  clear() {
    this.values.clear();
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ProbeMemory
});
//# sourceMappingURL=probe-memory.js.map
