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
var import_catalog = require("./ynca/catalog");
const CATALOG = (0, import_catalog.buildYncaCatalog)();
const FUNC_MAP = (0, import_catalog.funcToEntry)(CATALOG);
const ID_MAP = (0, import_catalog.idToEntry)(CATALOG);
const SWEEP = [{ subunit: "SYS", func: "MODELNAME" }, ...(0, import_catalog.sweepGets)(CATALOG)];
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
   * Connect, sweep the device from the catalog, and create its object tree; wire
   * up push updates. The catalog is the single source: it drives the sweep, the
   * device→state read-back and (in handleStateChange) the state→wire encode.
   *
   * @returns true if the device reported capabilities and its tree was created
   */
  async start() {
    await this.deps.client.connect();
    const capabilities = await this.deps.client.readCapabilities(SWEEP);
    const objects = (0, import_catalog.yncaObjectsFor)(capabilities);
    if (objects.length === 0) {
      this.deps.log.warn(`${this.deviceId}: no capabilities reported \u2014 creating no objects`);
      return false;
    }
    for (const object of objects) {
      await this.deps.upsertObject(`${this.deviceId}.${object.id}`, object);
    }
    for (const [subunit, funcs] of Object.entries(capabilities.subunits)) {
      for (const [func, value] of Object.entries(funcs)) {
        const update = (0, import_catalog.yncaStateUpdate)({ subunit, func, value }, FUNC_MAP);
        if (update) {
          this.deps.setStateAck(`${this.deviceId}.${update.id}`, update.value);
        }
      }
    }
    this.deps.client.onMessage((message) => {
      const update = (0, import_catalog.yncaStateUpdate)(message, FUNC_MAP);
      if (update) {
        this.deps.setStateAck(`${this.deviceId}.${update.id}`, update.value);
      }
    });
    this.deps.client.startKeepalive();
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
    const triple = (0, import_catalog.yncaCommand)(fullStateId.slice(prefix.length), value, ID_MAP);
    if (triple) {
      this.deps.client.send(triple.subunit, triple.func, triple.value);
    }
  }
  /**
   * Register the supervisor's drop handler — delegated to the client's socket drop,
   * which is YNCA's genuine connection-lost signal.
   *
   * @param cb invoked once when the connection drops, with the reason if known
   */
  onDrop(cb) {
    this.deps.client.onDrop(cb);
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
