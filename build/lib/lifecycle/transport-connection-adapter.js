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
var transport_connection_adapter_exports = {};
__export(transport_connection_adapter_exports, {
  TransportConnectionAdapter: () => TransportConnectionAdapter
});
module.exports = __toCommonJS(transport_connection_adapter_exports);
var import_owner_policy = require("../catalog/owner-policy");
const INVERSE_DRIFT = {
  yxc: { "sound.subwooferTrim": "subwooferVolume", "multiroom.party": "multiroom.partyEnable" },
  xml: { "hdmi.out1": "hdmiOut1", "hdmi.out2": "hdmiOut2" }
};
class TransportConnectionAdapter {
  /**
   * @param transport the transport this adapts
   * @param deviceId the id-safe device id (object-tree path segment)
   * @param setStateAck the real ack-write, called only for the states this transport owns
   */
  constructor(transport, deviceId, setStateAck) {
    this.transport = transport;
    this.deviceId = deviceId;
    this.setStateAck = setStateAck;
  }
  collected = [];
  buffered = [];
  owned;
  controller;
  /**
   * The upsertObject the controller is built with — collects its objects (canonicalized), not writing.
   *
   * @param _fullId the controller's full object id (unused; the canonical id is derived from the def)
   * @param def the object definition the controller built
   * @returns a resolved promise (the controller's upsert dep is async)
   */
  interceptUpsert = (_fullId, def) => {
    this.collected.push({ ...def, id: this.canonical(def.id) });
    return Promise.resolve();
  };
  /**
   * The setStateAck the controller is built with — owned-filtered live; buffered until owned is known.
   *
   * @param fullId the controller's full state id
   * @param value the state value the controller wrote
   */
  interceptSetStateAck = (fullId, value) => {
    const canonicalId = this.canonical(this.relative(fullId));
    if (this.owned) {
      if (this.owned.has(canonicalId)) {
        this.setStateAck(`${this.deviceId}.${canonicalId}`, value);
      }
    } else {
      this.buffered.push({ canonicalId, value });
    }
  };
  /**
   * Bind the built controller (constructed with the intercept deps above).
   *
   * @param controller the controller to drive
   */
  bind(controller) {
    this.controller = controller;
  }
  /** Start the controller (connect + probe + collect objects). Call before {@link buildObjects}. */
  async connect() {
    var _a, _b;
    return (_b = await ((_a = this.controller) == null ? void 0 : _a.start())) != null ? _b : false;
  }
  /** The objects the controller built, canonicalized. Valid after {@link connect}. */
  buildObjects() {
    return this.collected;
  }
  /**
   * Arm the owned filter and flush the buffered seeds for the owned ids.
   *
   * @param owned the canonical ids this transport owns
   */
  seedOwned(owned) {
    this.owned = owned;
    for (const seed of this.buffered) {
      if (owned.has(seed.canonicalId)) {
        this.setStateAck(`${this.deviceId}.${seed.canonicalId}`, seed.value);
      }
    }
    this.buffered.length = 0;
  }
  /**
   * Route a user write to the controller under its own (drift-reversed, zone-kept) id.
   *
   * @param canonicalId the canonical state id the user wrote
   * @param ack whether the write is acked
   * @param value the value written
   */
  handleWrite(canonicalId, ack, value) {
    var _a, _b, _c, _d, _e;
    const zone = (_b = (_a = /^(?:multiroom\.)?zone[234]\./.exec(canonicalId)) == null ? void 0 : _a[0]) != null ? _b : "";
    const template = canonicalId.slice(zone.length);
    const controllerId = zone + ((_d = (_c = INVERSE_DRIFT[this.transport]) == null ? void 0 : _c[template]) != null ? _d : template);
    (_e = this.controller) == null ? void 0 : _e.handleStateChange(`${this.deviceId}.${controllerId}`, ack, value);
  }
  /**
   * Register a drop handler; forwarded to the controller.
   *
   * @param cb called when the transport drops
   */
  onDrop(cb) {
    var _a;
    (_a = this.controller) == null ? void 0 : _a.onDrop(cb);
  }
  /** Close the controller (synchronous — safe from onUnload). */
  close() {
    var _a;
    (_a = this.controller) == null ? void 0 : _a.close();
  }
  relative(fullId) {
    const prefix = `${this.deviceId}.`;
    return fullId.startsWith(prefix) ? fullId.slice(prefix.length) : fullId;
  }
  canonical(id) {
    return (0, import_owner_policy.canonicalIdOf)(this.transport, this.relative(id));
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  TransportConnectionAdapter
});
//# sourceMappingURL=transport-connection-adapter.js.map
