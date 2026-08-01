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
var import_yamaha_yxc_nodejs = require("yamaha-yxc-nodejs");
var import_pure_helpers = require("./lib/pure-helpers");
var import_ynca_client = require("./lib/ynca/ynca-client");
var import_device_controller = require("./lib/device-controller");
var import_device_controller2 = require("./lib/yxc/device-controller");
var import_push_receiver = require("./lib/yxc/push-receiver");
var import_device_controller3 = require("./lib/xml/device-controller");
var import_xml_client = require("./lib/xml/xml-client");
const SWEEP_ZONES = ["MAIN", "ZONE2", "ZONE3", "ZONE4"];
const SWEEP_FUNCS = ["PWR", "VOL", "MUTE", "INP", "SOUNDPRG"];
const SWEEP_GETS = [
  { subunit: "SYS", func: "MODELNAME" },
  ...SWEEP_ZONES.flatMap((zone) => SWEEP_FUNCS.map((func) => ({ subunit: zone, func })))
];
class Yamaha extends utils.Adapter {
  controllers = [];
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
    this.on("unload", this.onUnload.bind(this));
  }
  /** Start a controller for each configured device, then subscribe to state changes. */
  async onReady() {
    try {
      await this.setState("info.connection", { val: false, ack: true });
      const devices = (0, import_pure_helpers.parseDevices)(this.config.devices);
      this.subscribeStates("*");
      const pushReceiver = new import_push_receiver.YxcPushReceiver({
        debug: (message) => this.log.debug(message),
        warn: (message) => this.log.warn(message)
      });
      pushReceiver.start();
      this.pushReceiver = pushReceiver;
      let anyConnected = false;
      for (const device of devices) {
        if (await this.startDevice(device, pushReceiver)) {
          anyConnected = true;
        }
      }
      await this.setState("info.connection", { val: anyConnected, ack: true });
    } catch (e) {
      this.log.error(`onReady failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  /**
   * Bring one device online: try YNCA (amp control), else fall back to YXC
   * (MusicCast). The transport that connects owns the device's object tree, so
   * the two mappers never collide on a shared id.
   *
   * @param device the configured device record
   * @param pushReceiver the shared YXC push receiver
   * @returns true if a transport connected
   */
  async startDevice(device, pushReceiver) {
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
    const ynca = new import_device_controller.YncaDeviceController(device.id, {
      client: new import_ynca_client.YncaClient(device.ip, timers),
      upsertObject,
      setStateAck,
      log
    });
    try {
      if (await ynca.start(SWEEP_GETS)) {
        this.controllers.push(ynca);
        return true;
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
        this.controllers.push(yxc);
        return true;
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
        this.controllers.push(xml);
        return true;
      }
      xml.close();
    } catch (e) {
      xml.close();
      this.log.warn(
        `${device.id}: no reachable transport (YNCA/YXC/XML): ${e instanceof Error ? e.message : String(e)}`
      );
    }
    return false;
  }
  /**
   * Route a state change to every device controller (each ignores ids outside
   * its own subtree and its own acked echoes).
   *
   * @param id the full state id
   * @param state the new state (null when deleted)
   */
  onStateChange(id, state) {
    if (!state) {
      return;
    }
    const relative = (0, import_pure_helpers.stripNamespace)(id, this.namespace);
    for (const controller of this.controllers) {
      controller.handleStateChange(relative, state.ack, state.val);
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
      for (const controller of this.controllers) {
        controller.close();
      }
      void this.setState("info.connection", { val: false, ack: true });
      callback();
    } catch {
      callback();
    }
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
