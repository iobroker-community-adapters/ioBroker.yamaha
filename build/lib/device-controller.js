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
var device_controller_exports = {};
__export(device_controller_exports, {
  YncaDeviceController: () => YncaDeviceController
});
module.exports = __toCommonJS(device_controller_exports);
var import_capability_mapper = require("./capability-mapper");
var import_command_mapper = require("./command-mapper");
class YncaDeviceController {
  /**
   * @param deviceId the id-safe device id (object-tree path segment)
   * @param deps the client and adapter callbacks
   */
  constructor(deviceId, deps) {
    this.deviceId = deviceId;
    this.deps = deps;
  }
  /**
   * Connect, sweep the device, and create its object tree; wire up push updates.
   *
   * @param sweepGets the subunit/function pairs to query in the init sweep
   * @returns true if the device reported capabilities and its tree was created
   */
  async start(sweepGets) {
    await this.deps.client.connect();
    const capabilities = await this.deps.client.readCapabilities(sweepGets);
    const objects = (0, import_capability_mapper.mapYncaToObjects)(capabilities);
    if (objects.length === 0) {
      this.deps.log.warn(`${this.deviceId}: no capabilities reported \u2014 creating no objects`);
      return false;
    }
    for (const object of objects) {
      await this.deps.upsertObject(`${this.deviceId}.${object.id}`, object);
    }
    for (const [subunit, funcs] of Object.entries(capabilities.subunits)) {
      for (const [func, value] of Object.entries(funcs)) {
        const update = (0, import_command_mapper.yncaToState)({ subunit, func, value });
        if (update) {
          this.deps.setStateAck(`${this.deviceId}.${update.id}`, update.value);
        }
      }
    }
    this.deps.client.onMessage((message) => {
      const update = (0, import_command_mapper.yncaToState)(message);
      if (update) {
        this.deps.setStateAck(`${this.deviceId}.${update.id}`, update.value);
      }
    });
    this.deps.log.info(`${this.deviceId}: ${capabilities.model || "device"} ready`);
    return true;
  }
  /**
   * Handle a state change: a user write (ack false) becomes a YNCA command; an
   * acked change (the device's own echo) is ignored to avoid a resend loop.
   *
   * @param fullStateId the full state id (device id + "." + state)
   * @param ack whether the change is acked (device-originated)
   * @param value the new value
   */
  handleStateChange(fullStateId, ack, value) {
    if (ack) {
      return;
    }
    const prefix = `${this.deviceId}.`;
    if (!fullStateId.startsWith(prefix)) {
      return;
    }
    const triple = (0, import_command_mapper.stateToYnca)(fullStateId.slice(prefix.length), value);
    if (triple) {
      this.deps.client.send(triple.subunit, triple.func, triple.value);
    }
  }
  /** Close the client. Synchronous — safe to call from onUnload. */
  close() {
    this.deps.client.close();
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  YncaDeviceController
});
//# sourceMappingURL=device-controller.js.map
