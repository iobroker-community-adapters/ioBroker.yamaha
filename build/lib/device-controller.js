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
const FUNC_MAP = (0, import_catalog.funcToEntry)(import_catalog.YNCA_CATALOG);
const ID_MAP = (0, import_catalog.idToEntry)(import_catalog.YNCA_CATALOG);
const AVAIL_PROBE = (0, import_catalog.availGets)(import_catalog.YNCA_CATALOG);
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
    const catalog = this.deps.isEntryEnabled ? import_catalog.YNCA_CATALOG.filter((entry) => this.deps.isEntryEnabled(entry.id)) : import_catalog.YNCA_CATALOG;
    const capabilities = await this.sweepDevice(catalog);
    const objects = (0, import_catalog.yncaObjectsFor)(capabilities, catalog);
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
    this.deps.log.debug(`${this.deviceId}: ${capabilities.model || "device"} ready (YNCA)`);
    return true;
  }
  /**
   * Read the device's capabilities with the two-pass sweep. Pass 1 probes each
   * catalogued subunit with `AVAIL=?` (~2 s); pass 2 sweeps only the subunits that
   * answered, plus SYS (which never answers AVAIL) — on a typical receiver that
   * saves a third or more of the ~39 s blind sweep. A cached probe result (per
   * device, surviving reconnects and restarts) skips pass 1 entirely; a device
   * whose model or firmware no longer matches the cache re-probes. A device that
   * answers no AVAIL at all falls back to the full blind sweep, so an unknown
   * firmware loses speed, never features.
   *
   * @param catalog the (group-filtered) catalog whose functions to sweep
   * @returns the assembled capabilities
   */
  async sweepDevice(catalog) {
    var _a, _b, _c, _d, _e, _f, _g;
    const cached = (_a = this.deps.subunitCache) == null ? void 0 : _a.get();
    if (cached) {
      const capabilities2 = await this.targetedSweep(catalog, new Set(cached.subunits));
      const firmware = (_c = (_b = capabilities2.subunits.SYS) == null ? void 0 : _b.VERSION) != null ? _c : "";
      if (capabilities2.model === cached.model && firmware === cached.firmware) {
        return capabilities2;
      }
      this.deps.log.debug(`${this.deviceId}: cached subunit set is stale (model/firmware changed), re-probing`);
      (_d = this.deps.subunitCache) == null ? void 0 : _d.clear();
    }
    const probe = await this.deps.client.readCapabilities(AVAIL_PROBE);
    const present = new Set(Object.keys(probe.subunits));
    if (present.size === 0) {
      return await this.deps.client.readCapabilities((0, import_catalog.sweepGets)(catalog));
    }
    const capabilities = await this.targetedSweep(catalog, present);
    if (capabilities.model) {
      (_g = this.deps.subunitCache) == null ? void 0 : _g.set({
        subunits: [...present],
        model: capabilities.model,
        firmware: (_f = (_e = capabilities.subunits.SYS) == null ? void 0 : _e.VERSION) != null ? _f : ""
      });
    }
    return capabilities;
  }
  /**
   * Sweep only the present subunits' functions (SYS always included — it answers no
   * AVAIL but carries model/firmware/master power).
   *
   * @param catalog the (group-filtered) catalog whose functions to sweep
   * @param present the subunits that answered the AVAIL probe
   * @returns the assembled capabilities
   */
  targetedSweep(catalog, present) {
    const gets = (0, import_catalog.sweepGets)(catalog).filter((get) => get.subunit === "SYS" || present.has(get.subunit));
    return this.deps.client.readCapabilities(gets);
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
