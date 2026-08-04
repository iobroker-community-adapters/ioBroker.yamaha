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
var import_yamaha_yxc_nodejs = require("yamaha-yxc-nodejs");
var import_pure_helpers = require("./lib/pure-helpers");
var import_discovery = require("./lib/discovery");
var import_ynca_client = require("./lib/ynca/ynca-client");
var import_device_controller = require("./lib/device-controller");
var import_device_controller2 = require("./lib/yxc/device-controller");
var import_push_receiver = require("./lib/yxc/push-receiver");
var import_device_controller3 = require("./lib/xml/device-controller");
var import_xml_client = require("./lib/xml/xml-client");
var import_device_supervisor = require("./lib/lifecycle/device-supervisor");
var import_reconnect_strategy = require("./lib/lifecycle/reconnect-strategy");
const RECONNECT_BASE_MS = 1e3;
const RECONNECT_MAX_MS = 6e4;
class Yamaha extends utils.Adapter {
  supervisors = [];
  deviceConnected = /* @__PURE__ */ new Map();
  pushReceiver;
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
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  /** Start a supervisor for each configured device, then subscribe to state changes. */
  async onReady() {
    try {
      await this.setState("info.connection", { val: false, ack: true });
      await this.migrateLegacyDevice();
      const devices = (0, import_pure_helpers.parseDevices)(this.config.devices);
      await this.cleanupStaleObjects(new Set(devices.map((device) => device.id)));
      this.subscribeStates("*");
      const pushReceiver = new import_push_receiver.YxcPushReceiver({
        debug: (message) => this.log.debug(message),
        warn: (message) => this.log.warn(message)
      });
      pushReceiver.start();
      this.pushReceiver = pushReceiver;
      for (const device of devices) {
        this.deviceConnected.set(device.id, false);
        await this.ensureDeviceHeader(device.id);
        const supervisor = new import_device_supervisor.DeviceSupervisor({
          attempt: () => this.attemptDevice(device, pushReceiver),
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
        supervisor.start();
      }
    } catch (e) {
      this.log.error(`onReady failed: ${e instanceof Error ? e.message : String(e)}`);
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
    const anyConnected = [...this.deviceConnected.values()].some(Boolean);
    void this.setState("info.connection", { val: anyConnected, ack: true });
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
    const existing = Object.keys(await this.getAdapterObjectsAsync());
    const stale = (0, import_pure_helpers.staleObjects)(existing, deviceIds, this.namespace);
    for (const fullId of stale) {
      try {
        await this.delObjectAsync((0, import_pure_helpers.stripNamespace)(fullId, this.namespace));
      } catch {
      }
    }
    if (stale.length > 0) {
      this.log.info(`removed ${stale.length} object(s) from a previous configuration`);
    }
  }
  /**
   * Create a device's header objects (the device node, its info channel and a
   * per-device connection indicator) so its state is visible even while offline.
   *
   * @param deviceId the id-safe device id
   */
  async ensureDeviceHeader(deviceId) {
    await this.setObjectNotExistsAsync(deviceId, { type: "device", common: { name: deviceId }, native: {} });
    await this.setObjectNotExistsAsync(`${deviceId}.info`, { type: "channel", common: { name: "Info" }, native: {} });
    await this.setObjectNotExistsAsync(`${deviceId}.info.connection`, {
      type: "state",
      common: { name: "Connected", type: "boolean", role: "indicator.connected", read: true, write: false, def: false },
      native: {}
    });
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
        `could not persist the migrated device table (${e instanceof Error ? e.message : String(e)}); running with the in-memory value`
      );
    }
  }
  /**
   * Bring one device online across its transports, tried in order: YNCA (amp
   * control over a held TCP connection), then YXC (MusicCast), then XML/YNC
   * (pre-2010). Returns a connection handle the supervisor keeps, or null when no
   * transport answers this attempt. The transport that connects owns the device's
   * object tree, so the mappers never collide on a shared id.
   *
   * @param device the configured device record
   * @param pushReceiver the shared YXC push receiver
   * @returns a connection handle, or null when no transport connected
   */
  async attemptDevice(device, pushReceiver) {
    const log = {
      debug: (message) => this.log.debug(message),
      info: (message) => this.log.info(message),
      warn: (message) => this.log.warn(message)
    };
    const upsertObject = async (id, def) => {
      await this.extendObject(id, { type: def.type, common: def.common, native: {} });
    };
    const setStateAck = (id, value) => void this.setState(id, { val: value, ack: true });
    const timers = {
      schedule: (handler, ms) => this.setTimeout(handler, ms),
      cancel: (handle) => this.clearTimeout(handle)
    };
    const yncaClient = new import_ynca_client.YncaClient(device.ip, timers);
    const ynca = new import_device_controller.YncaDeviceController(device.id, { client: yncaClient, upsertObject, setStateAck, log });
    try {
      if (await ynca.start()) {
        return {
          onDrop: (cb) => yncaClient.onDrop(cb),
          handleStateChange: (id, ack, value) => ynca.handleStateChange(id, ack, value),
          close: () => ynca.close()
        };
      }
      ynca.close();
    } catch (e) {
      ynca.close();
      this.log.debug(`${device.id}: no YNCA (${e instanceof Error ? e.message : String(e)})`);
    }
    const yxc = new import_device_controller2.YxcDeviceController(device.id, {
      client: new import_yamaha_yxc_nodejs.YamahaYXC(device.ip),
      registerPush: (onPush) => pushReceiver.register(device.ip, onPush),
      scheduleKeepalive: (handler, ms) => {
        const timer = this.setInterval(handler, ms);
        return () => {
          if (timer) {
            this.clearInterval(timer);
          }
        };
      },
      upsertObject,
      setStateAck,
      log
    });
    try {
      if (await yxc.start()) {
        return {
          onDrop: () => {
          },
          handleStateChange: (id, ack, value) => yxc.handleStateChange(id, ack, value),
          close: () => yxc.close()
        };
      }
      yxc.close();
    } catch (e) {
      yxc.close();
      this.log.debug(`${device.id}: no YXC (${e instanceof Error ? e.message : String(e)})`);
    }
    const xml = new import_device_controller3.XmlDeviceController(device.id, {
      client: new import_xml_client.XmlClient(device.ip),
      scheduleKeepalive: (handler, ms) => {
        const timer = this.setInterval(handler, ms);
        return () => {
          if (timer) {
            this.clearInterval(timer);
          }
        };
      },
      upsertObject,
      setStateAck,
      log
    });
    try {
      if (await xml.start()) {
        return {
          onDrop: () => {
          },
          handleStateChange: (id, ack, value) => xml.handleStateChange(id, ack, value),
          close: () => xml.close()
        };
      }
      xml.close();
    } catch (e) {
      xml.close();
      this.log.warn(
        `${device.id}: no reachable transport (YNCA/YXC/XML): ${e instanceof Error ? e.message : String(e)}`
      );
    }
    return null;
  }
  /**
   * Route a state change to every device's supervisor (each forwards to its
   * active controller, which ignores ids outside its subtree and its acked echoes).
   *
   * @param id the full state id
   * @param state the new state (null when deleted)
   */
  onStateChange(id, state) {
    if (!state) {
      return;
    }
    const relative = (0, import_pure_helpers.stripNamespace)(id, this.namespace);
    for (const supervisor of this.supervisors) {
      supervisor.handleStateChange(relative, state.ack, state.val);
    }
  }
  /**
   * Synchronous teardown — no await, call the callback immediately (SIGKILL otherwise).
   *
   * @param callback function to invoke once teardown is complete
   */
  onUnload(callback) {
    var _a;
    try {
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
   * Handle an admin message: `discover` scans the network for Yamaha devices and
   * returns the configured plus discovered devices (deduped by IP) for the table.
   *
   * @param obj the incoming message
   */
  async onMessage(obj) {
    if (obj.command !== "discover") {
      return;
    }
    try {
      const found = await (0, import_discovery.discoverYamaha)({
        search: (target, ms) => this.ssdpSearch(target, ms),
        fetch: (url) => this.fetchUrl(url),
        log: { debug: (message) => this.log.debug(message), warn: (message) => this.log.warn(message) }
      });
      const devices = (0, import_pure_helpers.parseDevices)(this.config.devices).map((device) => ({ name: device.id, ip: device.ip }));
      for (const device of found) {
        if (!devices.some((existing) => existing.ip === device.ip)) {
          devices.push({ name: device.name || device.ip, ip: device.ip });
        }
      }
      if (obj.callback) {
        this.sendTo(obj.from, obj.command, { native: { devices } }, obj.callback);
      }
    } catch (e) {
      this.log.warn(`discover failed: ${e instanceof Error ? e.message : String(e)}`);
      if (obj.callback) {
        this.sendTo(obj.from, obj.command, { error: "discover failed" }, obj.callback);
      }
    }
  }
  /**
   * Run an SSDP M-SEARCH and collect the responders' description URL and address.
   *
   * @param target the search target (device type)
   * @param timeoutMs how long to collect responses
   * @returns the responders
   */
  ssdpSearch(target, timeoutMs) {
    return new Promise((resolve) => {
      const socket = (0, import_node_dgram.createSocket)("udp4");
      const responders = [];
      socket.on("message", (msg, rinfo) => {
        const location = /LOCATION:\s*(\S+)/i.exec(msg.toString());
        if (location) {
          responders.push({ location: location[1], address: rinfo.address });
        }
      });
      socket.on("error", () => socket.close());
      socket.bind(() => {
        const msearch = `M-SEARCH * HTTP/1.1\r
HOST: 239.255.255.250:1900\r
MAN: "ssdp:discover"\r
MX: 3\r
ST: ${target}\r
\r
`;
        socket.send(msearch, 1900, "239.255.255.250");
      });
      this.setTimeout(() => {
        socket.close();
        resolve(responders);
      }, timeoutMs);
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
      (0, import_node_http.get)(url, (res) => {
        let data = "";
        res.on("data", (chunk) => data += String(chunk));
        res.on("end", () => resolve(data));
      }).on("error", reject);
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
