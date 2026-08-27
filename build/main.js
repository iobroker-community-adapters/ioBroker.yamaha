"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var main_exports = {};
__export(main_exports, {
  Yamaha: () => Yamaha
});
module.exports = __toCommonJS(main_exports);
var utils = __toESM(require("@iobroker/adapter-core"));
var import_node_dgram = require("node:dgram");
var import_node_http = require("node:http");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
var import_attempt_device = require("./lib/attempt-device");
var import_network_interfaces = require("./lib/network-interfaces");
var import_groups = require("./lib/catalog/groups");
var import_device_type = require("./lib/device-type");
var import_pure_helpers = require("./lib/pure-helpers");
var import_util = require("./lib/util");
var import_discovery = require("./lib/discovery");
var import_discovered_store = require("./lib/discovered-store");
var import_discovered_store_deps = require("./lib/discovered-store-deps");
var import_push_receiver = require("./lib/yxc/push-receiver");
var import_device_management = require("./device-management");
var import_device_supervisor = require("./lib/lifecycle/device-supervisor");
var import_reconnect_strategy = require("./lib/lifecycle/reconnect-strategy");
var import_reachability_dedup = require("./lib/lifecycle/reachability-dedup");
var import_subunit_cache = require("./lib/ynca/subunit-cache");
var import_probe_memory = require("./lib/lifecycle/probe-memory");
const RECONNECT_BASE_MS = 1e3;
const RECONNECT_MAX_MS = 6e4;
const FETCH_TIMEOUT_MS = 4e3;
const SSDP_SEARCH_BURST = 3;
const SSDP_SEARCH_INTERVAL_MS = 1e3;
const TRANSPORT_IDS = ["ynca", "yxc", "xml"];
const DATAPOINT_BALANCE_SETTLE_MS = 5e3;
class Yamaha extends utils.Adapter {
  supervisors = [];
  /** deviceId → its supervisor, so a state change goes to ONE device, not to all of them. */
  supervisorById = /* @__PURE__ */ new Map();
  deviceConnected = /* @__PURE__ */ new Map();
  pushReceiver;
  /** Device-manager backend: the receivers as cards with add/edit/delete. */
  deviceManagement;
  /**
   * Every datapoint that existed when this run started, filled ONCE before the cleanup and
   * before any device connects. Without it the balance below would report the whole tree as
   * new on every restart: `upsertObject` runs `extendObject` on every state it touches (the
   * role/unit retrofit), so "did the create path run?" is not the same question as "is this
   * datapoint new?".
   */
  knownDatapoints = /* @__PURE__ */ new Set();
  createdDatapoints = 0;
  removedDatapoints = 0;
  /** Debounce for the balance line, so one config change produces ONE line, not one per device. */
  balanceTimer;
  /** Set when the start-up snapshot failed — a balance without it would be wrong, so none is written. */
  balanceDisabled = false;
  /**
   * @param options adapter options passed through by js-controller
   */
  constructor(options = {}) {
    super({
      ...options,
      name: "yamaha"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
    this.deviceManagement = new import_device_management.YamahaDeviceManagement(this);
  }
  /** Start a supervisor for each configured device, then subscribe to state changes. */
  async onReady() {
    try {
      await utils.I18n.init((0, import_node_path.join)(this.adapterDir, "admin"), this);
    } catch (e) {
      this.log.warn(`could not load admin translations (${(0, import_util.errorMessage)(e)}); card labels may be untranslated`);
    }
    try {
      this.log.info('starting \u2014 a "ready" message will follow for each device');
      await this.setState("info.connection", { val: false, ack: true });
      await this.migrateLegacyDevice();
      await this.migrateGroupZones();
      const configured = (0, import_pure_helpers.parseDevices)(
        this.config.devices,
        (dropped, takenId) => this.log.warn(`device "${dropped}" skipped \u2014 its object id "${takenId}" is already used by another device`)
      );
      const devices = configured.length > 0 ? configured : await this.autoDiscover();
      const knownDeviceIps = new Set(devices.map((device) => device.ip));
      await this.snapshotExistingDatapoints();
      await this.cleanupStaleObjects(new Set(devices.map((device) => device.id)));
      this.subscribeStates("*");
      const pushReceiver = new import_push_receiver.YxcPushReceiver({
        log: { debug: (message) => this.log.debug(message), warn: (message) => this.log.warn(message) },
        schedule: (cb, ms) => this.setTimeout(cb, ms),
        cancel: (handle) => this.clearTimeout(handle)
      });
      pushReceiver.start();
      this.pushReceiver = pushReceiver;
      if (configured.length > 0) {
        this.log.info(`setting up ${devices.length} configured device(s)...`);
      }
      for (const device of devices) {
        this.deviceConnected.set(device.id, false);
        await this.ensureDeviceHeader(device.id);
        const reachability = new import_reachability_dedup.ReachabilityDedup();
        const subunitCache = await this.loadYncaSubunitCache(device.id);
        const probeMemory = new import_probe_memory.ProbeMemory();
        const supervisor = new import_device_supervisor.DeviceSupervisor({
          attempt: () => this.attemptDevice(device, pushReceiver, knownDeviceIps, reachability, subunitCache, probeMemory),
          schedule: (cb, ms) => this.setTimeout(cb, ms),
          cancel: (handle) => this.clearTimeout(handle),
          onConnectionChange: (connected) => this.reportConnection(device.id, connected),
          backoff: new import_reconnect_strategy.ReconnectStrategy(RECONNECT_BASE_MS, RECONNECT_MAX_MS),
          log: {
            debug: (message) => this.log.debug(message),
            info: (message) => this.log.info(message),
            warn: (message) => this.log.warn(message)
          }
        });
        this.supervisors.push(supervisor);
        this.supervisorById.set(device.id, supervisor);
        supervisor.start();
      }
    } catch (e) {
      this.log.error(`onReady failed: ${(0, import_util.errorMessage)(e)}`);
    }
  }
  /**
   * Aggregate one device's connection state into the adapter's `info.connection`
   * (true while at least one device is connected).
   *
   * @param deviceId the device reporting
   * @param connected whether that device is currently connected
   */
  reportConnection(deviceId, connected) {
    this.deviceConnected.set(deviceId, connected);
    void this.setState(`${deviceId}.info.connection`, { val: connected, ack: true });
    if (!connected) {
      this.setTransports(deviceId, []);
    }
    const anyConnected = [...this.deviceConnected.values()].some(Boolean);
    void this.setState("info.connection", { val: anyConnected, ack: true });
  }
  /**
   * Reflect the live transport set into a device's `info.transports.*` flags so the
   * device-manager card shows which protocols (YNCA/YXC/XML) are connected right now.
   *
   * @param deviceId the id-safe device id
   * @param names the transports live now (empty on a drop)
   */
  setTransports(deviceId, names) {
    const live = new Set(names);
    for (const proto of TRANSPORT_IDS) {
      void this.setState(`${deviceId}.info.transports.${proto}`, { val: live.has(proto), ack: true });
    }
  }
  /**
   * One-shot startup cleanup: delete every object that does not belong to a
   * configured device (the previous adapter's whole tree, and any device dropped
   * from the config). Runs before the devices connect; a configured device's
   * subtree is kept whether or not it has connected yet.
   *
   * @param deviceIds the ids of the currently configured devices
   */
  async cleanupStaleObjects(deviceIds) {
    const allObjects = await this.getAdapterObjectsAsync();
    const existing = Object.keys(allObjects);
    const stale = (0, import_pure_helpers.staleObjects)(existing, deviceIds, this.namespace);
    const renamed = (0, import_pure_helpers.renamedObjectIds)(existing, deviceIds, this.namespace);
    const config = this.config;
    const disabled = existing.filter((full) => {
      for (const deviceId of deviceIds) {
        const base = `${this.namespace}.${deviceId}.`;
        if (full.startsWith(base) && !(0, import_groups.isGroupEnabled)(full.slice(base.length), config)) {
          return true;
        }
      }
      return false;
    });
    for (const fullId of [...stale, ...renamed, ...disabled]) {
      try {
        await this.delObjectAsync((0, import_pure_helpers.stripNamespace)(fullId, this.namespace));
      } catch {
      }
    }
    if (stale.length > 0) {
      this.log.debug(`removed ${stale.length} object(s) from a previous configuration`);
    }
    if (renamed.length > 0) {
      this.log.debug(`removed ${renamed.length} renamed object(s) from an earlier version`);
    }
    if (disabled.length > 0) {
      this.log.debug(`removed ${disabled.length} object(s) from switched-off datapoint groups`);
    }
    this.noteDatapointsRemoved(
      [...stale, ...renamed, ...disabled].filter((fullId) => {
        var _a;
        return ((_a = allObjects[fullId]) == null ? void 0 : _a.type) === "state";
      })
    );
  }
  /**
   * Remember every datapoint that already exists, ONCE per adapter run.
   *
   * @see knownDatapoints for why the create path alone cannot answer "is this new?"
   */
  async snapshotExistingDatapoints() {
    try {
      for (const [fullId, object] of Object.entries(await this.getAdapterObjectsAsync())) {
        if ((object == null ? void 0 : object.type) === "state") {
          this.knownDatapoints.add((0, import_pure_helpers.stripNamespace)(fullId, this.namespace));
        }
      }
    } catch (e) {
      this.log.debug(`could not read the existing datapoints (${(0, import_util.errorMessage)(e)}); balance line disabled`);
      this.balanceDisabled = true;
    }
  }
  /**
   * Count a datapoint the device tree just created — new ones only.
   *
   * @param id the state id relative to the namespace
   */
  noteDatapointCreated(id) {
    if (this.knownDatapoints.has(id)) {
      return;
    }
    this.knownDatapoints.add(id);
    this.createdDatapoints++;
    this.scheduleDatapointBalance();
  }
  /**
   * Count removed datapoints, and let them count again should they ever come back.
   *
   * @param fullIds the removed ids, namespace included
   */
  noteDatapointsRemoved(fullIds) {
    for (const fullId of fullIds) {
      this.knownDatapoints.delete((0, import_pure_helpers.stripNamespace)(fullId, this.namespace));
      this.removedDatapoints++;
    }
    if (fullIds.length > 0) {
      this.scheduleDatapointBalance();
    }
  }
  /**
   * Log the balance once the tree has settled. A device connects asynchronously and several
   * devices connect at once, so the line waits for quiet instead of firing per device — the
   * user made ONE change and reads ONE result.
   */
  scheduleDatapointBalance() {
    if (this.balanceDisabled) {
      return;
    }
    this.clearTimeout(this.balanceTimer);
    this.balanceTimer = this.setTimeout(() => {
      this.balanceTimer = void 0;
      const parts = [];
      if (this.createdDatapoints > 0) {
        parts.push(`created ${this.createdDatapoints} datapoint(s)`);
      }
      if (this.removedDatapoints > 0) {
        parts.push(`removed ${this.removedDatapoints} datapoint(s)`);
      }
      this.createdDatapoints = 0;
      this.removedDatapoints = 0;
      if (parts.length > 0) {
        this.log.info(`Object tree updated: ${parts.join(", ")}`);
      }
    }, DATAPOINT_BALANCE_SETTLE_MS);
  }
  /**
   * Create a device's header objects (the device node, its info channel and a
   * per-device connection indicator) so its state is visible even while offline.
   *
   * @param deviceId the id-safe device id
   */
  async ensureDeviceHeader(deviceId) {
    var _a;
    let icon;
    try {
      const existing = await this.getObjectAsync(deviceId);
      icon = ((_a = existing == null ? void 0 : existing.common) == null ? void 0 : _a.icon) ? void 0 : (0, import_device_type.iconForModel)(void 0);
    } catch {
      icon = void 0;
    }
    await this.extendObject(
      deviceId,
      {
        type: "device",
        common: {
          name: deviceId,
          ...icon ? { icon } : {},
          statusStates: { onlineId: `${this.namespace}.${deviceId}.info.connection` }
        },
        native: {}
      },
      { preserve: { common: ["name"] } }
    );
    await this.setObjectNotExistsAsync(`${deviceId}.info`, { type: "channel", common: { name: "Info" }, native: {} });
    await this.setObjectNotExistsAsync(`${deviceId}.info.connection`, {
      type: "state",
      common: { name: "Connected", type: "boolean", role: "indicator.reachable", read: true, write: false, def: false },
      native: {}
    });
    await this.setObjectNotExistsAsync(`${deviceId}.info.model`, {
      type: "state",
      common: { name: "Model", type: "string", role: "text", read: true, write: false, def: "" },
      native: {}
    });
    await this.setObjectNotExistsAsync(`${deviceId}.info.transports`, {
      type: "channel",
      common: { name: "Transports" },
      native: {}
    });
    for (const proto of TRANSPORT_IDS) {
      await this.setObjectNotExistsAsync(`${deviceId}.info.transports.${proto}`, {
        type: "state",
        common: {
          name: `${proto.toUpperCase()} connected`,
          type: "boolean",
          role: "indicator.reachable",
          read: true,
          write: false,
          def: false
        },
        native: {}
      });
    }
  }
  /** The icon last written per device, so repeated model reports do not re-write the object. */
  deviceIcons = /* @__PURE__ */ new Map();
  /** The label this adapter wrote per device, with the rank of the source behind it. */
  deviceLabels = /* @__PURE__ */ new Map();
  /**
   * Give the device node a name a user recognises, once the device reports one.
   *
   * An instance upgraded from the previous adapter carries the receiver's ip as its
   * device name — that adapter knew nothing but an ip, so the migration had nothing
   * else to call it. The object id stays that ip for good (history and visualisation
   * bindings hang off it), but the displayed name does not have to.
   *
   * A name the user typed is never touched, and the model never replaces a name the
   * device reported for itself — see {@link nextDeviceLabel}.
   *
   * @param deviceId the id-safe device id
   * @param candidate the reported name (a MusicCast zone name, or the model)
   * @param rank how trustworthy the candidate is
   */
  async updateDeviceLabel(deviceId, candidate, rank) {
    var _a, _b;
    const own = this.deviceLabels.get(deviceId);
    try {
      const current = (_b = (_a = await this.getObjectAsync(deviceId)) == null ? void 0 : _a.common) == null ? void 0 : _b.name;
      const label = (0, import_pure_helpers.nextDeviceLabel)(
        typeof current === "string" ? current : void 0,
        deviceId,
        candidate,
        rank,
        own == null ? void 0 : own.name,
        own == null ? void 0 : own.rank
      );
      if (label === void 0) {
        return;
      }
      await this.extendObject(deviceId, { common: { name: label } });
      this.deviceLabels.set(deviceId, { name: label, rank });
      this.log.debug(`${deviceId}: device name set to "${label}"`);
    } catch (e) {
      this.log.debug(`${deviceId}: setting the device name failed (${(0, import_util.errorMessage)(e)})`);
    }
  }
  /**
   * Paint the device-class silhouette on the device node once the model is known —
   * detected from the reported model name, written only when it actually changes.
   *
   * @param deviceId the id-safe device id
   * @param model the reported model name
   */
  async updateDeviceIcon(deviceId, model) {
    const icon = (0, import_device_type.iconForModel)(model);
    if (this.deviceIcons.get(deviceId) === icon) {
      return;
    }
    this.deviceIcons.set(deviceId, icon);
    try {
      await this.extendObject(deviceId, { common: { icon } });
    } catch (e) {
      this.log.debug(`${deviceId}: setting device icon failed (${(0, import_util.errorMessage)(e)})`);
    }
  }
  /**
   * Carry over the previous adapter's single-device config into the device table.
   * The old yamaha stored one receiver as `config.ip` (older installs: `config.IP`);
   * the new adapter uses a `devices` table, so an upgraded instance would otherwise
   * start with an empty table and lose its receiver. Persists the row so the admin
   * table shows it, and fills `this.config` in memory so this run already drives it.
   */
  async migrateLegacyDevice() {
    const config = this.config;
    const row = (0, import_pure_helpers.legacyDeviceRow)(config);
    if (!row) {
      return;
    }
    config.devices = [row];
    try {
      await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, { native: { devices: [row] } });
      this.log.info(`carried the previous single-device config (${row.ip}) over into the device table`);
    } catch (e) {
      this.log.warn(
        `could not persist the migrated device table (${(0, import_util.errorMessage)(e)}); running with the in-memory value`
      );
    }
  }
  /**
   * Fold the removed `group_zones` toggle into `group_multiroom` — zone 2/3/4 now
   * belong to the multiroom group. Existing installs that had zones on but multiroom
   * off would otherwise lose their zone datapoints after the update.
   */
  async migrateGroupZones() {
    const config = this.config;
    if (!("group_zones" in config)) {
      return;
    }
    if (config.group_zones && !config.group_multiroom) {
      config.group_multiroom = true;
    }
    delete config.group_zones;
    try {
      const obj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
      if (obj == null ? void 0 : obj.native) {
        if (obj.native.group_zones && !obj.native.group_multiroom) {
          obj.native.group_multiroom = true;
        }
        delete obj.native.group_zones;
        await this.setForeignObjectAsync(`system.adapter.${this.namespace}`, obj);
        this.log.info("migrated group_zones setting into group_multiroom");
      }
    } catch (e) {
      this.log.warn(`could not persist group_zones migration (${(0, import_util.errorMessage)(e)})`);
    }
  }
  /**
   * Bring one device online across ALL its transports: every protocol that answers
   * — YNCA (amp control over a held TCP connection), YXC (MusicCast), XML/YNC
   * (pre-2010) — connects in parallel on one object tree. Returns a connection handle
   * the supervisor keeps, or null when no transport answers this attempt. Each
   * datapoint is owned by exactly one transport (owner-policy), so the mappers never
   * collide on a shared id.
   *
   * @param device the configured device record
   * @param pushReceiver the shared YXC push receiver
   * @param knownDeviceIps IPs of all configured devices, for resolving a multiroom client
   * @param reachability dedup for the "no reachable transport" warning (one instance per device,
   *   held by the caller across retries — see {@link ReachabilityDedup})
   * @param yncaSubunitCache per-device cache of the YNCA AVAIL probe (skips the probe on reconnects)
   * @param probeMemory per-device memory for constant device answers (skips re-asking on reconnects)
   * @returns a connection handle, or null when no transport connected
   */
  attemptDevice(device, pushReceiver, knownDeviceIps, reachability, yncaSubunitCache, probeMemory) {
    return (0, import_attempt_device.attemptDevice)(device, {
      reachability,
      yncaSubunitCache,
      probeMemory,
      // Group gate for the YNCA sweep: a disabled group's functions are never even fetched.
      isEntryEnabled: (id) => (0, import_groups.isGroupEnabled)(id, this.config),
      log: {
        debug: (message) => this.log.debug(message),
        info: (message) => this.log.info(message),
        warn: (message) => this.log.warn(message)
      },
      upsertObject: async (id, def) => {
        if (!(0, import_groups.isGroupEnabled)(id.slice(id.indexOf(".") + 1), this.config)) {
          return;
        }
        await this.extendObject(id, { type: def.type, common: def.common, native: {} });
        if (def.type === "state") {
          this.noteDatapointCreated(id);
        }
      },
      setStateAck: (id, value) => {
        if (!(0, import_groups.isGroupEnabled)(id.slice(id.indexOf(".") + 1), this.config)) {
          return;
        }
        void this.setState(id, { val: value, ack: true });
        if (id.endsWith(".info.model") && typeof value === "string" && value.length > 0) {
          const reporting = id.slice(0, id.indexOf("."));
          void this.updateDeviceIcon(reporting, value);
          void this.updateDeviceLabel(reporting, value, import_pure_helpers.LABEL_RANK.model);
        }
      },
      onDeviceName: (name) => void this.updateDeviceLabel(device.id, name, import_pure_helpers.LABEL_RANK.deviceName),
      timers: {
        schedule: (handler, ms) => this.setTimeout(handler, ms),
        cancel: (handle) => this.clearTimeout(handle)
      },
      registerPush: (ip, onPush) => pushReceiver.register(ip, onPush),
      pushActive: () => pushReceiver.isListening(),
      scheduleKeepalive: (handler, ms) => {
        const timer = this.setInterval(handler, ms);
        return () => {
          if (timer) {
            this.clearInterval(timer);
          }
        };
      },
      xmlPollIntervalMs: this.xmlPollIntervalMs(),
      onTransports: (names) => this.setTransports(device.id, names),
      knownDeviceIps
    });
  }
  /**
   * Route a state change to every device's supervisor (each forwards to its
   * active controller, which ignores ids outside its subtree and its acked echoes).
   *
   * @param id the full state id
   * @param state the new state (null when deleted)
   */
  onStateChange(id, state) {
    var _a;
    if (!state) {
      return;
    }
    const relative = (0, import_pure_helpers.stripNamespace)(id, this.namespace);
    const deviceId = relative.slice(0, relative.indexOf("."));
    (_a = this.supervisorById.get(deviceId)) == null ? void 0 : _a.handleStateChange(relative, state.ack, state.val);
  }
  /**
   * Synchronous teardown — no await, call the callback immediately (SIGKILL otherwise).
   *
   * @param callback function to invoke once teardown is complete
   */
  onUnload(callback) {
    var _a;
    try {
      this.clearTimeout(this.balanceTimer);
      (_a = this.pushReceiver) == null ? void 0 : _a.close();
      for (const supervisor of this.supervisors) {
        supervisor.close();
      }
      void this.setState("info.connection", { val: false, ack: true });
      callback();
    } catch {
      callback();
    }
  }
  /**
   * Auto-discovery for an empty device table: scan the network, merge the finds with
   * the devices remembered from earlier runs (standby protection), persist the merged
   * set and return it. XML/pre-2010 receivers do not answer SSDP and never appear here.
   *
   * @returns the device records to run this session
   */
  async autoDiscover() {
    const store = (0, import_discovered_store_deps.discoveredStoreDeps)(this);
    const known = await (0, import_discovered_store.readDiscovered)(store);
    this.log.info("auto-discovery via SSDP (older XML-only devices must be added manually)");
    let found = [];
    try {
      found = await (0, import_discovery.discoverYamaha)({
        search: (target, ms) => this.ssdpSearch(target, ms),
        fetch: (url) => this.fetchUrl(url),
        log: { debug: (message) => this.log.debug(message), warn: (message) => this.log.warn(message) }
      });
    } catch (e) {
      this.log.warn(`auto-discovery scan failed, using the remembered devices: ${(0, import_util.errorMessage)(e)}`);
    }
    const merged = (0, import_pure_helpers.mergeDiscovered)(
      known,
      found,
      (dropped, takenId) => this.log.warn(`discovered device "${dropped}" skipped \u2014 its object id "${takenId}" is already taken`)
    );
    await (0, import_discovered_store.writeDiscovered)(store, merged);
    const remembered = merged.length - found.length;
    const suffix = remembered > 0 ? ` (${remembered} more remembered from a previous run)` : "";
    this.log.info(`setting up ${merged.length} discovered device(s)${suffix}...`);
    return merged;
  }
  /**
   * Load a device's persisted YNCA subunit-cache (the AVAIL probe result) from its
   * device object's native part, wrapped so updates persist back there. The device
   * object is the right home: writing an instance object's native restarts the
   * adapter, a device object's does not.
   *
   * @param deviceId the id-safe device id
   * @returns the per-device cache
   */
  async loadYncaSubunitCache(deviceId) {
    var _a, _b;
    let stored;
    try {
      stored = (_b = (_a = await this.getObjectAsync(deviceId)) == null ? void 0 : _a.native) == null ? void 0 : _b.yncaAvail;
    } catch {
      stored = void 0;
    }
    return (0, import_subunit_cache.createSubunitCache)((0, import_subunit_cache.isAvailSnapshot)(stored) ? stored : void 0, (snapshot) => {
      void this.extendObject(deviceId, { native: { yncaAvail: snapshot != null ? snapshot : null } });
    });
  }
  /**
   * The XML/YNC poll interval in milliseconds, from `config.xmlPollInterval`
   * (seconds, default 60).
   *
   * @returns the interval in ms
   */
  xmlPollIntervalMs() {
    const seconds = Number(this.config.xmlPollInterval);
    return (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1e3;
  }
  /**
   * Run an SSDP M-SEARCH and collect the responders' description URL and address.
   *
   * With a configured network interface the search leaves exactly that one; left empty it
   * leaves EVERY non-internal IPv4 interface at once (one socket each), because multicast
   * egress otherwise follows only the host's default route — on a multi-homed host whose
   * default route is not the AV network that means the receiver is never reached and nothing
   * is found. Responders from all interfaces are merged into one list; the caller
   * de-duplicates by address.
   *
   * @param target the search target (device type)
   * @param timeoutMs how long to collect responses
   * @returns the responders
   */
  ssdpSearch(target, timeoutMs) {
    return new Promise((resolve) => {
      const bindAddrs = (0, import_network_interfaces.searchInterfaces)(this.config.networkInterface, (0, import_node_os.networkInterfaces)());
      const responders = [];
      const sockets = [];
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        for (const socket of sockets) {
          try {
            socket.close();
          } catch {
          }
        }
        resolve(responders);
      };
      const searchFrom = (bindAddr) => {
        const socket = (0, import_node_dgram.createSocket)("udp4");
        sockets.push(socket);
        socket.on("message", (msg, rinfo) => {
          const location = /LOCATION:\s*(\S+)/i.exec(msg.toString());
          if (location) {
            responders.push({ location: location[1], address: rinfo.address });
          }
        });
        socket.on("error", (err) => {
          this.log.warn(
            `discovery socket failed${bindAddr ? ` on interface ${bindAddr}` : ""}: ${(0, import_util.errorMessage)(err)}${bindAddr ? " \u2014 check the Network Interface setting" : ""}`
          );
          try {
            socket.close();
          } catch {
          }
        });
        const sendSearch = () => {
          if (settled) {
            return;
          }
          const msearch = `M-SEARCH * HTTP/1.1\r
HOST: 239.255.255.250:1900\r
MAN: "ssdp:discover"\r
MX: 3\r
ST: ${target}\r
\r
`;
          try {
            socket.send(msearch, 1900, "239.255.255.250");
          } catch {
          }
        };
        socket.bind(0, bindAddr, () => {
          if (bindAddr) {
            try {
              socket.setMulticastInterface(bindAddr);
            } catch {
              this.log.info(`discovery: could not pin multicast egress to ${bindAddr} \u2014 using the default interface`);
            }
          }
          for (let i = 0; i < SSDP_SEARCH_BURST; i++) {
            this.setTimeout(sendSearch, i * SSDP_SEARCH_INTERVAL_MS);
          }
        });
      };
      if (bindAddrs.length === 0) {
        searchFrom(void 0);
      } else {
        for (const bindAddr of bindAddrs) {
          searchFrom(bindAddr);
        }
      }
      this.setTimeout(finish, timeoutMs);
    });
  }
  /**
   * Fetch a URL over HTTP and resolve its body.
   *
   * @param url the URL to fetch
   * @returns the response body
   */
  fetchUrl(url) {
    return new Promise((resolve, reject) => {
      const req = (0, import_node_http.get)(url, (res) => {
        let data = "";
        res.on("data", (chunk) => data += String(chunk));
        res.on("error", reject);
        res.on("end", () => resolve(data));
      });
      req.on("error", reject);
      req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error(`fetch timed out: ${url}`)));
    });
  }
}
if (require.main !== module) {
  module.exports = (options) => new Yamaha(options);
} else {
  (() => new Yamaha())();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Yamaha
});
//# sourceMappingURL=main.js.map
