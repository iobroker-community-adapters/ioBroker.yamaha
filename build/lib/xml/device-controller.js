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
var import_i18n = require("../i18n");
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
  { key: "zone2", element: "Zone_2", prefix: "multiroom.zone2." },
  { key: "zone3", element: "Zone_3", prefix: "multiroom.zone3." },
  { key: "zone4", element: "Zone_4", prefix: "multiroom.zone4." }
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
  /** The amp state ids this controller actually created — the claim-with-proof gate for BOTH ways. */
  createdStates = /* @__PURE__ */ new Set();
  /** Per zone: the Basic_Status fields this device is known to deliver (persisted union). */
  zoneFields = /* @__PURE__ */ new Map();
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
    for (const { zone, status } of answered) {
      const key = `xmlStatusFields:${zone.key}`;
      const remembered = (_a = this.deps.probeMemory) == null ? void 0 : _a.remembered(key);
      const fields = new Set(Array.isArray(remembered) ? remembered : []);
      for (const field of Object.keys(status != null ? status : {})) {
        fields.add(field);
      }
      (_b = this.deps.probeMemory) == null ? void 0 : _b.set(key, [...fields]);
      this.zoneFields.set(zone.key, fields);
    }
    const createdChannels = /* @__PURE__ */ new Set();
    for (const zone of this.zones) {
      for (const entry of import_catalog.XML_AMP_CATALOG) {
        if (entry.mainOnly && zone.key !== "main") {
          continue;
        }
        if (entry.statusField !== void 0 && !((_c = this.zoneFields.get(zone.key)) == null ? void 0 : _c.has(entry.statusField))) {
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
              common: {
                // Capitalised like the catalog path does it, so the same folder cannot end up
                // called "sound" here and "Sound" there depending on which transport owns it.
                name: import_types.CHANNEL_NAME_KEYS[segments[i - 1]] ? (0, import_i18n.tName)(import_types.CHANNEL_NAME_KEYS[segments[i - 1]]) : segments[i - 1].charAt(0).toUpperCase() + segments[i - 1].slice(1)
              }
            });
          }
        }
        const { nameKey, descKey, ...rest } = entry.common;
        const common = {
          ...rest,
          name: (0, import_i18n.tName)(nameKey),
          // An absent key means the datapoint explains itself — the fleet standard wants the
          // field empty there rather than filled with invented prose.
          ...descKey ? { desc: (0, import_i18n.tName)(descKey) } : {}
        };
        const inputs = entry.state === "input" ? inputsByZone.get(zone.key) : void 0;
        if (inputs && inputs.length > 0) {
          common.states = Object.fromEntries(inputs.map((input) => [input, input]));
        }
        await this.deps.upsertObject(`${this.deviceId}.${stateId}`, {
          id: stateId,
          type: "state",
          common
        });
        this.createdStates.add(stateId);
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
   *
   * Only a DEFINITE answer is remembered: a body, or the model's own "no such node"
   * (bodyless HTTP 400 / return code 2, both captured on the RX-V6A) as "declares none".
   * A transient failure — timeout, connection error, HTTP 5xx, or a state-dependent
   * refusal (return code 3/4, "not now") — is NOT remembered: before this, one busy
   * moment during the first contact recorded "no scenes" for that device for good, until
   * the model changed. Now it is simply asked again on the next connect.
   *
   * @param key the probe-memory key
   * @param element the XML element to ask
   * @param inner the inner GET request
   * @returns the raw response body, or "" when the device (definitely or for now) has none
   */
  async probeXml(key, element, inner) {
    const probe = async () => {
      let body;
      try {
        body = await this.deps.client.getXml(element, inner);
      } catch (e) {
        if ((0, import_protocol.isPermanentXmlRefusal)(e)) {
          return "";
        }
        throw e;
      }
      const rc = (0, import_protocol.parseReturnCode)(body);
      if (rc !== void 0 && rc !== 0) {
        if (rc === 2) {
          return "";
        }
        throw new Error(`device refused ${element} probe (RC=${rc})`);
      }
      return body;
    };
    try {
      return this.deps.probeMemory ? await this.deps.probeMemory.once(key, probe) : await probe();
    } catch (e) {
      this.deps.log.debug(
        `${this.deviceId}: ${key} probe failed, asking again on the next connect (${(0, import_util.errorMessage)(e)})`
      );
      return "";
    }
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
          common: { name: (0, import_i18n.tName)((_a = import_types.CHANNEL_NAME_KEYS.scene) != null ? _a : "Scenes") }
        });
      }
      const max = Math.max(...scenes.map((scene) => scene.num));
      await this.deps.upsertObject(`${this.deviceId}.${channelId}.recall`, {
        id: `${channelId}.recall`,
        type: "state",
        common: {
          name: (0, import_i18n.tName)("recallScene"),
          desc: (0, import_i18n.tName)("descRecallScene"),
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
        common: {
          name: (0, import_i18n.tName)("scenesNumberTitle"),
          desc: (0, import_i18n.tName)("descScenesNumberTitle"),
          type: "string",
          role: "json",
          read: true,
          write: false
        }
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
        common: { name: (0, import_i18n.tName)((_a = import_types.CHANNEL_NAME_KEYS.tuner) != null ? _a : "Tuner") }
      });
    }
    const state = async (id, common) => {
      await this.deps.upsertObject(`${this.deviceId}.tuner.${id}`, { id: `tuner.${id}`, type: "state", common });
    };
    await state("preset", {
      name: (0, import_i18n.tName)("presetRecallByNumber"),
      desc: (0, import_i18n.tName)("descPresetRecallByNumber"),
      type: "number",
      role: "level",
      read: true,
      write: true,
      // Slot 1 upwards — `handleTunerWrite` drops a 0, so offering it as the lower bound
      // invited a write that goes nowhere.
      min: 1,
      max: 40,
      step: 1
    });
    await state("frequency", {
      name: (0, import_i18n.tName)("frequency"),
      type: "number",
      role: "value",
      unit: "kHz",
      read: true,
      write: false
    });
    await state("rdsService", {
      name: (0, import_i18n.tName)("rdsStation"),
      desc: (0, import_i18n.tName)("descRdsStation"),
      type: "string",
      role: "text",
      read: true,
      write: false
    });
    await state("rdsText", {
      name: (0, import_i18n.tName)("rdsText"),
      desc: (0, import_i18n.tName)("descRdsText"),
      type: "string",
      role: "text",
      read: true,
      write: false
    });
    await state("tuned", {
      name: (0, import_i18n.tName)("tunedToAStation"),
      desc: (0, import_i18n.tName)("descTunedToAStation"),
      type: "boolean",
      role: "indicator",
      read: true,
      write: false
    });
    await state("stereo", {
      name: (0, import_i18n.tName)("stereoReception"),
      desc: (0, import_i18n.tName)("descStereoReception"),
      type: "boolean",
      role: "indicator",
      read: true,
      write: false
    });
    await this.refreshTuner();
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
      this.emit("tuner.frequency", Math.round(info.frequencyUnit === "MHz" ? info.frequency * 1e3 : info.frequency));
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
          } catch (e) {
            if ((0, import_protocol.isPermanentXmlRefusal)(e)) {
              return void 0;
            }
            throw e;
          }
        })
      );
      return probes.filter((key) => key !== void 0);
    };
    let available;
    try {
      available = new Set(
        this.deps.probeMemory ? await this.deps.probeMemory.once("xmlBrowseSources", probe) : await probe()
      );
    } catch (e) {
      this.deps.log.debug(
        `${this.deviceId}: browse probe failed, asking again on the next connect (${(0, import_util.errorMessage)(e)})`
      );
      return;
    }
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
    var _a, _b;
    if (ack) {
      return;
    }
    const prefix = `${this.deviceId}.`;
    if (!fullStateId.startsWith(prefix)) {
      return;
    }
    const stateId = fullStateId.slice(prefix.length);
    if (stateId.startsWith("remote.")) {
      (_a = this.browseEngine) == null ? void 0 : _a.handleRemoteWrite(stateId, value);
      return;
    }
    if (stateId.startsWith("player.browse.")) {
      (_b = this.browseEngine) == null ? void 0 : _b.handleWrite(stateId, value);
      return;
    }
    if (this.handleSceneWrite(stateId, value)) {
      return;
    }
    if (this.handleTunerWrite(stateId, value)) {
      return;
    }
    if (!this.createdStates.has(stateId)) {
      this.deps.log.debug(`${this.deviceId}: ${stateId} was not reported by this device \u2014 write dropped`);
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
    try {
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
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: keepalive poll failed: ${(0, import_util.errorMessage)(e)}`);
    }
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
    var _a;
    const known = this.zoneFields.get(zone.key);
    if (known) {
      let grew = false;
      for (const field of Object.keys(status)) {
        if (!known.has(field)) {
          known.add(field);
          grew = true;
        }
      }
      if (grew) {
        (_a = this.deps.probeMemory) == null ? void 0 : _a.set(`xmlStatusFields:${zone.key}`, [...known]);
      }
    }
    for (const update of (0, import_command_mapper.parseXmlStatus)(status, zone.key)) {
      if (this.createdStates.has(update.id)) {
        this.emit(update.id, update.value);
      }
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
