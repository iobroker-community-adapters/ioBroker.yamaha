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
var import_node_crypto = require("node:crypto");
var import_capability = require("./capability");
var import_object_mapper = require("./object-mapper");
var import_command_mapper = require("./command-mapper");
var import_push = require("./push");
var import_util = require("../util");
const KEEPALIVE_MS = 5 * 60 * 1e3;
const MAX_KEEPALIVE_FAILURES = 3;
function modelNameFrom(deviceInfo) {
  const model = deviceInfo == null ? void 0 : deviceInfo.model_name;
  return typeof model === "string" && model.length > 0 ? model : void 0;
}
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
  mediaBlocks = [];
  cancelKeepalive;
  cancelPush;
  dropHandler;
  failedKeepalives = 0;
  dropped = false;
  /** The tuner's current band, cached so a frequency write can supply it (setFreq needs band + freq). */
  lastTunerBand = "fm";
  /** Each zone's last-seen equalizer bands, cached so one band write can supply the other two. */
  lastEqualizer = /* @__PURE__ */ new Map();
  /** Whether the device reports MusicCast-Link distribution (gates the dist poll and objects). */
  hasDistribution = false;
  /** The device's last-seen distribution role (none/server/client), for the leave-group path. */
  lastDistRole = "none";
  /**
   * Read capabilities, create the object tree, seed state, and wire up push +
   * keepalive.
   *
   * @returns true if the device reported capabilities and its tree was created
   */
  async start() {
    var _a;
    const capabilities = (0, import_capability.parseYxcFeatures)(await this.deps.client.getFeatures());
    const objects = (0, import_object_mapper.mapYxcToObjects)(capabilities);
    if (objects.length === 0) {
      this.deps.log.warn(`${this.deviceId}: no capabilities reported \u2014 creating no objects`);
      return false;
    }
    for (const object of objects) {
      await this.deps.upsertObject(`${this.deviceId}.${object.id}`, object);
    }
    try {
      const model = modelNameFrom(await this.deps.client.getDeviceInfo());
      if (model) {
        await this.deps.upsertObject(`${this.deviceId}.info`, {
          id: "info",
          type: "channel",
          common: { name: "Info" }
        });
        await this.deps.upsertObject(`${this.deviceId}.info.model`, {
          id: "info.model",
          type: "state",
          common: { name: "Model", type: "string", role: "text", read: true, write: false }
        });
        this.deps.setStateAck(`${this.deviceId}.info.model`, model);
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getDeviceInfo failed (${(0, import_util.errorMessage)(e)})`);
    }
    this.zones = capabilities.zones.map((zone) => zone.id);
    for (const zone of this.zones) {
      await this.refreshZone(zone);
    }
    this.mediaBlocks = capabilities.media;
    await this.refreshMedia();
    this.hasDistribution = (_a = capabilities.hasDistribution) != null ? _a : false;
    if (this.hasDistribution) {
      await this.refreshDistribution();
    }
    this.cancelPush = this.deps.registerPush((event) => this.onPush(event));
    this.cancelKeepalive = this.deps.scheduleKeepalive(() => void this.keepalive(), KEEPALIVE_MS);
    this.deps.log.debug(`${this.deviceId}: MusicCast device ready (YXC)`);
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
    const stateId = fullStateId.slice(prefix.length);
    if (stateId === "dist.leaveGroup") {
      void this.leaveGroup();
      return;
    }
    if (stateId === "dist.linkClient") {
      void this.linkClient(String(value));
      return;
    }
    const command = (0, import_command_mapper.stateToYxc)(stateId, value);
    if (command) {
      void this.applyCommand(command);
    }
  }
  /**
   * Register the supervisor's drop handler. MusicCast has no socket-drop event, so a
   * drop is inferred from a run of failed keepalive polls (see keepalive).
   *
   * @param cb invoked once when the device is judged gone
   */
  onDrop(cb) {
    this.dropHandler = cb;
  }
  /** Cancel the keepalive and unregister the push handler. Synchronous — safe from onUnload. */
  close() {
    var _a, _b;
    (_a = this.cancelKeepalive) == null ? void 0 : _a.call(this);
    this.cancelKeepalive = void 0;
    (_b = this.cancelPush) == null ? void 0 : _b.call(this);
    this.cancelPush = void 0;
  }
  /**
   * Handle a device push: each named zone is re-fetched via getStatus, each named
   * media source via getPlayInfo (the push itself is a change signal, not a value
   * carrier). Refreshing only the named sources keeps a track-change push from
   * re-polling every source.
   *
   * @param event the parsed push event
   */
  onPush(event) {
    for (const zone of (0, import_push.zonesToRefresh)(event)) {
      if (this.zones.includes(zone)) {
        void this.refreshZone(zone);
      }
    }
    for (const block of (0, import_push.mediaToRefresh)(event)) {
      if (this.mediaBlocks.includes(block)) {
        void this.refreshMediaSource(block);
      }
    }
  }
  /**
   * Poll every zone (which renews the push registration and refreshes state) and the
   * media sources. If every zone poll fails for MAX_KEEPALIVE_FAILURES runs in a row,
   * the device is judged gone and a drop is reported so the supervisor can flip
   * info.connection and reconnect.
   */
  async keepalive() {
    let anyOk = false;
    for (const zone of this.zones.length > 0 ? this.zones : ["main"]) {
      if (await this.refreshZone(zone)) {
        anyOk = true;
      }
    }
    await this.refreshMedia();
    if (this.hasDistribution) {
      await this.refreshDistribution();
    }
    if (anyOk) {
      this.failedKeepalives = 0;
    } else if (++this.failedKeepalives >= MAX_KEEPALIVE_FAILURES) {
      this.reportDrop();
    }
  }
  /** Report a drop once — the supervisor then closes this controller and reconnects. */
  reportDrop() {
    var _a;
    if (this.dropped) {
      return;
    }
    this.dropped = true;
    (_a = this.dropHandler) == null ? void 0 : _a.call(this, new Error(`${MAX_KEEPALIVE_FAILURES} keepalive polls failed`));
  }
  /** Refresh every player source the device offers (network player, cd, tuner). */
  async refreshMedia() {
    for (const block of this.mediaBlocks) {
      await this.refreshMediaSource(block);
    }
  }
  /**
   * Fetch one media source's play info and write the parsed states with ack. The
   * source picks the getPlayInfo argument and the parser: netusb and cd share the
   * play-info shape (different channel), the tuner has its own band/frequency/RDS.
   *
   * @param block the media block (`netusb`, `cd`, `tuner`)
   */
  async refreshMediaSource(block) {
    const arg = block === "netusb" ? void 0 : block;
    const parse = (info) => block === "tuner" ? (0, import_command_mapper.parseYxcTunerInfo)(info) : (0, import_command_mapper.parseYxcPlayInfo)(info, block === "cd" ? "cd" : "netPlayer");
    try {
      const info = await this.deps.client.getPlayInfo(arg);
      for (const update of parse(info)) {
        this.deps.setStateAck(`${this.deviceId}.${update.id}`, update.value);
        if (update.id === "tuner.band") {
          this.lastTunerBand = String(update.value);
        }
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getPlayInfo(${arg != null ? arg : ""}) failed: ${(0, import_util.errorMessage)(e)}`);
    }
  }
  /**
   * Fetch the MusicCast-Link distribution info and write the parsed dist states with ack,
   * caching the role for the leave-group path.
   */
  async refreshDistribution() {
    try {
      const info = await this.deps.client.getDistributionInfo();
      for (const update of (0, import_command_mapper.parseYxcDistribution)(info)) {
        this.deps.setStateAck(`${this.deviceId}.${update.id}`, update.value);
        if (update.id === "dist.role") {
          this.lastDistRole = String(update.value);
        }
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getDistributionInfo failed: ${(0, import_util.errorMessage)(e)}`);
    }
  }
  /**
   * Leave the current MusicCast-Link group: a server stops distributing, a client clears
   * its membership. Then re-read the distribution state so the tree reflects the change.
   */
  async leaveGroup() {
    try {
      if (this.lastDistRole === "server") {
        await this.deps.client.stopDistribution();
      } else {
        await this.deps.client.setClientInfo({ group_id: "", zone: ["main"] });
      }
      await this.refreshDistribution();
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: leaveGroup failed: ${(0, import_util.errorMessage)(e)}`);
    }
  }
  /**
   * Form a MusicCast-Link group with another configured device: give the client the shared
   * group id, add it to this device's roster as the server, and start distributing. The group
   * id is derived from this device's id, so re-linking reuses the same group rather than a new one.
   *
   * @param clientIp the IP of the client device to add (must be a configured device)
   */
  async linkClient(clientIp) {
    var _a, _b;
    const clientClient = (_b = (_a = this.deps).clientFor) == null ? void 0 : _b.call(_a, clientIp);
    if (!clientClient) {
      this.deps.log.warn(`${this.deviceId}: cannot link ${clientIp} \u2014 not a known device`);
      return;
    }
    try {
      const groupId = (0, import_node_crypto.createHash)("md5").update(this.deviceId).digest("hex");
      await clientClient.setClientInfo({ group_id: groupId, zone: ["main"] });
      await this.deps.client.setServerInfo({ group_id: groupId, zone: "main", type: "add", client_list: [clientIp] });
      await this.deps.client.startDistribution(0);
      await this.refreshDistribution();
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: linkClient(${clientIp}) failed: ${(0, import_util.errorMessage)(e)}`);
    }
  }
  /**
   * Fetch a zone's status and write its amp states with ack.
   *
   * @param zone the zone to refresh
   * @returns true if the status was fetched, false if the request failed
   */
  async refreshZone(zone) {
    try {
      const status = await this.deps.client.getStatus(zone);
      const updates = (0, import_command_mapper.parseYxcStatus)(status, zone);
      for (const update of updates) {
        this.deps.setStateAck(`${this.deviceId}.${update.id}`, update.value);
      }
      this.cacheEqualizer(zone, updates);
      return true;
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getStatus(${zone}) failed: ${(0, import_util.errorMessage)(e)}`);
      return false;
    }
  }
  /**
   * Cache a zone's equalizer bands from its status updates, so a later single-band
   * write can send setEqualizer with all three (the device sets them together).
   *
   * @param zone the zone the updates belong to
   * @param updates the parsed status updates for that zone
   */
  cacheEqualizer(zone, updates) {
    var _a, _b, _c, _d;
    const prefix = zone === "main" ? "" : `${zone}.`;
    const band = (b) => {
      const u = updates.find((x) => x.id === `${prefix}equalizer${b}`);
      return typeof (u == null ? void 0 : u.value) === "number" ? u.value : void 0;
    };
    if (band("Low") === void 0 && band("Mid") === void 0 && band("High") === void 0) {
      return;
    }
    const cur = (_a = this.lastEqualizer.get(zone)) != null ? _a : { low: 0, mid: 0, high: 0 };
    this.lastEqualizer.set(zone, {
      low: (_b = band("Low")) != null ? _b : cur.low,
      mid: (_c = band("Mid")) != null ? _c : cur.mid,
      high: (_d = band("High")) != null ? _d : cur.high
    });
  }
  /**
   * Send a mapped command to the device through the matching client method.
   *
   * @param command the YXC command to apply
   */
  async applyCommand(command) {
    var _a;
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
        case "setBassTo":
          await this.deps.client.setBassTo(Number(value), zone);
          break;
        case "setTrebleTo":
          await this.deps.client.setTrebleTo(Number(value), zone);
          break;
        case "sleep":
          await this.deps.client.sleep(Number(value), zone);
          break;
        case "setDirect":
          await this.deps.client.setDirect(Boolean(value), zone);
          break;
        case "setClearVoice":
          await this.deps.client.setClearVoice(Boolean(value), zone);
          break;
        case "setBassExtension":
          await this.deps.client.setBassExtension(Boolean(value), zone);
          break;
        case "setBalance":
          await this.deps.client.setBalance(Number(value), zone);
          break;
        case "setEqualizerLow":
        case "setEqualizerMid":
        case "setEqualizerHigh": {
          const band = command.method.slice("setEqualizer".length).toLowerCase();
          const next = { ...(_a = this.lastEqualizer.get(zone)) != null ? _a : { low: 0, mid: 0, high: 0 }, [band]: Number(value) };
          await this.deps.client.setEqualizer(next.low, next.mid, next.high, zone);
          this.lastEqualizer.set(zone, next);
          break;
        }
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
        case "toggleNetRepeat":
          await this.deps.client.toggleNetRepeat();
          break;
        case "toggleNetShuffle":
          await this.deps.client.toggleNetShuffle();
          break;
        case "toggleCDRepeat":
          await this.deps.client.toggleCDRepeat();
          break;
        case "toggleCDShuffle":
          await this.deps.client.toggleCDShuffle();
          break;
        case "toggleTray":
          await this.deps.client.toggleTray();
          break;
        case "setPartyMode":
          await this.deps.client.setPartyMode(Boolean(value));
          break;
        case "setBand":
          await this.deps.client.setBand(String(value));
          break;
        case "setFreq":
          await this.deps.client.setFreq(this.lastTunerBand, Number(value));
          break;
        case "recallPreset":
          await this.deps.client.recallPreset(Number(value), zone);
          break;
        default:
          this.deps.log.warn(`${this.deviceId}: unknown YXC command "${command.method}" \u2014 ignored`);
      }
    } catch (e) {
      this.deps.log.warn(`${this.deviceId}: ${command.method} failed: ${(0, import_util.errorMessage)(e)}`);
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  YxcDeviceController
});
//# sourceMappingURL=device-controller.js.map
