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
var reconnect_strategy_exports = {};
__export(reconnect_strategy_exports, {
  ReconnectStrategy: () => ReconnectStrategy
});
module.exports = __toCommonJS(reconnect_strategy_exports);
class ReconnectStrategy {
  /**
   * @param baseMs the first delay in milliseconds
   * @param maxMs the maximum delay in milliseconds
   */
  constructor(baseMs, maxMs) {
    this.baseMs = baseMs;
    this.maxMs = maxMs;
  }
  attempt = 0;
  /**
   * Get the next backoff delay and advance the attempt counter.
   *
   * @returns the delay in milliseconds for the next reconnect attempt
   */
  nextDelay() {
    const delay = Math.min(this.baseMs * 2 ** this.attempt, this.maxMs);
    this.attempt++;
    return delay;
  }
  /** Reset the backoff to the base delay after a successful connection. */
  reset() {
    this.attempt = 0;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ReconnectStrategy
});
//# sourceMappingURL=reconnect-strategy.js.map
