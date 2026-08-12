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
var multi_transport_handle_exports = {};
__export(multi_transport_handle_exports, {
  MultiTransportHandle: () => MultiTransportHandle
});
module.exports = __toCommonJS(multi_transport_handle_exports);
var import_object_tree_coordinator = require("../catalog/object-tree-coordinator");
class MultiTransportHandle {
  /**
   * @param deviceId the id-safe device id (object-tree path segment)
   * @param connections the transports that connected for this device
   * @param deps the adapter callbacks
   */
  constructor(deviceId, connections, deps) {
    this.deviceId = deviceId;
    this.connections = connections;
    this.deps = deps;
  }
  ownerByCanonicalId = /* @__PURE__ */ new Map();
  /** Unify the catalogs into one tree, create it, and seed each transport its owned states. */
  async start() {
    const contributions = this.connections.map((connection) => ({
      transport: connection.transport,
      objects: connection.buildObjects()
    }));
    const { objects, ownerByCanonicalId } = (0, import_object_tree_coordinator.coordinateObjectTree)(contributions);
    this.ownerByCanonicalId = ownerByCanonicalId;
    for (const object of objects) {
      await this.deps.upsertObject(`${this.deviceId}.${object.id}`, object);
    }
    for (const connection of this.connections) {
      await connection.seedOwned(this.ownedFor(connection.transport));
    }
  }
  /**
   * The canonical ids a transport owns.
   *
   * @param transport the transport to collect owned ids for
   * @returns the set of canonical ids owned by that transport
   */
  ownedFor(transport) {
    const owned = /* @__PURE__ */ new Set();
    for (const [id, owner] of this.ownerByCanonicalId) {
      if (owner === transport) {
        owned.add(id);
      }
    }
    return owned;
  }
  /**
   * Route a state change to the transport that owns the datapoint (a no-op for an acked echo or
   * an id no transport owns).
   *
   * @param fullStateId the full state id (device id + "." + canonical id)
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
    const canonicalId = fullStateId.slice(prefix.length);
    const owner = this.ownerByCanonicalId.get(canonicalId);
    const connection = this.connections.find((c) => c.transport === owner);
    connection == null ? void 0 : connection.handleWrite(canonicalId, ack, value);
  }
  /**
   * Register the supervisor's drop handler. A drop from any single transport reports the whole
   * set as dropped, so the supervisor reconnects everything together (per-transport reconnect
   * is a later refinement).
   *
   * @param cb invoked once when a transport is judged gone
   */
  onDrop(cb) {
    for (const connection of this.connections) {
      connection.onDrop(cb);
    }
  }
  /** Close every transport. Synchronous — safe from onUnload. */
  close() {
    for (const connection of this.connections) {
      connection.close();
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MultiTransportHandle
});
//# sourceMappingURL=multi-transport-handle.js.map
