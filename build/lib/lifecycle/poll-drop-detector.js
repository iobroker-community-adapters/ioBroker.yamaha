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
var poll_drop_detector_exports = {};
__export(poll_drop_detector_exports, {
  MAX_POLL_FAILURES: () => MAX_POLL_FAILURES,
  PollDropDetector: () => PollDropDetector
});
module.exports = __toCommonJS(poll_drop_detector_exports);
const MAX_POLL_FAILURES = 3;
class PollDropDetector {
  /**
   * @param maxFailures consecutive failed polls before the device counts as gone
   */
  constructor(maxFailures = MAX_POLL_FAILURES) {
    this.maxFailures = maxFailures;
  }
  failures = 0;
  dropped = false;
  handler;
  /** A drop that fired before onDrop was registered — delivered once it is. */
  pending;
  /**
   * Register the supervisor's drop handler.
   *
   * @param cb invoked once when the device is judged gone
   */
  onDrop(cb) {
    this.handler = cb;
    if (this.pending) {
      const reason = this.pending;
      this.pending = void 0;
      cb(reason);
    }
  }
  /**
   * Record a poll's outcome.
   *
   * @param anySucceeded whether at least one request of this poll came back
   */
  record(anySucceeded) {
    if (anySucceeded) {
      this.failures = 0;
      return;
    }
    if (++this.failures >= this.maxFailures) {
      this.report();
    }
  }
  /** Report the drop once — repeat calls are ignored, as is a report after close. */
  report() {
    if (this.dropped) {
      return;
    }
    this.dropped = true;
    const reason = new Error(`${this.maxFailures} polls failed`);
    if (this.handler) {
      this.handler(reason);
      return;
    }
    this.pending = reason;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MAX_POLL_FAILURES,
  PollDropDetector
});
//# sourceMappingURL=poll-drop-detector.js.map
