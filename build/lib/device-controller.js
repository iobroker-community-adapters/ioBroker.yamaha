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
  YncaDeviceController: () => YncaDeviceController
});
module.exports = __toCommonJS(device_controller_exports);
var import_capability = require("./ynca/capability");
var import_value_coerce = require("./catalog/value-coerce");
var import_play_time = require("./catalog/play-time");
var import_i18n = require("./i18n");
var import_catalog = require("./ynca/catalog");
var import_surface = require("./browse/surface");
var import_ynca_browse_driver = require("./browse/ynca-browse-driver");
const FUNC_MAP = (0, import_catalog.funcToEntry)(import_catalog.YNCA_CATALOG);
const ID_MAP = (0, import_catalog.idToEntry)(import_catalog.YNCA_CATALOG);
const AVAIL_PROBE = (0, import_catalog.availGets)(import_catalog.YNCA_CATALOG);
const STATIC_FUNC = /^(INPNAME|SCENE\d+NAME$)/;
const YNCA_ZONES = [
  { key: "main", subunit: "MAIN", prefix: "" },
  { key: "zone2", subunit: "ZONE2", prefix: "multiroom.zone2." },
  { key: "zone3", subunit: "ZONE3", prefix: "multiroom.zone3." },
  { key: "zone4", subunit: "ZONE4", prefix: "multiroom.zone4." }
];
const INPUT_SUBUNITS = {
  NETRADIO: "NETRADIO",
  SERVER: "SERVER",
  USB: "USB",
  SPOTIFY: "SPOTIFY",
  DEEZER: "DEEZER",
  TIDAL: "TIDAL",
  NAPSTER: "NAPSTER",
  PANDORA: "PANDORA",
  RHAPSODY: "RHAP",
  SIRIUS: "SIRIUS",
  SIRIUSXM: "SIRIUS",
  SIRIUSIR: "SIRIUS",
  AIRPLAY: "AIRPLAY",
  BLUETOOTH: "BT",
  PC: "PC",
  MUSICCASTLINK: "MCLINK",
  IPOD: "IPOD",
  IPODUSB: "IPODUSB"
};
function playerSubunitForInput(input) {
  if (typeof input !== "string" || input.length === 0) {
    return void 0;
  }
  return INPUT_SUBUNITS[input.toUpperCase().replace(/[^A-Z0-9]/g, "")];
}
const FLAT_PLAYER_ID = /^player\.[^.]+$/;
const YNCA_PLAYER_CLEAR = [
  { id: "player.playback", value: 1 },
  { id: "player.artist", value: "" },
  { id: "player.album", value: "" },
  { id: "player.track", value: "" },
  { id: "player.station", value: "" },
  { id: "player.channelName", value: "" },
  { id: "player.elapsedTime", value: 0 },
  { id: "player.elapsedTimeText", value: "" },
  { id: "player.totalTime", value: 0 },
  { id: "player.totalTimeText", value: "" },
  { id: "player.repeat", value: 0 },
  { id: "player.shuffle", value: false }
];
const STATIC_KEY = "yncaStaticValues";
const CAPS_KEY = "yncaCapabilities";
function isCachedCapabilities(value) {
  const candidate = value;
  return typeof candidate === "object" && candidate !== null && typeof candidate.model === "string" && typeof candidate.firmware === "string" && typeof candidate.subunits === "object" && candidate.subunits !== null;
}
const LIST_PROOF = /^(LISTLAYER|LISTLAYERNAME|CURRLINE|MAXLINE|LINE[1-8](TXT|ATRIB))$/;
function sceneTitlesOf(subunits) {
  var _a;
  const main = (_a = subunits.MAIN) != null ? _a : {};
  const scenes = [];
  for (let n = 1; n <= 12; n++) {
    const title = main[`SCENE${n}NAME`];
    if (typeof title === "string" && title.length > 0) {
      scenes.push({ num: n, title });
    }
  }
  return scenes;
}
class YncaDeviceController {
  /**
   * @param deviceId the id-safe device id (object-tree path segment)
   * @param deps the client and adapter callbacks
   */
  constructor(deviceId, deps) {
    this.deviceId = deviceId;
    this.deps = deps;
  }
  browseDriver;
  browseEngine;
  /**
   * Write map filtered to the entries THIS device reported — claim-with-proof for
   * writes: a command is only sent with a wire function the device answered in the
   * sweep. Until the sweep ran, the unfiltered static map answers.
   */
  writeMap;
  /** The device's scene titles (SCENExNAME), for the recall dropdown, the list state and title writes. */
  sceneTitles = [];
  /** The tuner's current band (AM/FM/DAB), for the band-dependent frequency/preset writes. */
  tunerBand = "";
  /** Whether the device carries the DAB subunit (its FM half shares the flat tuner ids). */
  hasDab = false;
  /** The entries THIS device reported — the per-subunit lookup behind the player routing. */
  presentEntries = [];
  /** Each zone's currently selected input (INP), for the player routing (v2.0.0). */
  zoneInputs = /* @__PURE__ */ new Map();
  /** The zones that got a player block (main plus every present ZONEn, when sources exist). */
  playerZones = [];
  /**
   * Connect, sweep the device from the catalog, and create its object tree; wire
   * up push updates. The catalog is the single source: it drives the sweep, the
   * device→state read-back and (in handleStateChange) the state→wire encode.
   *
   * @returns true if the device reported capabilities and its tree was created
   */
  async start() {
    var _a, _b, _c, _d, _e, _f, _g;
    await this.deps.client.connect();
    const catalog = this.deps.isEntryEnabled ? import_catalog.YNCA_CATALOG.filter((entry) => this.deps.isEntryEnabled(entry.id)) : import_catalog.YNCA_CATALOG;
    const resolved = await this.resolveCapabilities(catalog);
    const { capabilities, fromCache } = resolved;
    const present = (0, import_catalog.presentYncaEntries)(capabilities, catalog);
    this.writeMap = (0, import_catalog.idToEntry)(present);
    this.presentEntries = present;
    const live = fromCache ? await this.readDecisiveValues(capabilities) : capabilities;
    for (const zone of YNCA_ZONES) {
      const input = (_a = live.subunits[zone.subunit]) == null ? void 0 : _a.INP;
      if (typeof input === "string") {
        this.zoneInputs.set(zone.key, input);
      }
    }
    const objects = (0, import_catalog.yncaObjectsFor)(capabilities, catalog);
    if (objects.length === 0) {
      this.deps.log.warn(`${this.deviceId}: no capabilities reported \u2014 creating no objects`);
      return false;
    }
    (_c = (_b = this.deps.client).onRefusal) == null ? void 0 : _c.call(
      _b,
      (command, verdict) => this.deps.log.warn(`${this.deviceId}: device refused "${command}" (@${verdict.toUpperCase()})`)
    );
    this.sceneTitles = sceneTitlesOf(capabilities.subunits);
    for (const object of objects) {
      if (object.id === "scene.recall" && this.sceneTitles.length > 0) {
        object.common.states = Object.fromEntries(this.sceneTitles.map((scene) => [scene.num, scene.title]));
      }
      await this.deps.upsertObject(`${this.deviceId}.${object.id}`, object);
    }
    if (this.sceneTitles.length > 0) {
      await this.deps.upsertObject(`${this.deviceId}.scene.list`, {
        id: "scene.list",
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
      this.deps.setStateAck(`${this.deviceId}.scene.list`, JSON.stringify(this.sceneTitles));
    }
    await this.setupZonePlayers(capabilities, objects);
    if (!fromCache) {
      for (const [subunit, funcs] of Object.entries(capabilities.subunits)) {
        for (const [func, value] of Object.entries(funcs)) {
          const update = (0, import_catalog.yncaStateUpdate)({ subunit, func, value }, FUNC_MAP);
          if (update) {
            if (FLAT_PLAYER_ID.test(update.id)) {
              this.routePlayerUpdate(subunit, update.id, update.value);
            } else {
              this.deps.setStateAck(`${this.deviceId}.${update.id}`, update.value);
            }
          }
        }
      }
    }
    this.hasDab = capabilities.subunits.DAB !== void 0;
    this.tunerBand = ((_g = (_f = (_d = live.subunits.DAB) == null ? void 0 : _d.BAND) != null ? _f : (_e = live.subunits.TUN) == null ? void 0 : _e.BAND) != null ? _g : "").toUpperCase();
    await this.setupBrowse(live);
    this.deps.client.onMessage((message) => {
      var _a2;
      (_a2 = this.browseDriver) == null ? void 0 : _a2.handleMessage(message);
      if (message.func === "BAND" && (message.subunit === "TUN" || message.subunit === "DAB")) {
        this.tunerBand = message.value.toUpperCase();
      }
      if (message.func === "INP") {
        const zone = YNCA_ZONES.find((z) => z.subunit === message.subunit);
        if (zone) {
          this.handleInputSwitch(zone.key, message.value);
        }
      }
      const update = (0, import_catalog.yncaStateUpdate)(message, FUNC_MAP);
      if (update) {
        if (FLAT_PLAYER_ID.test(update.id)) {
          this.routePlayerUpdate(message.subunit, update.id, update.value);
        } else {
          this.deps.setStateAck(`${this.deviceId}.${update.id}`, update.value);
        }
      }
    });
    this.deps.client.startKeepalive();
    if (fromCache) {
      void this.refreshInBackground(catalog);
    }
    this.deps.log.debug(`${this.deviceId}: ${capabilities.model || "device"} ready (YNCA)`);
    return true;
  }
  /**
   * The device's capabilities — from the persisted fast-restart layer when the LIVE
   * identity (model + firmware, two paced reads, ~0.2 s) matches what the layer was
   * captured from, else from the full two-pass sweep. The identity read doubles as the
   * liveness proof the ready line rests on: a cached shape alone must never present a
   * dead device as connected (the v1.5.0 honesty rule).
   *
   * @param catalog the (group-filtered) catalog
   * @returns the capabilities and whether they came from the persisted layer
   */
  async resolveCapabilities(catalog) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const identity = await this.deps.client.readCapabilities([
      { subunit: "SYS", func: "MODELNAME" },
      { subunit: "SYS", func: "VERSION" }
    ]);
    const model = identity.model;
    const firmware = (_b = (_a = identity.subunits.SYS) == null ? void 0 : _a.VERSION) != null ? _b : "";
    const remembered = (_c = this.deps.probeMemory) == null ? void 0 : _c.remembered(CAPS_KEY);
    if (model && isCachedCapabilities(remembered) && remembered.model === model && remembered.firmware === firmware) {
      return { capabilities: { model, subunits: remembered.subunits }, fromCache: true };
    }
    if (remembered !== void 0) {
      (_d = this.deps.probeMemory) == null ? void 0 : _d.drop((key) => key === CAPS_KEY || key === STATIC_KEY);
    }
    const capabilities = await this.sweepDevice(catalog, model, firmware);
    if (capabilities.model) {
      (_g = this.deps.probeMemory) == null ? void 0 : _g.set(CAPS_KEY, {
        model: capabilities.model,
        firmware: (_f = (_e = capabilities.subunits.SYS) == null ? void 0 : _e.VERSION) != null ? _f : firmware,
        subunits: capabilities.subunits
      });
    } else {
      (_h = this.deps.probeMemory) == null ? void 0 : _h.drop((key) => key === STATIC_KEY);
    }
    return { capabilities, fromCache: false };
  }
  /**
   * Re-read the handful of values the START makes DECISIONS from, and lay them over the
   * remembered shape (fresh wins).
   *
   * The persisted capability layer is a shape whose values are the last run's leftovers —
   * the type says so ("used for SHAPE only"). Three decisions used them anyway, and a
   * receiver stands in standby most of the time, so the memory usually says `PWR=Standby`:
   * - the menu claim skips its proof while the device is not on, so a stale "Standby"
   *   made YNCA claim `player.browse.*` UNPROVEN and displace the XML driver that does
   *   probe — issue #613, brought back in through the cache;
   * - a `tuner.frequency` write is routed by the band, so a stale band sends AMFREQ where
   *   FMFREQ belongs (a wrong command on the wire, not just a stale reading);
   * - the player's transport buttons are routed by the zone's input, so a stale input
   *   sends play/pause to the source the zone listened to LAST time.
   *
   * Six reads at most (~0.6 s through the gate), once per connect. A drop during them
   * fails the connect — which is honest: the device is gone.
   *
   * @param remembered the capability shape from the persisted layer
   * @returns the remembered shape with the live answers laid over it
   */
  async readDecisiveValues(remembered) {
    const gets = [];
    if (remembered.subunits.MAIN !== void 0) {
      gets.push({ subunit: "MAIN", func: "PWR" });
    }
    for (const zone of YNCA_ZONES) {
      if (remembered.subunits[zone.subunit] !== void 0) {
        gets.push({ subunit: zone.subunit, func: "INP" });
      }
    }
    for (const subunit of ["TUN", "DAB"]) {
      if (remembered.subunits[subunit] !== void 0) {
        gets.push({ subunit, func: "BAND" });
      }
    }
    if (gets.length === 0) {
      return remembered;
    }
    const fresh = await this.deps.client.readCapabilities(gets);
    return { model: remembered.model, subunits: (0, import_capability.mergeYncaSubunits)(remembered.subunits, fresh.subunits) };
  }
  /**
   * The fast path's second half: re-ask every catalogued function of the present
   * subunits — the answers stream into the states through the live message handler,
   * so current values arrive within the usual sweep time WITHOUT having gated the
   * ready line. Completion refreshes the persisted layers (capabilities, statics)
   * and the write map; a SHAPE change (a function newly answered) is only persisted —
   * its object appears on the next start, because the unified tree is coordinated
   * once per connect and a late upsert would not materialize.
   *
   * @param catalog the (group-filtered) catalog
   */
  async refreshInBackground(catalog) {
    var _a, _b, _c, _d, _e, _f, _g;
    try {
      const cached = (_a = this.deps.subunitCache) == null ? void 0 : _a.get();
      const gets = (0, import_catalog.sweepGets)(catalog).filter(
        (get) => get.subunit === "SYS" || !cached || cached.subunits.includes(get.subunit)
      );
      const fresh = await this.deps.client.readCapabilities(gets);
      if (!fresh.model) {
        return;
      }
      const statics = {};
      for (const [subunit, funcs] of Object.entries(fresh.subunits)) {
        for (const [func, value] of Object.entries(funcs)) {
          if (STATIC_FUNC.test(func)) {
            ((_b = statics[subunit]) != null ? _b : statics[subunit] = {})[func] = value;
          }
        }
      }
      (_c = this.deps.probeMemory) == null ? void 0 : _c.set(STATIC_KEY, statics);
      const remembered = (_d = this.deps.probeMemory) == null ? void 0 : _d.remembered(CAPS_KEY);
      const subunits = isCachedCapabilities(remembered) ? (0, import_capability.mergeYncaSubunits)(remembered.subunits, fresh.subunits) : fresh.subunits;
      (_g = this.deps.probeMemory) == null ? void 0 : _g.set(CAPS_KEY, {
        model: fresh.model,
        firmware: (_f = (_e = fresh.subunits.SYS) == null ? void 0 : _e.VERSION) != null ? _f : "",
        subunits
      });
      this.presentEntries = (0, import_catalog.presentYncaEntries)({ model: fresh.model, subunits }, catalog);
      this.writeMap = (0, import_catalog.idToEntry)(this.presentEntries);
      const titles = sceneTitlesOf(subunits);
      if (JSON.stringify(titles) !== JSON.stringify(this.sceneTitles)) {
        this.sceneTitles = titles;
        if (titles.length > 0) {
          this.deps.setStateAck(`${this.deviceId}.scene.list`, JSON.stringify(titles));
        }
      }
      this.deps.log.debug(`${this.deviceId}: background value refresh done (YNCA)`);
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: background value refresh failed: ${String(e)}`);
    }
  }
  /**
   * Read the device's capabilities with the two-pass sweep. Pass 1 probes each
   * catalogued subunit with `AVAIL=?` (~2 s); pass 2 sweeps only the subunits that
   * answered, plus SYS (which never answers AVAIL) — on a typical receiver that
   * saves a third or more of the ~39 s blind sweep. A cached probe result (per
   * device, surviving reconnects and restarts) skips pass 1 entirely; a device
   * whose model or firmware no longer matches the cache re-probes. A device that
   * answers no AVAIL at all falls back to the full blind sweep, so an unknown
   * firmware loses speed, never features.
   *
   * @param catalog the (group-filtered) catalog whose functions to sweep
   * @param model the live-read SYS model name (from resolveCapabilities)
   * @param firmware the live-read SYS firmware version
   * @returns the assembled capabilities
   */
  async sweepDevice(catalog, model, firmware) {
    var _a, _b, _c, _d, _e;
    const cached = (_a = this.deps.subunitCache) == null ? void 0 : _a.get();
    if (cached) {
      if (model === cached.model && firmware === cached.firmware) {
        return await this.targetedSweep(catalog, new Set(cached.subunits));
      }
      this.deps.log.debug(`${this.deviceId}: cached subunit set is stale (model/firmware changed), re-probing`);
      (_b = this.deps.subunitCache) == null ? void 0 : _b.clear();
    }
    const probe = await this.deps.client.readCapabilities(AVAIL_PROBE);
    const present = new Set(Object.keys(probe.subunits));
    if (present.size === 0) {
      return await this.deps.client.readCapabilities((0, import_catalog.sweepGets)(catalog));
    }
    const capabilities = await this.targetedSweep(catalog, present);
    if (capabilities.model) {
      (_e = this.deps.subunitCache) == null ? void 0 : _e.set({
        subunits: [...present],
        model: capabilities.model,
        firmware: (_d = (_c = capabilities.subunits.SYS) == null ? void 0 : _c.VERSION) != null ? _d : ""
      });
    }
    return capabilities;
  }
  /**
   * Sweep only the present subunits' functions (SYS always included — it answers no
   * AVAIL but carries model/firmware/master power).
   *
   * @param catalog the (group-filtered) catalog whose functions to sweep
   * @param present the subunits that answered the AVAIL probe
   * @returns the assembled capabilities
   */
  async targetedSweep(catalog, present) {
    var _a, _b, _c;
    const gets = (0, import_catalog.sweepGets)(catalog).filter((get) => get.subunit === "SYS" || present.has(get.subunit));
    const remembered = (_a = this.deps.probeMemory) == null ? void 0 : _a.remembered(STATIC_KEY);
    const capabilities = await this.deps.client.readCapabilities(
      remembered ? gets.filter((get) => !STATIC_FUNC.test(get.func)) : gets
    );
    if (remembered) {
      for (const [subunit, funcs] of Object.entries(remembered)) {
        capabilities.subunits[subunit] = { ...funcs, ...capabilities.subunits[subunit] };
      }
      return capabilities;
    }
    const statics = {};
    for (const [subunit, funcs] of Object.entries(capabilities.subunits)) {
      for (const [func, value] of Object.entries(funcs)) {
        if (STATIC_FUNC.test(func)) {
          ((_b = statics[subunit]) != null ? _b : statics[subunit] = {})[func] = value;
        }
      }
    }
    (_c = this.deps.probeMemory) == null ? void 0 : _c.set(STATIC_KEY, statics);
    return capabilities;
  }
  /**
   * Handle a state change: a user write (ack false) becomes a YNCA command; an
   * acked change (the device's own echo) is ignored to avoid a resend loop.
   *
   * @param fullStateId the full state id (device id + "." + state)
   * @param ack whether the change is acked (device-originated)
   * @param value the new value
   */
  handleStateChange(fullStateId, ack, value) {
    var _a, _b, _c;
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
    if (stateId === "scene.recall" && typeof value === "string" && !/^\d+$/.test(value.trim())) {
      const needle = value.trim().toLowerCase();
      const match = this.sceneTitles.find((scene) => scene.title.toLowerCase() === needle);
      if (match === void 0) {
        this.deps.log.debug(
          `${this.deviceId}: scene "${value}" is not one this device declares \u2014 write dropped (known: ${this.sceneTitles.map((scene) => scene.title).join(", ") || "none yet"})`
        );
        return;
      }
      value = match.num;
    }
    const playerWrite = /^(?:multiroom\.(zone[234])\.)?player\.(playback|repeat|shuffle|next|prev)$/.exec(stateId);
    if (playerWrite) {
      this.handlePlayerWrite((_b = playerWrite[1]) != null ? _b : "main", `player.${playerWrite[2]}`, value);
      return;
    }
    if (this.handleTunerWrite(stateId, value)) {
      return;
    }
    const triple = (0, import_catalog.yncaCommand)(stateId, value, (_c = this.writeMap) != null ? _c : ID_MAP);
    if (triple) {
      this.deps.client.send(triple.subunit, triple.func, triple.value);
    }
  }
  /**
   * Create the per-zone player mirrors (v2.0.0): every present ZONEn gets its own
   * "now playing" block under its multiroom folder — zones can play different
   * sources, one shared block could not show that. The defs are clones of the flat
   * block the catalog built for the main zone, plus the `source` display each zone
   * (main included) gets.
   *
   * @param capabilities the device's swept capabilities
   * @param objects the main tree's object definitions (source of the block's shape)
   */
  async setupZonePlayers(capabilities, objects) {
    const playerObjects = objects.filter(
      (object) => object.id === "player" || object.type === "state" && FLAT_PLAYER_ID.test(object.id)
    );
    if (!playerObjects.some((object) => object.type === "state")) {
      this.playerZones = [];
      return;
    }
    const sourceDef = (id) => ({
      id,
      type: "state",
      common: {
        name: (0, import_i18n.tName)("playingSource"),
        desc: (0, import_i18n.tName)("descPlayingSource"),
        type: "string",
        role: "text",
        read: true,
        write: false
      }
    });
    await this.deps.upsertObject(`${this.deviceId}.player.source`, sourceDef("player.source"));
    this.playerZones = ["main"];
    for (const zone of YNCA_ZONES) {
      if (zone.key === "main" || capabilities.subunits[zone.subunit] === void 0) {
        continue;
      }
      this.playerZones.push(zone.key);
      for (const object of playerObjects) {
        const id = `${zone.prefix}${object.id}`;
        await this.deps.upsertObject(`${this.deviceId}.${id}`, { ...object, id });
      }
      await this.deps.upsertObject(
        `${this.deviceId}.${zone.prefix}player.source`,
        sourceDef(`${zone.prefix}player.source`)
      );
    }
    const presentFlat = new Set(
      this.presentEntries.filter((entry) => FLAT_PLAYER_ID.test(entry.id)).map((entry) => entry.id)
    );
    for (const zone of YNCA_ZONES) {
      if (!this.playerZones.includes(zone.key)) {
        continue;
      }
      const input = this.zoneInputs.get(zone.key);
      const playing = playerSubunitForInput(input) !== void 0;
      this.deps.setStateAck(
        `${this.deviceId}.${zone.prefix}player.source`,
        playing && input !== void 0 ? input : ""
      );
      if (!playing) {
        for (const clear of YNCA_PLAYER_CLEAR) {
          if (presentFlat.has(clear.id)) {
            this.deps.setStateAck(`${this.deviceId}.${zone.prefix}${clear.id}`, clear.value);
          }
        }
      }
    }
  }
  /**
   * Feed one player-subunit value into the block of every zone listening to that
   * source — and only those: an idle source's answer (the sweep reads them all)
   * must not overwrite what the active source shows.
   *
   * @param subunit the source subunit the value came from
   * @param id the flat player state id
   * @param value the decoded value
   */
  routePlayerUpdate(subunit, id, value) {
    const twin = (0, import_play_time.playTimeTwin)(id, value);
    for (const zone of YNCA_ZONES) {
      if (!this.playerZones.includes(zone.key)) {
        continue;
      }
      if (playerSubunitForInput(this.zoneInputs.get(zone.key)) === subunit) {
        this.deps.setStateAck(`${this.deviceId}.${zone.prefix}${id}`, value);
        if (twin) {
          this.deps.setStateAck(`${this.deviceId}.${zone.prefix}${twin.id}`, twin.value);
        }
      }
    }
  }
  /**
   * Track a zone's input switch: remember the input, and when the zone changed its
   * player source, clear the block (stale metadata must not linger) and ask the new
   * source for its current state — YNCA pushes changes, but a source that was already
   * playing has nothing new to push.
   *
   * @param zoneKey the zone (`main`, `zone2`, …)
   * @param input the new INP value
   */
  handleInputSwitch(zoneKey, input) {
    var _a;
    const before = playerSubunitForInput(this.zoneInputs.get(zoneKey));
    this.zoneInputs.set(zoneKey, input);
    const after = playerSubunitForInput(input);
    if (before === after || !this.playerZones.includes(zoneKey)) {
      return;
    }
    const zone = YNCA_ZONES.find((z) => z.key === zoneKey);
    if (!zone) {
      return;
    }
    const presentFlat = new Set(
      this.presentEntries.filter((entry) => FLAT_PLAYER_ID.test(entry.id)).map((entry) => entry.id)
    );
    for (const clear of YNCA_PLAYER_CLEAR) {
      if (presentFlat.has(clear.id)) {
        this.deps.setStateAck(`${this.deviceId}.${zone.prefix}${clear.id}`, clear.value);
      }
    }
    this.deps.setStateAck(`${this.deviceId}.${zone.prefix}player.source`, after === void 0 ? "" : input);
    if (after !== void 0) {
      const funcs = /* @__PURE__ */ new Set();
      for (const entry of this.presentEntries) {
        if (entry.subunit === after && FLAT_PLAYER_ID.test(entry.id) && !entry.writeOnly) {
          funcs.add((_a = entry.readFunc) != null ? _a : entry.func);
        }
      }
      for (const func of funcs) {
        this.deps.client.get(after, func);
      }
    }
  }
  /**
   * Route a unified player write (playback/repeat/shuffle/next/prev) to the source
   * subunit the ZONE is listening to — with the entry that subunit itself reported
   * (claim-with-proof, like every other write).
   *
   * @param zoneKey the zone the write belongs to
   * @param flatId the flat player state id
   * @param value the written value
   */
  handlePlayerWrite(zoneKey, flatId, value) {
    const subunit = playerSubunitForInput(this.zoneInputs.get(zoneKey));
    if (subunit === void 0) {
      this.deps.log.debug(`${this.deviceId}: ${flatId} ignored \u2014 ${zoneKey} is not playing a media source`);
      return;
    }
    const entry = this.presentEntries.find((e) => e.id === flatId && e.subunit === subunit);
    if (entry === void 0) {
      this.deps.log.debug(`${this.deviceId}: ${flatId} ignored \u2014 ${subunit} did not report it`);
      return;
    }
    const triple = (0, import_catalog.yncaCommand)(flatId, value, /* @__PURE__ */ new Map([[flatId, entry]]));
    if (triple) {
      this.deps.client.send(triple.subunit, triple.func, triple.value);
    }
  }
  /**
   * Route the band-dependent tuner writes (v2.0.0 unification): ONE frequency state
   * in kHz and ONE preset state, sent to the wire function of the ACTIVE band —
   * AM/FM on the classic TUN subunit, FM/DAB on the DAB subunit (whose FM half
   * shares the flat ids). A DAB frequency write is dropped: DAB tunes by service,
   * the device has no frequency command there.
   *
   * @param stateId the state id relative to the device
   * @param value the written value
   * @returns true when the id was a band-routed tuner write (handled here)
   */
  handleTunerWrite(stateId, value) {
    if (stateId === "tuner.frequency") {
      const khz = Number(value);
      if (!Number.isFinite(khz)) {
        return true;
      }
      if (this.hasDab) {
        if (this.tunerBand === "FM") {
          this.sendProven("DAB", "FMFREQ", (0, import_value_coerce.formatWireNumber)(khz / 1e3, 2));
        } else {
          this.deps.log.debug(`${this.deviceId}: DAB tunes by service \u2014 frequency write ignored`);
        }
        return true;
      }
      if (this.tunerBand === "AM") {
        this.sendProven("TUN", "AMFREQ", String(Math.round(khz)));
      } else {
        this.sendProven("TUN", "FMFREQ", (0, import_value_coerce.formatWireNumber)(khz / 1e3, 2));
      }
      return true;
    }
    if (stateId === "tuner.band") {
      const band = typeof value === "string" ? value : "";
      const subunit = band === "AM" ? "TUN" : band === "DAB" || this.hasDab ? "DAB" : "TUN";
      const entry = this.presentEntries.find(
        (candidate) => candidate.id === "tuner.band" && candidate.subunit === subunit
      );
      const triple = entry ? (0, import_catalog.yncaCommand)(stateId, value, /* @__PURE__ */ new Map([[stateId, entry]])) : void 0;
      if (triple) {
        this.sendProven(triple.subunit, triple.func, triple.value);
      } else {
        this.deps.log.debug(`${this.deviceId}: band "${band}" is not available on this device \u2014 write dropped`);
      }
      return true;
    }
    if (stateId === "tuner.preset" && this.hasDab) {
      const slot = Math.round(Number(value));
      if (Number.isFinite(slot) && slot >= 1) {
        this.sendProven("DAB", this.tunerBand === "DAB" ? "DABPRESET" : "FMPRESET", String(slot));
      }
      return true;
    }
    return false;
  }
  /**
   * Send a band-routed write ONLY with a function THIS device reported in its sweep —
   * the same claim-with-proof rule every generic write obeys (#615 class). Without it
   * the router put a blind TUN:FMFREQ on the wire for any device, tuner or not, and
   * each write surfaced as a "device refused" warning (test-audit finding).
   *
   * @param subunit the target subunit
   * @param func the wire function
   * @param wire the encoded wire value
   */
  sendProven(subunit, func, wire) {
    if (!this.presentEntries.some((entry) => entry.subunit === subunit && entry.func === func)) {
      this.deps.log.debug(`${this.deviceId}: ${subunit}:${func} not reported by this device \u2014 write dropped`);
      return;
    }
    this.deps.client.send(subunit, func, wire);
  }
  /**
   * Create the browsing surface (#613) when the device reports a browsable media
   * subunit: the official YNCA list vocabulary (LISTINFO/LISTSEL/LISTPAGE/LISTCURSOR)
   * drives an 8-line window under `player.browse.*`. Skipped without a delay dep
   * (older tests) and when the playback group is switched off.
   *
   * @param capabilities the device's swept capabilities
   */
  async setupBrowse(capabilities) {
    var _a, _b;
    const gate = this.deps.gate;
    if (!gate || ((_b = (_a = this.deps).isEntryEnabled) == null ? void 0 : _b.call(_a, "player.browse.source")) === false) {
      return;
    }
    const delay = (ms) => gate.delay(ms);
    const present = await this.probeBrowseSubunits(capabilities);
    if (present.size === 0) {
      this.deps.log.debug(`${this.deviceId}: no YNCA source answers LISTINFO \u2014 leaving menus to another transport`);
      return;
    }
    const driver = new import_ynca_browse_driver.YncaBrowseDriver(this.deps.client, present, delay);
    this.browseEngine = await (0, import_surface.createBrowseSurface)(driver, this.deviceId, {
      upsertObject: this.deps.upsertObject,
      emit: (id, value) => this.deps.setStateAck(`${this.deviceId}.${id}`, value),
      log: this.deps.log,
      delay
    });
    if (this.browseEngine) {
      this.browseDriver = driver;
    }
  }
  /**
   * Which browsable subunits actually SERVE menus, proven by asking them.
   *
   * Carrying the subunit is NOT proof: the RX-A810 reference log answers `@SERVER:LISTINFO=?`
   * with `@UNDEFINED` while NETRADIO/PC/USB on the very same device return a full window. The
   * XML driver has always probed (`List_Info` → `<Menu_Status>`); YNCA claimed the states on
   * presence alone and, ranking higher, silently displaced the transport that could deliver.
   *
   * @param capabilities the device's swept capabilities
   * @returns the subunits that answered with list data
   */
  async probeBrowseSubunits(capabilities) {
    var _a;
    const candidates = import_ynca_browse_driver.YNCA_BROWSE_SOURCES.filter((source) => source.subunit in capabilities.subunits);
    if (candidates.length === 0) {
      return /* @__PURE__ */ new Set();
    }
    if (((_a = capabilities.subunits.MAIN) == null ? void 0 : _a.PWR) !== "On") {
      return new Set(candidates.map((source) => source.subunit));
    }
    const answer = await this.deps.client.readCapabilities(
      candidates.map((source) => ({ subunit: source.subunit, func: "LISTINFO" }))
    );
    return new Set(
      candidates.map((source) => source.subunit).filter((subunit) => {
        var _a2;
        return Object.keys((_a2 = answer.subunits[subunit]) != null ? _a2 : {}).some((func) => LIST_PROOF.test(func));
      })
    );
  }
  /**
   * Register the supervisor's drop handler — delegated to the client's socket drop,
   * which is YNCA's genuine connection-lost signal.
   *
   * @param cb invoked once when the connection drops, with the reason if known
   */
  onDrop(cb) {
    this.deps.client.onDrop(cb);
  }
  /** Close the client. Synchronous — safe to call from onUnload. */
  close() {
    var _a, _b;
    (_a = this.browseEngine) == null ? void 0 : _a.close();
    (_b = this.browseDriver) == null ? void 0 : _b.close();
    this.deps.client.close();
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  YncaDeviceController
});
//# sourceMappingURL=device-controller.js.map
