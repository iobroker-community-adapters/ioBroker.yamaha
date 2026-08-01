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
  XmlDeviceController: () => XmlDeviceController
});
module.exports = __toCommonJS(device_controller_exports);
var import_command_mapper = require("./command-mapper");
const KEEPALIVE_MS = 60 * 1e3;
const XML_ZONES = [
  { key: "main", element: "Main_Zone", prefix: "" },
  { key: "zone2", element: "Zone_2", prefix: "zone2.", channel: "zone2", channelName: "Zone 2" },
  { key: "zone3", element: "Zone_3", prefix: "zone3.", channel: "zone3", channelName: "Zone 3" },
  { key: "zone4", element: "Zone_4", prefix: "zone4.", channel: "zone4", channelName: "Zone 4" }
];
const XML_AMP_STATES = [
  { state: "power", common: { name: "Power", type: "boolean", role: "switch.power", read: true, write: true } },
  {
    state: "volume",
    common: { name: "Volume", type: "number", role: "level.volume", read: true, write: true, unit: "dB" }
  },
  { state: "mute", common: { name: "Mute", type: "boolean", role: "media.mute", read: true, write: true } },
  { state: "input", common: { name: "Input", type: "string", role: "media.input", read: true, write: true } }
];
class XmlDeviceController {
  /**
   * @param deviceId the id-safe device id (object-tree path segment)
   * @param deps the client and adapter callbacks
   */
  constructor(deviceId, deps) {
    this.deviceId = deviceId;
    this.deps = deps;
  }
  zones = [];
  cancelKeepalive;
  /**
   * Probe each zone, create the tree for the ones that answer, seed state, and
   * start the keepalive poll.
   *
   * @returns true if the main zone answered and the tree was created
   */
  async start() {
    var _a;
    for (const zone of XML_ZONES) {
      const status = await this.tryGetStatus(zone.element);
      if (status && Object.keys(status).length > 0) {
        this.zones.push(zone);
      } else if (zone.key === "main") {
        this.deps.log.debug(`${this.deviceId}: no XML main zone \u2014 creating no objects`);
        return false;
      }
    }
    if (this.zones.length === 0) {
      return false;
    }
    for (const zone of this.zones) {
      if (zone.channel) {
        await this.deps.upsertObject(`${this.deviceId}.${zone.channel}`, {
          id: zone.channel,
          type: "channel",
          common: { name: (_a = zone.channelName) != null ? _a : zone.channel }
        });
      }
      for (const state of XML_AMP_STATES) {
        await this.deps.upsertObject(`${this.deviceId}.${zone.prefix}${state.state}`, {
          id: `${zone.prefix}${state.state}`,
          type: "state",
          common: { ...state.common }
        });
      }
    }
    for (const zone of this.zones) {
      await this.refreshZone(zone);
    }
    this.cancelKeepalive = this.deps.scheduleKeepalive(() => void this.keepalive(), KEEPALIVE_MS);
    this.deps.log.info(`${this.deviceId}: Yamaha (XML) device ready`);
    return true;
  }
  /**
   * Handle a state change: a user write (ack false) becomes an XML command; an
   * acked change (the device's own echo) is ignored.
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
    const command = (0, import_command_mapper.stateToXml)(fullStateId.slice(prefix.length), value);
    if (command) {
      void this.applyCommand(command);
    }
  }
  /** Cancel the keepalive poll. Synchronous — safe to call from onUnload. */
  close() {
    var _a;
    (_a = this.cancelKeepalive) == null ? void 0 : _a.call(this);
    this.cancelKeepalive = void 0;
  }
  /** Poll every live zone's status. */
  async keepalive() {
    for (const zone of this.zones) {
      await this.refreshZone(zone);
    }
  }
  /**
   * Fetch a zone's status and write its amp states with ack.
   *
   * @param zone the zone to refresh
   */
  async refreshZone(zone) {
    const status = await this.tryGetStatus(zone.element);
    if (!status) {
      return;
    }
    for (const update of (0, import_command_mapper.parseXmlStatus)(status, zone.key)) {
      this.deps.setStateAck(`${this.deviceId}.${update.id}`, update.value);
    }
  }
  /**
   * Read a zone's status, swallowing errors (an absent zone or an offline device).
   *
   * @param element the XML zone element
   * @returns the parsed status, or undefined on failure
   */
  async tryGetStatus(element) {
    try {
      return await this.deps.client.getStatus(element);
    } catch (e) {
      this.deps.log.debug(
        `${this.deviceId}: getStatus(${element}) failed: ${e instanceof Error ? e.message : String(e)}`
      );
      return void 0;
    }
  }
  /**
   * Send a mapped command to the device.
   *
   * @param command the XML command to apply
   */
  async applyCommand(command) {
    try {
      await this.deps.client.send(command.zone, command.inner);
    } catch (e) {
      this.deps.log.warn(`${this.deviceId}: XML command failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  XmlDeviceController
});
//# sourceMappingURL=device-controller.js.map
