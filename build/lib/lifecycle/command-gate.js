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
var command_gate_exports = {};
__export(command_gate_exports, {
  CommandGate: () => CommandGate,
  CommandGateClosedError: () => CommandGateClosedError
});
module.exports = __toCommonJS(command_gate_exports);
class CommandGateClosedError extends Error {
  /** Carries a fixed message — the closing side has no further detail to add. */
  constructor() {
    super("command gate closed");
    this.name = "CommandGateClosedError";
  }
}
class CommandGate {
  /**
   * @param options spacing, timers and clock
   */
  constructor(options) {
    this.options = options;
    var _a;
    this.now = (_a = options.now) != null ? _a : (() => Date.now());
  }
  queue = [];
  controller = new AbortController();
  now;
  running = false;
  lastStart = Number.NEGATIVE_INFINITY;
  /** Aborted when the gate closes — pass it to anything that waits or writes. */
  get signal() {
    return this.controller.signal;
  }
  /** Whether the gate has been closed. */
  get closed() {
    return this.controller.signal.aborted;
  }
  /**
   * Run an operation through the gate: serialised against every other operation on this
   * connection and spaced by the configured minimum.
   *
   * @param run the operation (its result is passed through)
   * @param priority "user" jumps ahead of queued background work
   * @returns the operation's result
   */
  run(run, priority = "background") {
    if (this.closed) {
      return Promise.reject(new CommandGateClosedError());
    }
    return new Promise((resolve, reject) => {
      const waiting = { run, resolve, reject, priority };
      if (priority === "user") {
        const firstBackground = this.queue.findIndex((entry) => entry.priority === "background");
        if (firstBackground < 0) {
          this.queue.push(waiting);
        } else {
          this.queue.splice(firstBackground, 0, waiting);
        }
      } else {
        this.queue.push(waiting);
      }
      this.pump();
    });
  }
  /**
   * Wait out the gate's spacing without occupying it — for pacing that is not itself a
   * command (a settle window, a busy poll). Resolves early and rejects nothing when the
   * gate closes, so a caller's await chain ends instead of hanging on a cancelled timer.
   *
   * @param ms milliseconds to wait
   * @returns a promise resolving after the delay, or immediately once closed
   */
  delay(ms) {
    if (this.closed) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const armed = {};
      const onAbort = () => {
        this.options.timers.cancel(armed.timer);
        resolve();
      };
      armed.timer = this.options.timers.schedule(() => {
        this.controller.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      this.controller.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  /**
   * Close the gate: abort the signal and reject everything still queued. Synchronous —
   * safe to call from onUnload. A running operation is not killed (it holds a socket or
   * an HTTP request), but its caller sees the aborted signal and stops writing.
   */
  close() {
    if (this.closed) {
      return;
    }
    this.controller.abort();
    const pending = this.queue.splice(0, this.queue.length);
    for (const entry of pending) {
      entry.reject(new CommandGateClosedError());
    }
  }
  /** Start the next operation when the gate is free and the spacing has elapsed. */
  pump() {
    if (this.running || this.closed || this.queue.length === 0) {
      return;
    }
    const spacingLeft = this.options.minSpacingMs - (this.now() - this.lastStart);
    if (spacingLeft > 0) {
      this.running = true;
      this.options.timers.schedule(() => {
        this.running = false;
        this.pump();
      }, spacingLeft);
      return;
    }
    const entry = this.queue.shift();
    if (!entry) {
      return;
    }
    this.running = true;
    this.lastStart = this.now();
    void this.execute(entry);
  }
  /**
   * Run one operation and release the gate afterwards, whatever its outcome.
   *
   * @param entry the queued operation
   */
  async execute(entry) {
    try {
      const result = await entry.run();
      entry.resolve(result);
    } catch (e) {
      entry.reject(e instanceof Error ? e : new Error(String(e)));
    } finally {
      this.running = false;
      this.pump();
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CommandGate,
  CommandGateClosedError
});
//# sourceMappingURL=command-gate.js.map
