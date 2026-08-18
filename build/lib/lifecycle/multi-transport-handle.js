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
    this.deps = deps;
    this.live = [...connections];
  }
  ownerByCanonicalId = /* @__PURE__ */ new Map();
  live;
  retries = /* @__PURE__ */ new Map();
  supervisorDrop;
  /** All transports went down before the supervisor registered onDrop — delivered on registration. */
  pendingDrop = false;
  droppedAll = false;
  closed = false;
  /** Unify the catalogs into one tree, create it, seed owned states, and arm the drop handlers. */
  async start() {
    await this.coordinate();
    for (const connection of this.live) {
      connection.onDrop((reason) => this.handleTransportDrop(connection, reason));
    }
    this.reportTransports();
  }
  /**
   * (Re-)coordinate the unified tree over the currently live transports: recompute
   * ownership, upsert the objects (idempotent), and re-arm every transport's owned set.
   */
  async coordinate() {
    const contributions = this.live.map((connection) => ({
      transport: connection.transport,
      objects: connection.buildObjects()
    }));
    const { objects, ownerByCanonicalId } = (0, import_object_tree_coordinator.coordinateObjectTree)(contributions);
    this.ownerByCanonicalId = ownerByCanonicalId;
    for (const object of objects) {
      await this.deps.upsertObject(`${this.deviceId}.${object.id}`, object);
    }
    for (const connection of this.live) {
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
  /** Report the live transport set (device-manager card indicators / info.transports.*). */
  reportTransports() {
    var _a, _b;
    (_b = (_a = this.deps).onTransports) == null ? void 0 : _b.call(_a, this.live.map((connection) => connection.transport));
  }
  /**
   * One transport dropped. Remove and close it; if others are still live, reconnect just
   * this one on its own backoff loop — otherwise the device is gone: report the drop to
   * the supervisor, which reconnects the whole set.
   *
   * @param connection the dropped connection
   * @param reason the drop reason, if known
   */
  handleTransportDrop(connection, reason) {
    const index = this.live.indexOf(connection);
    if (this.closed || index < 0) {
      return;
    }
    this.live.splice(index, 1);
    connection.close();
    if (this.live.length === 0) {
      this.cancelRetries();
      this.reportDeviceGone(reason);
      return;
    }
    this.reportTransports();
    this.deps.log.debug(
      `${this.deviceId}/${connection.transport}: transport dropped, reconnecting it${reason ? ` (${reason.message})` : ""} \u2014 other transports keep running`
    );
    this.scheduleTransportRetry(connection.transport);
  }
  /**
   * Schedule the next reconnect attempt for one dropped transport, keeping its backoff
   * across attempts. Without rebuild/schedule deps (tests, or a caller that opts out)
   * the device-gone path above is the only recovery — matching the old full-reconnect.
   *
   * @param transport the transport to bring back
   */
  scheduleTransportRetry(transport) {
    var _a;
    if (!this.deps.rebuild || !this.deps.schedule || !this.deps.backoffFactory) {
      return;
    }
    const existing = this.retries.get(transport);
    const backoff = (_a = existing == null ? void 0 : existing.backoff) != null ? _a : this.deps.backoffFactory();
    const timer = this.deps.schedule(() => void this.attemptTransport(transport), backoff.nextDelay());
    this.retries.set(transport, { timer, backoff });
  }
  /**
   * Try to bring one dropped transport back: build a fresh connectable, connect it, and
   * on success re-coordinate the tree over the extended live set. A failed attempt keeps
   * the backoff loop going.
   *
   * @param transport the transport to bring back
   */
  async attemptTransport(transport) {
    if (this.closed || !this.deps.rebuild) {
      return;
    }
    const connection = this.deps.rebuild(transport);
    let connected = false;
    try {
      connected = await connection.connect();
      if (connected && !this.closed) {
        this.live.push(connection);
        connection.onDrop((reason) => this.handleTransportDrop(connection, reason));
        await this.coordinate();
        this.retries.delete(transport);
        this.reportTransports();
        this.deps.log.debug(`${this.deviceId}/${transport}: transport reconnected`);
        return;
      }
    } catch (e) {
      this.deps.log.debug(
        `${this.deviceId}/${transport}: reconnect attempt failed (${e instanceof Error ? e.message : String(e)})`
      );
      const index = this.live.indexOf(connection);
      if (index >= 0) {
        this.live.splice(index, 1);
      }
    }
    connection.close();
    if (this.closed) {
      return;
    }
    this.scheduleTransportRetry(transport);
  }
  /** Cancel every per-transport reconnect loop. */
  cancelRetries() {
    var _a, _b;
    for (const { timer } of this.retries.values()) {
      (_b = (_a = this.deps).cancel) == null ? void 0 : _b.call(_a, timer);
    }
    this.retries.clear();
  }
  /**
   * The last live transport is gone — the device itself is unreachable. Report once to
   * the supervisor (latched if it has not registered yet), which closes this handle and
   * reconnects the whole set.
   *
   * @param reason the final drop's reason, if known
   */
  reportDeviceGone(reason) {
    if (this.droppedAll) {
      return;
    }
    this.droppedAll = true;
    if (this.supervisorDrop) {
      this.supervisorDrop(reason);
    } else {
      this.pendingDrop = reason != null ? reason : void 0;
    }
  }
  /**
   * Route a state change to the transport that owns the datapoint (a no-op for an acked echo or
   * an id no transport owns). While the owning transport is offline (being reconnected), the
   * write is dropped with a debug line instead of vanishing silently.
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
    if (owner === void 0) {
      return;
    }
    const connection = this.live.find((c) => c.transport === owner);
    if (!connection) {
      this.deps.log.debug(`${this.deviceId}: write to ${canonicalId} dropped \u2014 its transport (${owner}) is offline`);
      return;
    }
    connection.handleWrite(canonicalId, ack, value);
  }
  /**
   * Register the supervisor's drop handler. It fires only when the LAST live transport is
   * gone (the device is unreachable) — a single transport's drop is handled internally.
   *
   * @param cb invoked once when the device is judged gone
   */
  onDrop(cb) {
    this.supervisorDrop = cb;
    if (this.pendingDrop !== false) {
      const reason = this.pendingDrop;
      this.pendingDrop = false;
      cb(reason);
    }
  }
  /** Close every transport and stop every reconnect loop. Synchronous — safe from onUnload. */
  close() {
    this.closed = true;
    this.cancelRetries();
    for (const connection of this.live) {
      connection.close();
    }
    this.live.length = 0;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MultiTransportHandle
});
//# sourceMappingURL=multi-transport-handle.js.map
