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
  YxcDeviceController: () => YxcDeviceController,
  zoneNameFrom: () => zoneNameFrom
});
module.exports = __toCommonJS(device_controller_exports);
var import_node_crypto = require("node:crypto");
var import_capability = require("./capability");
var import_object_mapper = require("./object-mapper");
var import_command_mapper = require("./command-mapper");
var import_push = require("./push");
var import_util = require("../util");
var import_poll_drop_detector = require("../lifecycle/poll-drop-detector");
var import_zones = require("./zones");
var import_scene_titles = require("../catalog/scene-titles");
var import_surface = require("../browse/surface");
var import_yxc_browse_driver = require("../browse/yxc-browse-driver");
const KEEPALIVE_MS = 5 * 60 * 1e3;
const PUSH_MODE_FULL_SWEEP_EVERY = 6;
function modelNameFrom(deviceInfo) {
  const model = deviceInfo == null ? void 0 : deviceInfo.model_name;
  return typeof model === "string" && model.length > 0 ? model : void 0;
}
function zoneNameFrom(nameText) {
  const zones = nameText == null ? void 0 : nameText.zone_list;
  if (!Array.isArray(zones)) {
    return void 0;
  }
  for (const zone of zones) {
    if (typeof zone !== "object" || zone === null) {
      continue;
    }
    const { id, text } = zone;
    if (id === "main" && typeof text === "string" && text.trim().length > 0) {
      return text.trim();
    }
  }
  return void 0;
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
  dropDetector = new import_poll_drop_detector.PollDropDetector();
  /** The tuner's current band, cached so a frequency write can supply it (setFreq needs band + freq). */
  lastTunerBand = "fm";
  /** Each zone's currently selected input, from its status — see {@link zoneListeningTo}. */
  lastZoneInput = /* @__PURE__ */ new Map();
  /** The source the network player is currently on (netusb `input`, e.g. "net_radio"). */
  lastNetusbInput = "";
  /** Each zone's last-seen equalizer bands, cached so one band write can supply the other two. */
  lastEqualizer = /* @__PURE__ */ new Map();
  /** Whether the device reports MusicCast-Link distribution (gates the dist poll and objects). */
  hasDistribution = false;
  /** The device's last-seen distribution role (none/server/client), for the leave-group path. */
  lastDistRole = "none";
  /** The tuner features (bands + preset mode) — a preset recall needs the band. */
  tunerFeatures;
  /** Whether the device reports the clock/alarm block (gates the clock poll). */
  hasClock = false;
  /** The zones declaring `signal_info` (gates the audio-signal poll). */
  signalZones = [];
  /** Whether netusb declares the MusicCast playlists / the play queue (gates their polls). */
  hasMcPlaylist = false;
  hasPlayQueue = false;
  /** Counts keepalive runs, so the safety-net sweep can run every Nth one under push. */
  keepaliveRuns = 0;
  browseEngine;
  /**
   * Read capabilities, create the object tree, seed state, and wire up push +
   * keepalive.
   *
   * @returns true if the device reported capabilities and its tree was created
   */
  async start() {
    var _a, _b, _c, _d, _e;
    let model;
    try {
      const info = await this.deps.client.getDeviceInfo();
      model = modelNameFrom(info);
      const version = info == null ? void 0 : info.system_version;
      const identity = `${model != null ? model : ""}|${typeof version === "number" || typeof version === "string" ? version : ""}`;
      if (this.deps.probeMemory && this.deps.probeMemory.remembered("yxcIdentity") !== identity) {
        this.deps.probeMemory.drop(
          (key) => key === "features" || key === "name" || key === "model" || key === "yxcIdentity"
        );
        this.deps.probeMemory.set("yxcIdentity", identity);
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getDeviceInfo failed (${(0, import_util.errorMessage)(e)})`);
    }
    const capabilities = await this.remember(
      "features",
      async () => (0, import_capability.parseYxcFeatures)(await this.deps.client.getFeatures())
    );
    const objects = (0, import_object_mapper.mapYxcToObjects)(capabilities);
    if (objects.length === 0) {
      this.deps.log.warn(`${this.deviceId}: no capabilities reported \u2014 creating no objects`);
      return false;
    }
    for (const object of objects) {
      await this.deps.upsertObject(`${this.deviceId}.${object.id}`, object);
    }
    if (model) {
      this.emit("info.model", model);
    }
    if (this.deps.reportDeviceName) {
      try {
        const name = await this.remember("name", async () => zoneNameFrom(await this.deps.client.getNameText()));
        if (name) {
          this.deps.reportDeviceName(name);
        }
      } catch (e) {
        this.deps.log.debug(`${this.deviceId}: getNameText failed (${(0, import_util.errorMessage)(e)})`);
      }
    }
    this.zones = capabilities.zones.map((zone) => zone.id);
    const zonesAnswered = await Promise.all(this.zones.map((zone) => this.refreshZone(zone)));
    if (this.zones.length > 0 && !zonesAnswered.some(Boolean)) {
      this.deps.log.debug(`${this.deviceId}: no zone answered getStatus \u2014 device unreachable (YXC)`);
      return false;
    }
    this.mediaBlocks = capabilities.media;
    this.tunerFeatures = capabilities.tuner;
    this.hasClock = capabilities.clock !== void 0;
    this.signalZones = capabilities.zones.filter((zone) => zone.funcs.includes("signal_info")).map((zone) => zone.id);
    this.hasMcPlaylist = (_b = (_a = capabilities.netusbFuncs) == null ? void 0 : _a.includes("mc_playlist")) != null ? _b : false;
    this.hasPlayQueue = (_d = (_c = capabilities.netusbFuncs) == null ? void 0 : _c.includes("play_queue")) != null ? _d : false;
    await this.setupBrowse(capabilities);
    await this.refreshMedia();
    await this.refreshLists();
    this.hasDistribution = (_e = capabilities.hasDistribution) != null ? _e : false;
    if (this.hasDistribution) {
      await this.refreshDistribution();
    }
    this.cancelPush = this.deps.registerPush((event) => this.onPush(event));
    this.cancelKeepalive = this.deps.scheduleKeepalive(() => void this.keepalive(), KEEPALIVE_MS);
    this.deps.log.debug(`${this.deviceId}: MusicCast device ready (YXC)`);
    return true;
  }
  /**
   * Ask the device once per adapter run and remember the answer for later reconnects.
   *
   * @param key what is being remembered
   * @param probe the request to run when nothing is remembered yet
   * @returns the remembered or freshly fetched value
   */
  remember(key, probe) {
    return this.deps.probeMemory ? this.deps.probeMemory.once(key, probe) : probe();
  }
  /**
   * The zone a recall should be routed to: recalling a favourite does not just start it, it
   * also switches THAT zone to the source. Sending everything to the main zone (as this did
   * before) means someone listening in zone 2 gets their favourite in the living room
   * instead — and the main zone switched away from whatever it was playing.
   *
   * The zone actually listening to the source is the right target; the main zone is the
   * fallback when nothing matches, which is also every single-zone device.
   *
   * @param source the input the recall belongs to (a network source, or "tuner")
   * @returns the zone to route the recall to
   */
  zoneListeningTo(source) {
    if (!source) {
      return "main";
    }
    if (this.lastZoneInput.get("main") === source) {
      return "main";
    }
    for (const [zone, input] of this.lastZoneInput) {
      if (input === source) {
        return zone;
      }
    }
    return "main";
  }
  /**
   * Write a device-originated value — but never after the connection was closed. A poll
   * or a browse fetch that was already in flight when the adapter stopped would otherwise
   * still write into a tree that is being torn down.
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
   * Handle a state change: a user write (ack false) becomes a YXC command; an
   * acked change (the device's own echo) is ignored to avoid a resend loop.
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
    if (stateId.startsWith("player.browse.")) {
      (_a = this.browseEngine) == null ? void 0 : _a.handleWrite(stateId, value);
      return;
    }
    const sceneMatch = /^(?:multiroom\.(zone[234])\.)?scene\.recall$/.exec(stateId);
    if (sceneMatch && typeof value === "string" && !/^\d+$/.test(value.trim())) {
      const resolved = (0, import_scene_titles.resolveSceneNumber)(value, this.deps.probeMemory, (_b = sceneMatch[1]) != null ? _b : "main");
      if (resolved === void 0) {
        return;
      }
      value = resolved;
    }
    if (stateId === "multiroom.group.leave") {
      void this.leaveGroup();
      return;
    }
    if (stateId === "multiroom.group.linkDevice") {
      void this.linkClient(String(value));
      return;
    }
    const command = (0, import_command_mapper.stateToYxc)(stateId, value);
    if (command) {
      void this.applyCommand(stateId, command);
    }
  }
  /**
   * Register the supervisor's drop handler. MusicCast has no socket-drop event, so a
   * drop is inferred from a run of failed keepalive polls (see keepalive).
   *
   * @param cb invoked once when the device is judged gone
   */
  onDrop(cb) {
    this.dropDetector.onDrop(cb);
  }
  /**
   * Create the browsing surface (#613) when the device has the netusb block: the
   * `netusb/getListInfo` + `setListControl` API drives an 8-line window under
   * `player.browse.*`. Skipped without a delay dep (older tests).
   *
   * @param capabilities the parsed getFeatures capabilities
   */
  async setupBrowse(capabilities) {
    var _a, _b;
    const gate = this.deps.gate;
    if (!gate || !capabilities.media.includes("netusb")) {
      return;
    }
    const inputs = (_b = (_a = capabilities.zones.find((zone) => zone.id === "main")) == null ? void 0 : _a.inputs) != null ? _b : [];
    const driver = new import_yxc_browse_driver.YxcBrowseDriver(this.deps.client, inputs);
    this.browseEngine = await (0, import_surface.createBrowseSurface)(driver, this.deviceId, {
      upsertObject: this.deps.upsertObject,
      emit: (id, value) => this.emit(id, value),
      log: this.deps.log,
      delay: (ms) => gate.delay(ms)
    });
  }
  /** Cancel the keepalive and unregister the push handler. Synchronous — safe from onUnload. */
  close() {
    var _a, _b, _c, _d;
    (_a = this.browseEngine) == null ? void 0 : _a.close();
    (_b = this.deps.gate) == null ? void 0 : _b.close();
    (_c = this.cancelKeepalive) == null ? void 0 : _c.call(this);
    this.cancelKeepalive = void 0;
    (_d = this.cancelPush) == null ? void 0 : _d.call(this);
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
    const lists = (0, import_push.netusbListsToRefresh)(event);
    if (lists.presets && this.mediaBlocks.includes("netusb")) {
      void this.refreshNetusbPresets();
    }
    if (lists.recent && this.mediaBlocks.includes("netusb")) {
      void this.refreshNetusbRecent();
    }
  }
  /**
   * Poll every zone (which renews the push registration and refreshes state) and the
   * media sources. If every zone poll fails for three consecutive failed runs in a row,
   * the device is judged gone and a drop is reported so the supervisor can flip
   * info.connection and reconnect.
   */
  async keepalive() {
    var _a, _b;
    const zones = this.zones.length > 0 ? this.zones : ["main"];
    const anyOk = (await Promise.all(zones.map((zone) => this.refreshZone(zone)))).some(Boolean);
    this.keepaliveRuns++;
    const fullSweep = !((_b = (_a = this.deps).pushActive) == null ? void 0 : _b.call(_a)) || this.keepaliveRuns % PUSH_MODE_FULL_SWEEP_EVERY === 0;
    if (fullSweep) {
      await this.refreshMedia();
      await this.refreshLists();
      if (this.hasDistribution) {
        await this.refreshDistribution();
      }
    }
    this.dropDetector.record(anyOk);
  }
  /**
   * Refresh the list-shaped surfaces: the netusb favourites and recently-played
   * lists, the tuner preset lists, and the clock/alarm settings. Each is
   * best-effort — a device without the feature answers with an error code and the
   * state simply stays.
   */
  async refreshLists() {
    if (this.mediaBlocks.includes("netusb")) {
      await this.refreshNetusbPresets();
      await this.refreshNetusbRecent();
      if (this.hasMcPlaylist) {
        await this.refreshPlaylists();
      }
      if (this.hasPlayQueue) {
        await this.refreshPlayQueue();
      }
    }
    if (this.mediaBlocks.includes("tuner")) {
      await this.refreshTunerPresets();
    }
    if (this.hasClock) {
      await this.refreshClock();
    }
    await this.refreshSignalInfo();
  }
  /** Fetch the MusicCast playlist names and write the JSON list state. */
  async refreshPlaylists() {
    try {
      const update = (0, import_command_mapper.parseYxcPlaylistNames)(await this.deps.client.getMcPlaylistName());
      if (update) {
        this.emit(update.id, update.value);
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getMcPlaylistName failed: ${(0, import_util.errorMessage)(e)}`);
    }
  }
  /** Fetch the network player's play queue and write the JSON state. */
  async refreshPlayQueue() {
    try {
      const update = (0, import_command_mapper.parseYxcPlayQueue)(await this.deps.client.getPlayQueue());
      if (update) {
        this.emit(update.id, update.value);
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getPlayQueue failed: ${(0, import_util.errorMessage)(e)}`);
    }
  }
  /** Fetch each declaring zone's audio-signal info and write the signal states. */
  async refreshSignalInfo() {
    for (const zone of this.signalZones) {
      try {
        for (const update of (0, import_command_mapper.parseYxcSignalInfo)(await this.deps.client.getSignalInfo(zone), zone)) {
          this.emit(update.id, update.value);
        }
      } catch (e) {
        this.deps.log.debug(`${this.deviceId}: getSignalInfo(${zone}) failed: ${(0, import_util.errorMessage)(e)}`);
      }
    }
  }
  /** Fetch the stored netusb favourites and write the JSON list state. */
  async refreshNetusbPresets() {
    try {
      const update = (0, import_command_mapper.parseYxcPresetList)(await this.deps.client.getPresetInfo());
      if (update) {
        this.emit(update.id, update.value);
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getPresetInfo failed: ${(0, import_util.errorMessage)(e)}`);
    }
  }
  /** Fetch the recently-played list and write the JSON list state. */
  async refreshNetusbRecent() {
    try {
      const update = (0, import_command_mapper.parseYxcRecentList)(await this.deps.client.getRecentInfo());
      if (update) {
        this.emit(update.id, update.value);
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getRecentInfo failed: ${(0, import_util.errorMessage)(e)}`);
    }
  }
  /**
   * Fetch the tuner preset lists — the shared `common` list, or one per band on
   * devices with separate lists — and write the JSON state.
   */
  async refreshTunerPresets() {
    var _a, _b, _c;
    const bands = ((_a = this.tunerFeatures) == null ? void 0 : _a.presetType) === "common" ? ["common"] : (_c = (_b = this.tunerFeatures) == null ? void 0 : _b.bands) != null ? _c : ["fm"];
    const byBand = {};
    for (const band of bands) {
      try {
        byBand[band] = await this.deps.client.getTunerPresetInfo(band);
      } catch (e) {
        this.deps.log.debug(`${this.deviceId}: getTunerPresetInfo(${band}) failed: ${(0, import_util.errorMessage)(e)}`);
      }
    }
    const update = (0, import_command_mapper.parseYxcTunerPresetLists)(byBand);
    if (update) {
      this.emit(update.id, update.value);
    }
  }
  /** Fetch the clock/alarm settings and write the read-only clock states. */
  async refreshClock() {
    try {
      for (const update of (0, import_command_mapper.parseYxcClock)(await this.deps.client.getClockSettings())) {
        this.emit(update.id, update.value);
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getClockSettings failed: ${(0, import_util.errorMessage)(e)}`);
    }
  }
  /** Refresh every player source the device offers (network player, cd, tuner). */
  async refreshMedia() {
    await Promise.all(this.mediaBlocks.map((block) => this.refreshMediaSource(block)));
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
    const parse = (info) => block === "tuner" ? (0, import_command_mapper.parseYxcTunerInfo)(info) : (0, import_command_mapper.parseYxcPlayInfo)(info, block === "cd" ? "player.cd" : "player.netPlayer");
    try {
      const info = await this.deps.client.getPlayInfo(arg);
      for (const update of parse(info)) {
        this.emit(update.id, update.value);
        if (update.id === "tuner.band") {
          this.lastTunerBand = String(update.value);
        }
        if (update.id === "player.netPlayer.source" && typeof update.value === "string") {
          this.lastNetusbInput = update.value;
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
        this.emit(update.id, update.value);
        if (update.id === "multiroom.group.role") {
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
      this.deps.log.warn(`${this.deviceId}: leaveGroup failed: ${(0, import_util.errorMessage)(e)}`);
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
      this.deps.log.warn(`${this.deviceId}: linkClient(${clientIp}) failed: ${(0, import_util.errorMessage)(e)}`);
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
        this.emit(update.id, update.value);
        if (update.id.endsWith("input") && typeof update.value === "string") {
          this.lastZoneInput.set(zone, update.value);
        }
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
    const prefix = (0, import_zones.zonePrefix)(zone);
    const band = (b) => {
      const u = updates.find((x) => x.id === `${prefix}sound.equalizer${b}`);
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
   * Apply a mapped command. A plain command runs its client call directly; the two
   * commands that need controller-cached state (equalizer bands, tuner band) are
   * completed here — the only place that state lives.
   *
   * @param stateId the written state id, for the failure log line
   * @param command the YXC command to apply
   */
  async applyCommand(stateId, command) {
    var _a;
    try {
      switch (command.kind) {
        case "run":
          await command.run(this.deps.client);
          break;
        case "equalizer": {
          const { zone, band, value } = command;
          let current = this.lastEqualizer.get(zone);
          if (!current) {
            await this.refreshZone(zone);
            current = this.lastEqualizer.get(zone);
          }
          if (!current) {
            this.deps.log.warn(
              `${this.deviceId}: not writing ${stateId} \u2014 the device has not reported its equalizer bands yet`
            );
            break;
          }
          const next = { ...current, [band]: value };
          await this.deps.client.setEqualizer(next.low, next.mid, next.high, zone);
          this.lastEqualizer.set(zone, next);
          break;
        }
        case "tunerBand":
          await this.deps.client.setBand(command.band);
          this.lastTunerBand = command.band;
          break;
        case "tunerFreq":
          await this.deps.client.setFreq(this.lastTunerBand, command.value);
          break;
        case "tunerPreset": {
          const band = ((_a = this.tunerFeatures) == null ? void 0 : _a.presetType) === "common" ? "common" : this.lastTunerBand;
          await this.deps.client.recallTunerPreset(band, command.value, this.zoneListeningTo("tuner"));
          break;
        }
        case "netusbPreset":
          await this.deps.client.recallPreset(command.value, this.zoneListeningTo(this.lastNetusbInput));
          break;
        case "netusbRecent":
          await this.deps.client.recallRecentItem(command.value, this.zoneListeningTo(this.lastNetusbInput));
          break;
      }
    } catch (e) {
      this.deps.log.warn(`${this.deviceId}: write to ${stateId} failed: ${(0, import_util.errorMessage)(e)}`);
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  YxcDeviceController,
  zoneNameFrom
});
//# sourceMappingURL=device-controller.js.map
