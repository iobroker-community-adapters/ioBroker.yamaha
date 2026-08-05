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
var device_supervisor_exports = {};
__export(device_supervisor_exports, {
  DeviceSupervisor: () => DeviceSupervisor
});
module.exports = __toCommonJS(device_supervisor_exports);
class DeviceSupervisor {
  /**
   * @param deps the injected attempt/timer/report callbacks
   */
  constructor(deps) {
    this.deps = deps;
  }
  handle;
  timer;
  closed = false;
  /** Begin supervising: attempt now, then retry/reconnect as needed. */
  start() {
    void this.attemptOnce();
  }
  /**
   * Route a state change to the currently connected controller (a no-op while the
   * device is offline, so a user write during a reconnect is simply dropped).
   *
   * @param fullStateId the full state id (device id + "." + state)
   * @param ack whether the change is acked (device-originated)
   * @param value the new value
   */
  handleStateChange(fullStateId, ack, value) {
    var _a;
    (_a = this.handle) == null ? void 0 : _a.handleStateChange(fullStateId, ack, value);
  }
  async attemptOnce() {
    if (this.closed) {
      return;
    }
    let handle = null;
    try {
      handle = await this.deps.attempt();
    } catch {
      handle = null;
    }
    if (this.closed) {
      handle == null ? void 0 : handle.close();
      return;
    }
    if (handle) {
      this.handle = handle;
      this.deps.backoff.reset();
      this.deps.onConnectionChange(true);
      handle.onDrop((reason) => this.handleDrop(handle, reason));
    } else {
      this.deps.onConnectionChange(false);
      this.scheduleRetry();
    }
  }
  handleDrop(handle, reason) {
    if (this.closed || this.handle !== handle) {
      return;
    }
    if (reason) {
      this.deps.log.debug(`connection dropped, reconnecting: ${reason.message}`);
    }
    handle.close();
    this.handle = void 0;
    this.deps.onConnectionChange(false);
    this.scheduleRetry();
  }
  scheduleRetry() {
    this.timer = this.deps.schedule(() => void this.attemptOnce(), this.deps.backoff.nextDelay());
  }
  /** Stop supervising and close the connection. Synchronous — safe from onUnload. */
  close() {
    var _a;
    this.closed = true;
    this.deps.cancel(this.timer);
    (_a = this.handle) == null ? void 0 : _a.close();
    this.handle = void 0;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DeviceSupervisor
});
//# sourceMappingURL=device-supervisor.js.map
