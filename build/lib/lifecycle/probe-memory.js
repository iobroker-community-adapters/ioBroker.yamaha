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
  /**
   * @param initial the persisted entries to start from (an adapter restart), if any
   * @param persist called with a plain-object snapshot after every change, if persistence is wired
   */
  constructor(initial, persist) {
    this.persist = persist;
    for (const [key, value] of Object.entries(initial != null ? initial : {})) {
      this.values.set(key, value);
    }
  }
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
    this.persistNow();
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
    this.persistNow();
  }
  /**
   * Forget the keys a predicate marks — a transport's freshness guard drops ITS portion
   * when the device behind the address turns out to be a different (or updated) one,
   * without touching what the other transports validated.
   *
   * @param match marks the keys to drop
   */
  drop(match) {
    let dropped = false;
    for (const key of [...this.values.keys()]) {
      if (match(key)) {
        this.values.delete(key);
        dropped = true;
      }
    }
    if (dropped) {
      this.persistNow();
    }
  }
  /** Forget everything — used when a device turns out to be a different one. */
  clear() {
    this.values.clear();
    this.persistNow();
  }
  persistNow() {
    if (!this.persist) {
      return;
    }
    this.persist(Object.fromEntries(this.values));
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ProbeMemory
});
//# sourceMappingURL=probe-memory.js.map
