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
  YxcDeviceController: () => YxcDeviceController
});
module.exports = __toCommonJS(device_controller_exports);
var import_capability = require("./capability");
var import_object_mapper = require("./object-mapper");
var import_command_mapper = require("./command-mapper");
var import_push = require("./push");
const KEEPALIVE_MS = 5 * 60 * 1e3;
class YxcDeviceController {
  /**
   * @param deviceId the id-safe device id (object-tree path segment)
   * @param deps the client and adapter callbacks
   */
  constructor(deviceId, deps) {
    this.deviceId = deviceId;
    this.deps = deps;
  }
  zones = [];
  hasPlayer = false;
  hasCd = false;
  hasTuner = false;
  cancelKeepalive;
  /**
   * Read capabilities, create the object tree, seed state, and wire up push +
   * keepalive.
   *
   * @returns true if the device reported capabilities and its tree was created
   */
  async start() {
    const capabilities = (0, import_capability.parseYxcFeatures)(await this.deps.client.getFeatures());
    const objects = (0, import_object_mapper.mapYxcToObjects)(capabilities);
    if (objects.length === 0) {
      this.deps.log.warn(`${this.deviceId}: no capabilities reported \u2014 creating no objects`);
      return false;
    }
    for (const object of objects) {
      await this.deps.upsertObject(`${this.deviceId}.${object.id}`, object);
    }
    this.zones = capabilities.zones.map((zone) => zone.id);
    for (const zone of this.zones) {
      await this.refreshZone(zone);
    }
    this.hasPlayer = capabilities.media.includes("netusb");
    this.hasCd = capabilities.media.includes("cd");
    this.hasTuner = capabilities.media.includes("tuner");
    await this.refreshMedia();
    this.deps.registerPush((event) => this.onPush(event));
    this.cancelKeepalive = this.deps.scheduleKeepalive(() => void this.keepalive(), KEEPALIVE_MS);
    this.deps.log.info(`${this.deviceId}: MusicCast device ready`);
    return true;
  }
  /**
   * Handle a state change: a user write (ack false) becomes a YXC command; an
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
    const command = (0, import_command_mapper.stateToYxc)(fullStateId.slice(prefix.length), value);
    if (command) {
      void this.applyCommand(command);
    }
  }
  /** Cancel the keepalive. Synchronous — safe to call from onUnload. */
  close() {
    var _a;
    (_a = this.cancelKeepalive) == null ? void 0 : _a.call(this);
    this.cancelKeepalive = void 0;
  }
  /**
   * Handle a device push: each named zone is re-fetched via getStatus (the push
   * itself is a change signal, not a value carrier).
   *
   * @param event the parsed push event
   */
  onPush(event) {
    for (const zone of (0, import_push.zonesToRefresh)(event)) {
      if (this.zones.includes(zone)) {
        void this.refreshZone(zone);
      }
    }
  }
  /** Poll the primary zone, which renews the push registration and refreshes state. */
  async keepalive() {
    var _a;
    await this.refreshZone((_a = this.zones[0]) != null ? _a : "main");
    await this.refreshMedia();
  }
  /** Refresh every player source the device offers (network player, cd, tuner). */
  async refreshMedia() {
    if (this.hasPlayer) {
      await this.refreshPlayInfo(void 0, import_command_mapper.parseYxcPlayInfo, "getPlayInfo");
    }
    if (this.hasCd) {
      await this.refreshPlayInfo("cd", (info) => (0, import_command_mapper.parseYxcPlayInfo)(info, "cd"), 'getPlayInfo("cd")');
    }
    if (this.hasTuner) {
      await this.refreshPlayInfo("tuner", import_command_mapper.parseYxcTunerInfo, 'getPlayInfo("tuner")');
    }
  }
  /**
   * Fetch a player source's play info and write the parsed states with ack.
   *
   * @param source the play-info source (undefined = network player, `cd`, `tuner`)
   * @param parse turn the response into state updates
   * @param label how to name the call in a debug log on failure
   */
  async refreshPlayInfo(source, parse, label) {
    try {
      const info = await this.deps.client.getPlayInfo(source);
      for (const update of parse(info)) {
        this.deps.setStateAck(`${this.deviceId}.${update.id}`, update.value);
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: ${label} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  /**
   * Fetch a zone's status and write its amp states with ack.
   *
   * @param zone the zone to refresh
   */
  async refreshZone(zone) {
    try {
      const status = await this.deps.client.getStatus(zone);
      for (const update of (0, import_command_mapper.parseYxcStatus)(status, zone)) {
        this.deps.setStateAck(`${this.deviceId}.${update.id}`, update.value);
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getStatus(${zone}) failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  /**
   * Send a mapped command to the device through the matching client method.
   *
   * @param command the YXC command to apply
   */
  async applyCommand(command) {
    const { zone, value } = command;
    try {
      switch (command.method) {
        case "power":
          await this.deps.client.power(Boolean(value), zone);
          break;
        case "setVolumeTo":
          await this.deps.client.setVolumeTo(Number(value), zone);
          break;
        case "mute":
          await this.deps.client.mute(Boolean(value), zone);
          break;
        case "setInput":
          await this.deps.client.setInput(String(value), zone);
          break;
        case "setSound":
          await this.deps.client.setSound(String(value), zone);
          break;
        case "setEnhancer":
          await this.deps.client.setEnhancer(Boolean(value), zone);
          break;
        case "setPureDirect":
          await this.deps.client.setPureDirect(Boolean(value), zone);
          break;
        case "setSubwooferVolumeTo":
          await this.deps.client.setSubwooferVolumeTo(Number(value), zone);
          break;
        case "playNet":
          await this.deps.client.playNet();
          break;
        case "pauseNet":
          await this.deps.client.pauseNet();
          break;
        case "stopNet":
          await this.deps.client.stopNet();
          break;
        case "nextNet":
          await this.deps.client.nextNet();
          break;
        case "prevNet":
          await this.deps.client.prevNet();
          break;
        case "setCDPlayback":
          await this.deps.client.setCDPlayback(String(value));
          break;
      }
    } catch (e) {
      this.deps.log.warn(`${this.deviceId}: ${command.method} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  YxcDeviceController
});
//# sourceMappingURL=device-controller.js.map
