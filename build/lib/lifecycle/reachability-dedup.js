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
var reachability_dedup_exports = {};
__export(reachability_dedup_exports, {
  ReachabilityDedup: () => ReachabilityDedup
});
module.exports = __toCommonJS(reachability_dedup_exports);
class ReachabilityDedup {
  unreachable = false;
  /**
   * Report a failed connect attempt.
   *
   * @returns "warn" the first time in a row, "debug" for a repeat while still unreachable
   */
  reportUnreachable() {
    if (this.unreachable) {
      return "debug";
    }
    this.unreachable = true;
    return "warn";
  }
  /** Report a successful connect — clears the dedup so the next failure warns again. */
  reportReachable() {
    this.unreachable = false;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ReachabilityDedup
});
//# sourceMappingURL=reachability-dedup.js.map
