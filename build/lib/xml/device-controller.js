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
var import_types = require("../catalog/types");
var import_command_mapper = require("./command-mapper");
var import_catalog = require("./catalog");
var import_util = require("../util");
var import_poll_drop_detector = require("../lifecycle/poll-drop-detector");
var import_surface = require("../browse/surface");
var import_xml_browse_driver = require("../browse/xml-browse-driver");
const DEFAULT_POLL_INTERVAL_MS = 60 * 1e3;
const XML_ZONES = [
  { key: "main", element: "Main_Zone", prefix: "" },
  { key: "zone2", element: "Zone_2", prefix: "multiroom.zone2.", channel: "multiroom.zone2", channelName: "Zone 2" },
  { key: "zone3", element: "Zone_3", prefix: "multiroom.zone3.", channel: "multiroom.zone3", channelName: "Zone 3" },
  { key: "zone4", element: "Zone_4", prefix: "multiroom.zone4.", channel: "multiroom.zone4", channelName: "Zone 4" }
];
class XmlDeviceController {
  /**
   * @param deviceId the id-safe device id (object-tree path segment)
   * @param deps the client and adapter callbacks
   * @param pollIntervalMs how often to poll the device for state (default 60 s)
   */
  constructor(deviceId, deps, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS) {
    this.deviceId = deviceId;
    this.deps = deps;
    this.pollIntervalMs = pollIntervalMs;
  }
  zones = [];
  cancelKeepalive;
  dropDetector = new import_poll_drop_detector.PollDropDetector();
  browseEngine;
  /**
   * Probe each zone, create the tree for the ones that answer, seed state, and
   * start the keepalive poll.
   *
   * @returns true if the main zone answered and the tree was created
   */
  async start() {
    var _a, _b, _c;
    const probes = await Promise.all(
      XML_ZONES.map(async (zone) => ({ zone, status: await this.tryGetStatus(zone.element) }))
    );
    const answered = probes.filter((probe) => probe.status && Object.keys(probe.status).length > 0);
    if (!answered.some((probe) => probe.zone.key === "main")) {
      this.deps.log.debug(`${this.deviceId}: no XML main zone \u2014 creating no objects`);
      return false;
    }
    this.zones = answered.map((probe) => probe.zone);
    const createdChannels = /* @__PURE__ */ new Set();
    for (const zone of this.zones) {
      if (zone.channel) {
        const chSegments = zone.channel.split(".");
        for (let i = 1; i < chSegments.length; i++) {
          const parentId = chSegments.slice(0, i).join(".");
          if (!createdChannels.has(parentId)) {
            createdChannels.add(parentId);
            const seg = chSegments[i - 1];
            await this.deps.upsertObject(`${this.deviceId}.${parentId}`, {
              id: parentId,
              type: "channel",
              common: { name: (_a = import_types.CHANNEL_NAMES[seg]) != null ? _a : seg.charAt(0).toUpperCase() + seg.slice(1) }
            });
          }
        }
        createdChannels.add(zone.channel);
        await this.deps.upsertObject(`${this.deviceId}.${zone.channel}`, {
          id: zone.channel,
          type: "channel",
          common: { name: (_b = zone.channelName) != null ? _b : zone.channel }
        });
      }
      for (const entry of import_catalog.XML_AMP_CATALOG) {
        if (entry.mainOnly && zone.key !== "main") {
          continue;
        }
        const stateId = `${zone.prefix}${entry.state}`;
        const segments = stateId.split(".");
        for (let i = 1; i < segments.length; i++) {
          const channelId = segments.slice(0, i).join(".");
          if (!createdChannels.has(channelId)) {
            createdChannels.add(channelId);
            await this.deps.upsertObject(`${this.deviceId}.${channelId}`, {
              id: channelId,
              type: "channel",
              common: { name: (_c = import_types.CHANNEL_NAMES[segments[i - 1]]) != null ? _c : segments[i - 1] }
            });
          }
        }
        await this.deps.upsertObject(`${this.deviceId}.${stateId}`, {
          id: stateId,
          type: "state",
          common: { ...entry.common }
        });
      }
    }
    for (const { zone, status } of answered) {
      if (status) {
        this.seedZone(zone, status);
      }
    }
    try {
      const model = await this.deps.client.getModelName();
      if (model) {
        this.emit("info.model", model);
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getModelName failed (${(0, import_util.errorMessage)(e)})`);
    }
    await this.setupBrowse();
    this.cancelKeepalive = this.deps.scheduleKeepalive(() => void this.keepalive(), this.pollIntervalMs);
    this.deps.log.debug(`${this.deviceId}: Yamaha (XML) device ready (XML)`);
    return true;
  }
  /**
   * Create the browsing surface (#613) when at least one source answers a List_Info
   * probe (NET_RADIO/SERVER/USB — the menus the predecessor adapter's users drove
   * via `Realtime.*.LINE1TXT` + `xmlCommand`). Skipped without a delay dep (older tests).
   */
  async setupBrowse() {
    const gate = this.deps.gate;
    if (!gate) {
      return;
    }
    const delay = (ms) => gate.delay(ms);
    const probe = async () => {
      const probes = await Promise.all(
        import_xml_browse_driver.XML_BROWSE_SOURCES.map(async (source) => {
          try {
            const body = await this.deps.client.getXml(source.element, "<List_Info>GetParam</List_Info>");
            return body.includes("<Menu_Status>") ? source.key : void 0;
          } catch {
            return void 0;
          }
        })
      );
      return probes.filter((key) => key !== void 0);
    };
    const available = new Set(
      this.deps.probeMemory ? await this.deps.probeMemory.once("xmlBrowseSources", probe) : await probe()
    );
    if (available.size === 0) {
      return;
    }
    const driver = new import_xml_browse_driver.XmlBrowseDriver(this.deps.client, available, delay);
    this.browseEngine = await (0, import_surface.createBrowseSurface)(driver, this.deviceId, {
      upsertObject: this.deps.upsertObject,
      emit: (id, value) => this.emit(id, value),
      log: this.deps.log,
      delay
    });
  }
  /**
   * Write a device-originated value — but never after the connection was closed. A poll
   * that was already in flight when the adapter stopped would otherwise still write into
   * a tree that is being torn down.
   *
   * @param relativeId the state id relative to the device
   * @param value the value to write
   */
  emit(relativeId, value) {
    var _a;
    if ((_a = this.deps.gate) == null ? void 0 : _a.closed) {
      return;
    }
    this.deps.setStateAck(`${this.deviceId}.${relativeId}`, value);
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
    var _a;
    if (ack) {
      return;
    }
    const prefix = `${this.deviceId}.`;
    if (!fullStateId.startsWith(prefix)) {
      return;
    }
    const stateId = fullStateId.slice(prefix.length);
    if (stateId.startsWith("player.browse.")) {
      (_a = this.browseEngine) == null ? void 0 : _a.handleWrite(stateId, value);
      return;
    }
    const command = (0, import_command_mapper.stateToXml)(stateId, value);
    if (command) {
      void this.applyCommand(command);
    }
  }
  /**
   * Register the supervisor's drop handler. XML has no push/socket-drop event, so a
   * drop is inferred from a run of failed polls (see keepalive).
   *
   * @param cb invoked once when the device is judged gone
   */
  onDrop(cb) {
    this.dropDetector.onDrop(cb);
  }
  /** Cancel the keepalive poll. Synchronous — safe to call from onUnload. */
  close() {
    var _a, _b, _c;
    (_a = this.browseEngine) == null ? void 0 : _a.close();
    (_b = this.deps.gate) == null ? void 0 : _b.close();
    (_c = this.cancelKeepalive) == null ? void 0 : _c.call(this);
    this.cancelKeepalive = void 0;
  }
  /**
   * Poll every live zone. If every zone fails for three consecutive failed polls in a
   * row, the device is judged gone and a drop is reported so the supervisor reconnects.
   */
  async keepalive() {
    let anyOk = false;
    for (const zone of this.zones) {
      if (await this.refreshZone(zone)) {
        anyOk = true;
      }
    }
    this.dropDetector.record(anyOk);
  }
  /**
   * Fetch a zone's status and write its amp states with ack.
   *
   * @param zone the zone to refresh
   * @returns true if the status was fetched, false if the request failed
   */
  async refreshZone(zone) {
    const status = await this.tryGetStatus(zone.element);
    if (!status) {
      return false;
    }
    this.seedZone(zone, status);
    return true;
  }
  /**
   * Write a zone's amp states from an already-fetched Basic_Status (used to seed
   * from the start-up probe without a second round-trip).
   *
   * @param zone the zone the status belongs to
   * @param status the parsed Basic_Status
   */
  seedZone(zone, status) {
    for (const update of (0, import_command_mapper.parseXmlStatus)(status, zone.key)) {
      this.emit(update.id, update.value);
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
      this.deps.log.debug(`${this.deviceId}: getStatus(${element}) failed: ${(0, import_util.errorMessage)(e)}`);
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
      this.deps.log.warn(`${this.deviceId}: XML command failed: ${(0, import_util.errorMessage)(e)}`);
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  XmlDeviceController
});
//# sourceMappingURL=device-controller.js.map
