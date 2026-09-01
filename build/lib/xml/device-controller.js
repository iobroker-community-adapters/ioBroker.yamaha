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
var import_protocol = require("./protocol");
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
  /** The scenes each zone DECLARES (`Scene_Sel_Item`), for the recall write path. */
  scenesByZone = /* @__PURE__ */ new Map();
  /** Whether the device answers `<Tuner><Play_Info>` (the classic pre-2010 tuner). */
  hasTuner = false;
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
    let model;
    try {
      model = await this.deps.client.getModelName();
      if (model !== void 0 && this.deps.probeMemory) {
        if (this.deps.probeMemory.remembered("xmlModel") !== model) {
          this.deps.probeMemory.drop((key) => key.startsWith("xml"));
          this.deps.probeMemory.set("xmlModel", model);
        }
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getModelName failed (${(0, import_util.errorMessage)(e)})`);
    }
    const inputsByZone = /* @__PURE__ */ new Map();
    for (const zone of this.zones) {
      const body = await this.probeXml(
        `xmlInputs:${zone.key}`,
        zone.element,
        "<Input><Input_Sel_Item>GetParam</Input_Sel_Item></Input>"
      );
      inputsByZone.set(zone.key, (0, import_protocol.parseInputList)(body));
    }
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
        const common = { ...entry.common };
        const inputs = entry.state === "input" ? inputsByZone.get(zone.key) : void 0;
        if (inputs && inputs.length > 0) {
          common.states = Object.fromEntries(inputs.map((input) => [input, input]));
        }
        await this.deps.upsertObject(`${this.deviceId}.${stateId}`, {
          id: stateId,
          type: "state",
          common
        });
      }
    }
    await this.setupScenes(createdChannels);
    await this.setupTuner(createdChannels);
    for (const { zone, status } of answered) {
      if (status) {
        this.seedZone(zone, status);
      }
    }
    if (model) {
      this.emit("info.model", model);
    }
    await this.setupBrowse();
    this.cancelKeepalive = this.deps.scheduleKeepalive(() => void this.keepalive(), this.pollIntervalMs);
    this.deps.log.debug(`${this.deviceId}: Yamaha (XML) device ready (XML)`);
    return true;
  }
  /**
   * Read one element's list once per device: the answer is a property of the MODEL
   * (input lists, scene declarations), so reconnects reuse it via the probe memory.
   * A refusal (RC/HTTP) or transport error yields an empty body — "declares none".
   *
   * @param key the probe-memory key
   * @param element the XML element to ask
   * @param inner the inner GET request
   * @returns the raw response body, or "" when the device refused
   */
  probeXml(key, element, inner) {
    const probe = async () => {
      try {
        return await this.deps.client.getXml(element, inner);
      } catch {
        return "";
      }
    };
    return this.deps.probeMemory ? this.deps.probeMemory.once(key, probe) : probe();
  }
  /**
   * Build the scene surface from the device's OWN declaration (#615): each zone's
   * `<Scene_Sel_Item>` names the scenes that exist, their titles and the write value
   * (`Scene N` via `<Scene_Sel>`). The predecessor blindly sent `Scene_Load` to a
   * fixed 1..12 main-zone state; the capture shows the device declaring `Scene_Sel`
   * instead — and declaring scenes for Zone 2 too.
   *
   * @param createdChannels the channel ids already created (extended here)
   */
  async setupScenes(createdChannels) {
    var _a;
    for (const zone of this.zones) {
      const body = await this.probeXml(
        `xmlScenes:${zone.key}`,
        zone.element,
        "<Scene><Scene_Sel_Item>GetParam</Scene_Sel_Item></Scene>"
      );
      const scenes = (0, import_protocol.parseSceneList)(body);
      if (scenes.length === 0) {
        continue;
      }
      this.scenesByZone.set(zone.key, scenes);
      const channelId = `${zone.prefix}scene`;
      if (!createdChannels.has(channelId)) {
        createdChannels.add(channelId);
        await this.deps.upsertObject(`${this.deviceId}.${channelId}`, {
          id: channelId,
          type: "channel",
          common: { name: (_a = import_types.CHANNEL_NAMES.scene) != null ? _a : "Scenes" }
        });
      }
      const max = Math.max(...scenes.map((scene) => scene.num));
      await this.deps.upsertObject(`${this.deviceId}.${channelId}.recall`, {
        id: `${channelId}.recall`,
        type: "state",
        common: {
          name: "Recall scene",
          type: "number",
          role: "level",
          read: true,
          write: true,
          min: 1,
          max,
          step: 1,
          // The declared titles as the dropdown, so the picker shows "Movie Viewing",
          // not a bare number.
          states: Object.fromEntries(scenes.map((scene) => [scene.num, scene.title]))
        }
      });
      await this.deps.upsertObject(`${this.deviceId}.${channelId}.list`, {
        id: `${channelId}.list`,
        type: "state",
        common: { name: "Scenes (number + title)", type: "string", role: "json", read: true, write: false }
      });
      this.emit(`${channelId}.list`, JSON.stringify(scenes));
    }
  }
  /**
   * Build the classic tuner surface (pre-2010 devices, where XML is the ONLY
   * transport — the predecessor served their tuner, the rewrite had dropped it).
   * Existence is probed once per device; the preset write is the openHAB-verified
   * `<Play_Control><Preset><Preset_Sel>`; frequency/RDS/tuned are read-only from
   * Play_Info. On newer devices YNCA/YXC own these ids via the owner policy.
   *
   * @param createdChannels the channel ids already created (extended here)
   */
  async setupTuner(createdChannels) {
    var _a;
    const probe = await this.probeXml("xmlTuner", "Tuner", "<Play_Info>GetParam</Play_Info>");
    if (probe.length === 0) {
      return;
    }
    this.hasTuner = true;
    if (!createdChannels.has("tuner")) {
      createdChannels.add("tuner");
      await this.deps.upsertObject(`${this.deviceId}.tuner`, {
        id: "tuner",
        type: "channel",
        common: { name: (_a = import_types.CHANNEL_NAMES.tuner) != null ? _a : "Tuner" }
      });
    }
    const state = async (id, common) => {
      await this.deps.upsertObject(`${this.deviceId}.tuner.${id}`, { id: `tuner.${id}`, type: "state", common });
    };
    await state("preset", {
      name: "Preset (recall by number)",
      type: "number",
      role: "level",
      read: true,
      write: true,
      min: 0,
      max: 40,
      step: 1
    });
    await state("frequency", { name: "Frequency", type: "number", role: "value", read: true, write: false });
    await state("rdsService", { name: "RDS station", type: "string", role: "text", read: true, write: false });
    await state("rdsText", { name: "RDS text", type: "string", role: "text", read: true, write: false });
    await state("tuned", { name: "Tuned to a station", type: "boolean", role: "indicator", read: true, write: false });
    await state("stereo", { name: "Stereo reception", type: "boolean", role: "indicator", read: true, write: false });
    this.emitTunerInfo(probe);
  }
  /**
   * Write the tuner states from a Play_Info response.
   *
   * @param xml the Play_Info response body
   */
  emitTunerInfo(xml) {
    const info = (0, import_protocol.parseTunerInfo)(xml);
    if (info.preset !== void 0) {
      this.emit("tuner.preset", info.preset);
    }
    if (info.frequency !== void 0) {
      this.emit("tuner.frequency", info.frequency);
    }
    if (info.rdsService !== void 0) {
      this.emit("tuner.rdsService", info.rdsService);
    }
    if (info.rdsText !== void 0) {
      this.emit("tuner.rdsText", info.rdsText);
    }
    if (info.tuned !== void 0) {
      this.emit("tuner.tuned", info.tuned);
    }
    if (info.stereo !== void 0) {
      this.emit("tuner.stereo", info.stereo);
    }
  }
  /**
   * Poll the tuner's Play_Info (keepalive) and write the states.
   */
  async refreshTuner() {
    try {
      this.emitTunerInfo(await this.deps.client.getXml("Tuner", "<Play_Info>GetParam</Play_Info>"));
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: tuner Play_Info failed: ${(0, import_util.errorMessage)(e)}`);
    }
  }
  /**
   * A user write to `tuner.preset` → the openHAB-verified preset recall.
   *
   * @param stateId the state id relative to the device
   * @param value the written value
   * @returns true when the id was the tuner preset (handled here)
   */
  handleTunerWrite(stateId, value) {
    if (stateId !== "tuner.preset" || !this.hasTuner) {
      return stateId === "tuner.preset";
    }
    const num = Math.round(Number(value));
    if (!Number.isFinite(num) || num < 1) {
      return true;
    }
    void this.applyCommand({
      zone: "Tuner",
      inner: `<Play_Control><Preset><Preset_Sel>${num}</Preset_Sel></Preset></Play_Control>`
    });
    return true;
  }
  /**
   * A user write to a zone's `scene.recall` → the DECLARED write element
   * (`<Scene><Scene_Sel>Scene N</Scene_Sel></Scene>`). Only zones that declared
   * scenes accept the write; a refusal lands in the log via applyCommand.
   *
   * @param stateId the state id relative to the device
   * @param value the written value
   * @returns true when the id was a scene recall (handled here)
   */
  handleSceneWrite(stateId, value) {
    var _a, _b;
    const match = /^(?:multiroom\.(zone[234])\.)?scene\.recall$/.exec(stateId);
    if (!match) {
      return false;
    }
    const zoneKey = (_a = match[1]) != null ? _a : "main";
    const zone = this.zones.find((z) => z.key === zoneKey);
    const scenes = this.scenesByZone.get(zoneKey);
    const byTitle = typeof value === "string" && !/^\d+$/.test(value.trim()) ? (_b = scenes == null ? void 0 : scenes.find((scene) => scene.title.toLowerCase() === value.trim().toLowerCase())) == null ? void 0 : _b.num : void 0;
    const num = byTitle != null ? byTitle : Math.round(Number(value));
    if (!zone || !scenes || !scenes.some((scene) => scene.num === num)) {
      return true;
    }
    void this.applyCommand({ zone: zone.element, inner: `<Scene><Scene_Sel>Scene ${num}</Scene_Sel></Scene>` });
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
    if (this.handleSceneWrite(stateId, value)) {
      return;
    }
    if (this.handleTunerWrite(stateId, value)) {
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
    if (this.hasTuner) {
      await this.refreshTuner();
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
