import { createHash } from "node:crypto";
import { parseYxcFeatures, type YxcCapabilities, type YxcTunerFeatures } from "./capability";
import { mapYxcToObjects } from "./object-mapper";
import {
  parseYxcClock,
  parseYxcDistribution,
  parseYxcPlayInfo,
  parseYxcPlaylistNames,
  parseYxcPlayQueue,
  parseYxcPresetList,
  parseYxcRecentList,
  parseYxcSignalInfo,
  parseYxcStatus,
  parseYxcTunerInfo,
  parseYxcTunerPresetLists,
  PLAYER_CLEAR,
  stateToYxc,
  type PlayerTransport,
  type YxcCommand,
} from "./command-mapper";
import { mediaToRefresh, netusbListsToRefresh, zonesToRefresh } from "./push";
import type { ObjectDef } from "../catalog/types";
import type { StateValue } from "../types";
import type { ConnectionHandle, ControllerLog } from "../controller";
import { errorMessage } from "../util";
import { PollDropDetector } from "../lifecycle/poll-drop-detector";
import type { ProbeMemory } from "../lifecycle/probe-memory";
import { zonePrefix } from "./zones";
import { knownScenes, resolveSceneNumber } from "../catalog/scene-titles";
import type { CommandGate } from "../lifecycle/command-gate";
import type { BrowseEngine } from "../browse/browse-engine";
import { createBrowseSurface } from "../browse/surface";
import { YxcBrowseDriver } from "../browse/yxc-browse-driver";

/** Renew interval for the push registration + state poll, well under the ~20 min expiry. */
const KEEPALIVE_MS = 5 * 60 * 1000;

/**
 * With push working, run the full media/list/group sweep only every Nth keepalive (6 × 5 min
 * = every 30 minutes) — a safety net against a dropped UDP packet, not the primary path.
 */
const PUSH_MODE_FULL_SWEEP_EVERY = 6;

/**
 * Extract the model name from a getDeviceInfo response, if it carries a non-empty one.
 *
 * @param deviceInfo the getDeviceInfo response
 * @returns the model name, or undefined
 */
function modelNameFrom(deviceInfo: unknown): string | undefined {
  const model = (deviceInfo as { model_name?: unknown } | null)?.model_name;
  return typeof model === "string" && model.length > 0 ? model : undefined;
}

/**
 * Extract the name a user gave this device from a getNameText response.
 *
 * MusicCast keeps it as the main zone's text — that is the name shown in the app and
 * the one people recognise ("Wohnzimmer"). A device whose zone was never renamed
 * answers with a generic zone name; the caller filters those out.
 *
 * @param nameText the getNameText response
 * @returns the main zone's text, or undefined
 */
export function zoneNameFrom(nameText: unknown): string | undefined {
  const zones = (nameText as { zone_list?: unknown } | null)?.zone_list;
  if (!Array.isArray(zones)) {
    return undefined;
  }
  for (const zone of zones) {
    if (typeof zone !== "object" || zone === null) {
      continue;
    }
    const { id, text } = zone as { id?: unknown; text?: unknown };
    if (id === "main" && typeof text === "string" && text.trim().length > 0) {
      return text.trim();
    }
  }
  return undefined;
}

import type { YxcClientLike } from "./client-contract";

// Re-exported so existing importers (the tests' fakes) keep resolving it from here.
export type { YxcClientLike };

/** The adapter callbacks the controller drives — narrow, so no adapter mock is needed in tests. */
export interface YxcControllerDeps {
  /** The YXC (MusicCast) client for this device. */
  client: YxcClientLike;
  /** Resolve another configured device's client by IP, for forming a multiroom group. */
  clientFor?: (ip: string) => YxcClientLike | undefined;
  /** Register a push handler for this device (by IP); returns a function that unregisters it. */
  registerPush(onPush: (event: unknown) => void): () => void;
  /**
   * Whether the shared push receiver is actually listening. With push the device reports
   * its own changes, so the keepalive only has to renew the subscription and refresh the
   * zone status; without it (the port is taken — see issue #611) the poll is the ONLY
   * source of change and has to cover everything. Absent = assume no push.
   */
  pushActive?(): boolean;
  /** Per-device memory for answers that do not change while the device runs (see ProbeMemory). */
  probeMemory?: ProbeMemory;
  /** Schedule the keepalive handler; returns a function that cancels it. */
  scheduleKeepalive(handler: () => void, ms: number): () => void;
  /** Create or update an object in the device tree. */
  upsertObject(id: string, def: ObjectDef): Promise<void>;
  /** Write a state value with ack (device-originated). */
  setStateAck(id: string, value: boolean | number | string): void;
  /** Report the name the device carries for itself, for the device object's label. */
  reportDeviceName?(name: string): void;
  /** Adapter log. */
  log: ControllerLog;
  /**
   * The device's command gate: every request is paced through it, and its signal is the
   * connection's shutdown flag — a closed gate ends pending waits and stops state writes
   * from a poll that was already in flight. Absent in older tests → no browsing.
   */
  gate?: CommandGate;
}

/**
 * Drives one MusicCast (YXC) device: read capabilities, build the object tree,
 * seed state from getStatus, and route commands both ways. Device pushes arrive
 * via the shared receiver as re-fetch signals; a keepalive poll renews the push
 * registration (the fix for the musiccast "stops updating" bug) and doubles as
 * the poll-only fallback when the push port is unavailable. Create-only.
 */
export class YxcDeviceController implements ConnectionHandle {
  private zones: string[] = [];
  private mediaBlocks: string[] = [];
  private cancelKeepalive: (() => void) | undefined;
  private cancelPush: (() => void) | undefined;
  private readonly dropDetector = new PollDropDetector();
  /** The tuner's current band, cached so a frequency write can supply it (setFreq needs band + freq). */
  private lastTunerBand = "fm";
  /** Each zone's currently selected input, from its status — see {@link zoneListeningTo}. */
  private readonly lastZoneInput = new Map<string, string>();
  /** The source the network player is currently on (netusb `input`, e.g. "net_radio"). */
  private lastNetusbInput = "";
  /** Which source currently feeds each zone's "now playing" block (v2.0.0 routing). */
  private readonly zonePlayerBlock = new Map<string, "netusb" | "cd">();
  /** Each zone's last-seen equalizer bands, cached so one band write can supply the other two. */
  private readonly lastEqualizer = new Map<string, { low: number; mid: number; high: number }>();
  /** Whether the device reports MusicCast-Link distribution (gates the dist poll and objects). */
  private hasDistribution = false;
  /** The device's last-seen distribution role (none/server/client), for the leave-group path. */
  private lastDistRole = "none";
  /** The tuner features (bands + preset mode) — a preset recall needs the band. */
  private tunerFeatures: YxcTunerFeatures | undefined;
  /** Whether the device reports the clock/alarm block (gates the clock poll). */
  private hasClock = false;
  /** The zones declaring `signal_info` (gates the audio-signal poll). */
  private signalZones: string[] = [];
  /** Whether netusb declares the MusicCast playlists / the play queue (gates their polls). */
  private hasMcPlaylist = false;
  private hasPlayQueue = false;
  /** Counts keepalive runs, so the safety-net sweep can run every Nth one under push. */
  private keepaliveRuns = 0;
  private browseEngine: BrowseEngine | undefined;

  /**
   * @param deviceId the id-safe device id (object-tree path segment)
   * @param deps the client and adapter callbacks
   */
  public constructor(
    private readonly deviceId: string,
    private readonly deps: YxcControllerDeps,
  ) {}

  /**
   * Read capabilities, create the object tree, seed state, and wire up push +
   * keepalive.
   *
   * @returns true if the device reported capabilities and its tree was created
   */
  public async start(): Promise<boolean> {
    // Freshness guard for the (persisted) probe memory: ONE LIVE getDeviceInfo proves
    // the device behind this address is still the one the memory was learned from. A
    // swapped or factory-reset device answers a different identity — its remembered
    // YXC answers are dropped and re-probed; a transient failure keeps the memory and
    // leaves the liveness verdict to the zone check below. Also feeds the model line.
    let model: string | undefined;
    try {
      const info = await this.deps.client.getDeviceInfo();
      model = modelNameFrom(info);
      const version = (info as { system_version?: unknown } | null)?.system_version;
      const identity = `${model ?? ""}|${typeof version === "number" || typeof version === "string" ? version : ""}`;
      if (this.deps.probeMemory && this.deps.probeMemory.remembered("yxcIdentity") !== identity) {
        this.deps.probeMemory.drop(
          key => key === "features" || key === "name" || key === "model" || key === "yxcIdentity",
        );
        this.deps.probeMemory.set("yxcIdentity", identity);
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getDeviceInfo failed (${errorMessage(e)})`);
    }
    // Capabilities and name are constant while the device runs, so on a reconnect —
    // and, persisted, on a restart — they come from the per-device memory instead of
    // costing more round-trips on a connection that is being (re-)established anyway.
    const capabilities = await this.remember("features", async () =>
      parseYxcFeatures(await this.deps.client.getFeatures()),
    );
    const objects = mapYxcToObjects(capabilities);
    if (objects.length === 0) {
      this.deps.log.warn(`${this.deviceId}: no capabilities reported — creating no objects`);
      return false;
    }
    // Parents before children (channels before their states) — created in order.
    for (const object of objects) {
      await this.deps.upsertObject(`${this.deviceId}.${object.id}`, object);
    }
    await this.setupSceneLists(capabilities);
    if (model) {
      // The info channel and info.model already exist — the adapter creates them for
      // every device up front, so the card renders even while the device is offline.
      this.emit("info.model", model);
    }
    // The name the user gave the device in the MusicCast app. Best-effort like the model
    // above: an older device that does not answer getNameText simply keeps its label.
    if (this.deps.reportDeviceName) {
      try {
        const name = await this.remember("name", async () => zoneNameFrom(await this.deps.client.getNameText()));
        if (name) {
          this.deps.reportDeviceName(name);
        }
      } catch (e) {
        this.deps.log.debug(`${this.deviceId}: getNameText failed (${errorMessage(e)})`);
      }
    }
    this.zones = capabilities.zones.map(zone => zone.id);
    // Zones in parallel — disjoint writes, and a zone stuck in its timeout must not hold
    // up the device's readiness.
    const zonesAnswered = await Promise.all(this.zones.map(zone => this.refreshZone(zone)));
    // The zone status is the one request of this start that ALWAYS goes to the device: the
    // capabilities above come from the probe memory on every reconnect, and model/name are
    // best-effort, so nothing before this point can tell a live device from a dead one. Without
    // the check a reconnect to a receiver that had lost power still reported "ready —
    // MusicCast ✓" out of memory while YNCA and XML failed honestly, and info.connection stayed
    // true for a device that was not there (krobi's RX-V6A, 2026-08-26). A device that answers
    // no zone at all is gone — a standby device still answers, it just reports power=standby.
    if (this.zones.length > 0 && !zonesAnswered.some(Boolean)) {
      this.deps.log.debug(`${this.deviceId}: no zone answered getStatus — device unreachable (YXC)`);
      return false;
    }
    this.mediaBlocks = capabilities.media;
    this.tunerFeatures = capabilities.tuner;
    this.hasClock = capabilities.clock !== undefined;
    this.signalZones = capabilities.zones.filter(zone => zone.funcs.includes("signal_info")).map(zone => zone.id);
    this.hasMcPlaylist = capabilities.netusbFuncs?.includes("mc_playlist") ?? false;
    this.hasPlayQueue = capabilities.netusbFuncs?.includes("play_queue") ?? false;
    await this.setupBrowse(capabilities);
    await this.refreshMedia();
    // Seed the WHOLE player block with its cleared shape for every zone NOT playing a
    // media source: the routing above only writes to listening zones, so on a device
    // that starts on HDMI the block would sit valueless until the first media playback
    // (live 2.0.0 deployment check — same gap the pre-release audit found for source).
    if (this.mediaBlocks.includes("netusb") || this.mediaBlocks.includes("cd")) {
      for (const zone of this.zones.length > 0 ? this.zones : ["main"]) {
        if (!this.zonePlayerBlock.has(zone)) {
          this.emitPlayerUpdates(zone, PLAYER_CLEAR);
        }
      }
    }
    await this.refreshLists();
    this.hasDistribution = capabilities.hasDistribution ?? false;
    if (this.hasDistribution) {
      await this.refreshDistribution();
    }
    this.cancelPush = this.deps.registerPush(event => this.onPush(event));
    this.cancelKeepalive = this.deps.scheduleKeepalive(() => void this.keepalive(), KEEPALIVE_MS);
    // The adapter logs one combined "ready" line across all transports; this stays at debug.
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
  private remember<T>(key: string, probe: () => Promise<T>): Promise<T> {
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
  private zoneListeningTo(source: string): string {
    if (!source) {
      return "main";
    }
    // Main first: on a device where several zones share the source, it is the natural target.
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
  private emit(relativeId: string, value: boolean | number | string): void {
    if (this.deps.gate?.closed) {
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
  public handleStateChange(fullStateId: string, ack: boolean, value: unknown): void {
    if (ack) {
      return;
    }
    const prefix = `${this.deviceId}.`;
    if (!fullStateId.startsWith(prefix)) {
      return;
    }
    const stateId = fullStateId.slice(prefix.length);
    if (stateId.startsWith("player.browse.")) {
      this.browseEngine?.handleWrite(stateId, value);
      return;
    }
    // A scene TITLE resolves to its number via the shared device memory — the titles may
    // have come over XML or YNCA while MusicCast owns the recall.
    const sceneMatch = /^(?:multiroom\.(zone[234])\.)?scene\.recall$/.exec(stateId);
    if (sceneMatch && typeof value === "string" && !/^\d+$/.test(value.trim())) {
      const resolved = resolveSceneNumber(value, this.deps.probeMemory, sceneMatch[1] ?? "main");
      if (resolved === undefined) {
        return;
      }
      value = resolved;
    }
    // Multiroom writes need controller state (the cached role), so they bypass the pure command map.
    if (stateId === "multiroom.group.leave") {
      void this.leaveGroup();
      return;
    }
    if (stateId === "multiroom.group.linkDevice") {
      void this.linkClient(String(value));
      return;
    }
    const command = stateToYxc(stateId, value);
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
  public onDrop(cb: (reason?: Error) => void): void {
    this.dropDetector.onDrop(cb);
  }

  /**
   * Create the browsing surface (#613) when the device has the netusb block: the
   * `netusb/getListInfo` + `setListControl` API drives an 8-line window under
   * `player.browse.*`. Skipped without a delay dep (older tests).
   *
   * @param capabilities the parsed getFeatures capabilities
   */
  private async setupBrowse(capabilities: YxcCapabilities): Promise<void> {
    const gate = this.deps.gate;
    if (!gate || !capabilities.media.includes("netusb")) {
      return;
    }
    const inputs = capabilities.zones.find(zone => zone.id === "main")?.inputs ?? [];
    const driver = new YxcBrowseDriver(this.deps.client, inputs);
    this.browseEngine = await createBrowseSurface(driver, this.deviceId, {
      upsertObject: this.deps.upsertObject,
      emit: (id, value) => this.emit(id, value),
      log: this.deps.log,
      delay: ms => gate.delay(ms),
    });
  }

  /** Cancel the keepalive and unregister the push handler. Synchronous — safe from onUnload. */
  public close(): void {
    this.browseEngine?.close();
    // Closing the gate empties its queue and aborts its signal: queued requests are
    // dropped and every pending wait ends, so nothing writes after the teardown.
    this.deps.gate?.close();
    this.cancelKeepalive?.();
    this.cancelKeepalive = undefined;
    // Unregister from the shared push receiver — otherwise a push arriving after
    // teardown would setState on a controller the adapter has already dropped.
    this.cancelPush?.();
    this.cancelPush = undefined;
  }

  /**
   * Handle a device push: each named zone is re-fetched via getStatus, each named
   * media source via getPlayInfo (the push itself is a change signal, not a value
   * carrier). Refreshing only the named sources keeps a track-change push from
   * re-polling every source.
   *
   * @param event the parsed push event
   */
  private onPush(event: unknown): void {
    for (const zone of zonesToRefresh(event)) {
      if (this.zones.includes(zone)) {
        void this.refreshZone(zone);
      }
    }
    for (const block of mediaToRefresh(event)) {
      if (this.mediaBlocks.includes(block)) {
        void this.refreshMediaSource(block);
      }
    }
    // The favourites/recently-played lists announce their changes as flags in the push.
    const lists = netusbListsToRefresh(event);
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
  private async keepalive(): Promise<void> {
    // Zones in parallel: their writes are disjoint and one zone stuck in its timeout must
    // not delay the others (a four-zone receiver used to poll them strictly in series).
    const zones = this.zones.length > 0 ? this.zones : ["main"];
    const anyOk = (await Promise.all(zones.map(zone => this.refreshZone(zone)))).some(Boolean);
    // Every request above already carried the subscription headers, so the push
    // registration is renewed either way. What still has to be polled depends on whether
    // push works: with push the device announces media, list and group changes itself, so
    // the full sweep only runs occasionally as a safety net (UDP can drop a packet);
    // without push it is the only way anything ever updates.
    this.keepaliveRuns++;
    const fullSweep = !this.deps.pushActive?.() || this.keepaliveRuns % PUSH_MODE_FULL_SWEEP_EVERY === 0;
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
  private async refreshLists(): Promise<void> {
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
  private async refreshPlaylists(): Promise<void> {
    try {
      const update = parseYxcPlaylistNames(await this.deps.client.getMcPlaylistName());
      if (update) {
        this.emit(update.id, update.value);
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getMcPlaylistName failed: ${errorMessage(e)}`);
    }
  }

  /** Fetch the network player's play queue and write the JSON state. */
  private async refreshPlayQueue(): Promise<void> {
    try {
      const update = parseYxcPlayQueue(await this.deps.client.getPlayQueue());
      if (update) {
        this.emit(update.id, update.value);
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getPlayQueue failed: ${errorMessage(e)}`);
    }
  }

  /** Fetch each declaring zone's audio-signal info and write the signal states. */
  private async refreshSignalInfo(): Promise<void> {
    for (const zone of this.signalZones) {
      try {
        for (const update of parseYxcSignalInfo(await this.deps.client.getSignalInfo(zone), zone)) {
          this.emit(update.id, update.value);
        }
      } catch (e) {
        this.deps.log.debug(`${this.deviceId}: getSignalInfo(${zone}) failed: ${errorMessage(e)}`);
      }
    }
  }

  /** Fetch the stored netusb favourites and write the JSON list state. */
  private async refreshNetusbPresets(): Promise<void> {
    try {
      const update = parseYxcPresetList(await this.deps.client.getPresetInfo());
      if (update) {
        this.emit(update.id, update.value);
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getPresetInfo failed: ${errorMessage(e)}`);
    }
  }

  /** Fetch the recently-played list and write the JSON list state. */
  private async refreshNetusbRecent(): Promise<void> {
    try {
      const update = parseYxcRecentList(await this.deps.client.getRecentInfo());
      if (update) {
        this.emit(update.id, update.value);
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getRecentInfo failed: ${errorMessage(e)}`);
    }
  }

  /**
   * Fetch the tuner preset lists — the shared `common` list, or one per band on
   * devices with separate lists — and write the JSON state.
   */
  private async refreshTunerPresets(): Promise<void> {
    const bands = this.tunerFeatures?.presetType === "common" ? ["common"] : (this.tunerFeatures?.bands ?? ["fm"]);
    const byBand: Record<string, unknown> = {};
    for (const band of bands) {
      try {
        byBand[band] = await this.deps.client.getTunerPresetInfo(band);
      } catch (e) {
        this.deps.log.debug(`${this.deviceId}: getTunerPresetInfo(${band}) failed: ${errorMessage(e)}`);
      }
    }
    const update = parseYxcTunerPresetLists(byBand);
    if (update) {
      this.emit(update.id, update.value);
    }
  }

  /** Fetch the clock/alarm settings and write the read-only clock states. */
  private async refreshClock(): Promise<void> {
    try {
      for (const update of parseYxcClock(await this.deps.client.getClockSettings())) {
        this.emit(update.id, update.value);
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getClockSettings failed: ${errorMessage(e)}`);
    }
  }

  /** Refresh every player source the device offers (network player, cd, tuner). */
  private async refreshMedia(): Promise<void> {
    // The three sources (netusb/cd/tuner) write disjoint states — fetch them together.
    await Promise.all(this.mediaBlocks.map(block => this.refreshMediaSource(block)));
  }

  /**
   * Fetch one media source's play info and write the parsed states with ack. The
   * source picks the getPlayInfo argument and the parser: netusb and cd share the
   * play-info shape (different channel), the tuner has its own band/frequency/RDS.
   *
   * @param block the media block (`netusb`, `cd`, `tuner`)
   */
  private async refreshMediaSource(block: string): Promise<void> {
    const arg = block === "netusb" ? undefined : block;
    try {
      const info = await this.deps.client.getPlayInfo(arg);
      if (block === "tuner") {
        for (const update of parseYxcTunerInfo(info)) {
          this.emit(update.id, update.value);
          if (update.id === "tuner.band") {
            this.lastTunerBand = String(update.value);
          }
        }
        return;
      }
      const source: "netusb" | "cd" = block === "cd" ? "cd" : "netusb";
      const updates = parseYxcPlayInfo(info, source);
      if (source === "netusb") {
        const active = updates.find(update => update.id === "player.source");
        if (typeof active?.value === "string") {
          this.lastNetusbInput = active.value;
        }
      }
      this.routePlayerBlock(source, updates);
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getPlayInfo(${arg ?? ""}) failed: ${errorMessage(e)}`);
    }
  }

  /**
   * Which player source a zone's input feeds into its "now playing" block: `cd` for
   * the disc input, `netusb` when the zone's input IS the network player's active
   * source. Anything else (HDMI, analog, tuner) plays no media block.
   *
   * @param input the zone's currently selected input
   * @returns the feeding source, or undefined when the input is no media player
   */
  private playerBlockFor(input: string | undefined): "netusb" | "cd" | undefined {
    if (input === "cd" && this.mediaBlocks.includes("cd")) {
      return "cd";
    }
    if (input !== undefined && input !== "" && input === this.lastNetusbInput && this.mediaBlocks.includes("netusb")) {
      return "netusb";
    }
    return undefined;
  }

  /**
   * Route one source's play info into the "now playing" block of every zone listening
   * to it (v2.0.0): main flat, the other zones under their multiroom folder. A zone
   * that LEFT the source gets its block cleared once — the previous program's metadata
   * must not linger under a zone that no longer plays it. Drive-own `player.cd.*`
   * extras are device-global and emitted once, unprefixed.
   *
   * @param block the source the updates came from
   * @param updates the parsed flat player updates
   */
  private routePlayerBlock(block: "netusb" | "cd", updates: StateValue[]): void {
    const zones = this.zones.length > 0 ? this.zones : ["main"];
    for (const zone of zones) {
      const expected = this.playerBlockFor(this.lastZoneInput.get(zone));
      const previous = this.zonePlayerBlock.get(zone);
      if (previous === block && expected !== block) {
        // The zone left OUR source — clear; the new source's refresh fills its own values.
        this.zonePlayerBlock.delete(zone);
        this.emitPlayerUpdates(zone, PLAYER_CLEAR);
      }
      if (expected === block) {
        if (previous !== block) {
          this.zonePlayerBlock.set(zone, block);
          if (previous !== undefined) {
            this.emitPlayerUpdates(zone, PLAYER_CLEAR);
          }
        }
        this.emitPlayerUpdates(zone, updates);
      }
    }
    for (const update of updates) {
      if (update.id.startsWith("player.cd.")) {
        this.emit(update.id, update.value);
      }
    }
  }

  /**
   * One scene.list JSON per scene-capable zone (v2.0.0): every recall slot the zone
   * declares (getFeatures scene_num), titled from the shared per-device memory where
   * another transport reported titles (XML Scene_Sel_Item / YNCA SCENExNAME). A
   * MusicCast-only device has no title source and lists its slots with empty titles —
   * the COUNT is what its getFeatures declares (review finding: the promised list was
   * missing entirely on devices whose only transport is MusicCast).
   *
   * @param capabilities the device's parsed getFeatures capabilities
   */
  private async setupSceneLists(capabilities: YxcCapabilities): Promise<void> {
    for (const zone of capabilities.zones) {
      if (!zone.funcs.includes("scene") || zone.sceneNum === undefined || zone.sceneNum <= 0) {
        continue;
      }
      const titles = new Map(knownScenes(this.deps.probeMemory, zone.id).map(scene => [scene.num, scene.title]));
      const list = Array.from({ length: zone.sceneNum }, (_unused, i) => ({
        num: i + 1,
        title: titles.get(i + 1) ?? "",
      }));
      const id = `${zonePrefix(zone.id)}scene.list`;
      await this.deps.upsertObject(`${this.deviceId}.${id}`, {
        id,
        type: "state",
        common: { name: "Scenes (number + title)", type: "string", role: "json", read: true, write: false },
      });
      this.emit(id, JSON.stringify(list));
    }
  }

  /**
   * Re-evaluate which source feeds a zone's player block after ITS input changed:
   * clear the block when the zone left a media source, and fetch the joined source's
   * play info right away so the block fills now, not at the next sweep.
   *
   * @param zone the zone whose input just changed
   */
  private retargetZonePlayer(zone: string): void {
    const expected = this.playerBlockFor(this.lastZoneInput.get(zone));
    const previous = this.zonePlayerBlock.get(zone);
    if (previous === expected) {
      return;
    }
    if (previous !== undefined) {
      this.zonePlayerBlock.delete(zone);
      this.emitPlayerUpdates(zone, PLAYER_CLEAR);
    }
    if (expected !== undefined) {
      // routePlayerBlock (inside this refresh) records the zone's new source.
      void this.refreshMediaSource(expected);
    }
  }

  /**
   * Emit flat player updates into one zone's block (main flat, zones prefixed),
   * skipping the device-global drive extras.
   *
   * @param zone the target zone
   * @param updates the flat player updates
   */
  private emitPlayerUpdates(zone: string, updates: StateValue[]): void {
    const prefix = zonePrefix(zone);
    for (const update of updates) {
      if (!update.id.startsWith("player.cd.")) {
        this.emit(`${prefix}${update.id}`, update.value);
      }
    }
  }

  /**
   * Fetch the MusicCast-Link distribution info and write the parsed dist states with ack,
   * caching the role for the leave-group path.
   */
  private async refreshDistribution(): Promise<void> {
    try {
      const info = await this.deps.client.getDistributionInfo();
      for (const update of parseYxcDistribution(info)) {
        this.emit(update.id, update.value);
        if (update.id === "multiroom.group.role") {
          this.lastDistRole = String(update.value);
        }
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getDistributionInfo failed: ${errorMessage(e)}`);
    }
  }

  /**
   * Leave the current MusicCast-Link group: a server stops distributing, a client clears
   * its membership. Then re-read the distribution state so the tree reflects the change.
   */
  private async leaveGroup(): Promise<void> {
    try {
      if (this.lastDistRole === "server") {
        await this.deps.client.stopDistribution();
      } else {
        await this.deps.client.setClientInfo({ group_id: "", zone: ["main"] });
      }
      await this.refreshDistribution();
    } catch (e) {
      // A user action failing must be visible — warn, like every other write command.
      this.deps.log.warn(`${this.deviceId}: leaveGroup failed: ${errorMessage(e)}`);
    }
  }

  /**
   * Form a MusicCast-Link group with another configured device: give the client the shared
   * group id, add it to this device's roster as the server, and start distributing. The group
   * id is derived from this device's id, so re-linking reuses the same group rather than a new one.
   *
   * @param clientIp the IP of the client device to add (must be a configured device)
   */
  private async linkClient(clientIp: string): Promise<void> {
    const clientClient = this.deps.clientFor?.(clientIp);
    if (!clientClient) {
      this.deps.log.warn(`${this.deviceId}: cannot link ${clientIp} — not a known device`);
      return;
    }
    try {
      const groupId = createHash("md5").update(this.deviceId).digest("hex");
      await clientClient.setClientInfo({ group_id: groupId, zone: ["main"] });
      await this.deps.client.setServerInfo({ group_id: groupId, zone: "main", type: "add", client_list: [clientIp] });
      await this.deps.client.startDistribution(0);
      await this.refreshDistribution();
    } catch (e) {
      // A user action failing must be visible — warn, like every other write command.
      this.deps.log.warn(`${this.deviceId}: linkClient(${clientIp}) failed: ${errorMessage(e)}`);
    }
  }

  /**
   * Fetch a zone's status and write its amp states with ack.
   *
   * @param zone the zone to refresh
   * @returns true if the status was fetched, false if the request failed
   */
  private async refreshZone(zone: string): Promise<boolean> {
    try {
      const status = await this.deps.client.getStatus(zone);
      const updates = parseYxcStatus(status, zone);
      for (const update of updates) {
        this.emit(update.id, update.value);
        if (update.id.endsWith("input") && typeof update.value === "string") {
          const previous = this.lastZoneInput.get(zone);
          this.lastZoneInput.set(zone, update.value);
          if (previous !== update.value) {
            // The zone changed its input — re-target its player block NOW. Media
            // pushes alone cannot cover this: a zone leaving a still-playing source
            // (or joining one another zone already plays) changes nothing about the
            // source itself, so no netusb/cd push ever arrives (2.0.0 review finding).
            this.retargetZonePlayer(zone);
          }
        }
      }
      this.cacheEqualizer(zone, updates);
      return true;
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getStatus(${zone}) failed: ${errorMessage(e)}`);
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
  private cacheEqualizer(zone: string, updates: StateValue[]): void {
    // Same definition the status parser uses — see lib/yxc/zones.ts on why this must not
    // be spelled out a second time.
    const prefix = zonePrefix(zone);
    const band = (b: string): number | undefined => {
      const u = updates.find(x => x.id === `${prefix}sound.equalizer.${b}`);
      return typeof u?.value === "number" ? u.value : undefined;
    };
    if (band("low") === undefined && band("mid") === undefined && band("high") === undefined) {
      return;
    }
    const cur = this.lastEqualizer.get(zone) ?? { low: 0, mid: 0, high: 0 };
    this.lastEqualizer.set(zone, {
      low: band("low") ?? cur.low,
      mid: band("mid") ?? cur.mid,
      high: band("high") ?? cur.high,
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
  private async applyCommand(stateId: string, command: YxcCommand): Promise<void> {
    try {
      switch (command.kind) {
        case "run":
          await command.run(this.deps.client);
          break;
        case "equalizer": {
          // The device sets all three bands in one call, so the other two come from the
          // cache. Without a cached set we must NOT invent 0/0/0 — that would silently
          // flatten the user's other two bands. The cache fills from a zone status, so
          // fetch one first; only if even that fails is the write refused (with a warning).
          const { zone, band, value } = command;
          let current = this.lastEqualizer.get(zone);
          if (!current) {
            await this.refreshZone(zone);
            current = this.lastEqualizer.get(zone);
          }
          if (!current) {
            this.deps.log.warn(
              `${this.deviceId}: not writing ${stateId} — the device has not reported its equalizer bands yet`,
            );
            break;
          }
          const next = { ...current, [band]: value };
          // Cache BEFORE the round-trip: a second band written straight afterwards
          // reads this cache at dispatch — caching after the await would make it
          // compute from the pre-write triple and undo this band on the device.
          this.lastEqualizer.set(zone, next);
          await this.deps.client.setEqualizer(next.low, next.mid, next.high, zone);
          break;
        }
        case "tunerBand":
          // Remember it BEFORE the round-trip: a frequency written straight afterwards
          // reads this cache synchronously at dispatch, while the band call may still
          // be in flight — and the poll that would report it back runs minutes later.
          this.lastTunerBand = command.band;
          await this.deps.client.setBand(command.band);
          break;
        case "tunerFreq":
          await this.deps.client.setFreq(this.lastTunerBand, command.value);
          break;
        case "tunerPreset": {
          // Shared-list devices recall on `common`; separate-list devices on the current band.
          const band = this.tunerFeatures?.presetType === "common" ? "common" : this.lastTunerBand;
          await this.deps.client.recallTunerPreset(band, command.value, this.zoneListeningTo("tuner"));
          break;
        }
        case "netusbPreset":
          await this.deps.client.recallPreset(command.value, this.zoneListeningTo(this.lastNetusbInput));
          break;
        case "netusbRecent":
          await this.deps.client.recallRecentItem(command.value, this.zoneListeningTo(this.lastNetusbInput));
          break;
        case "playerTransport": {
          // The unified block's buttons act on whatever the ZONE is playing (v2.0.0) —
          // derived FRESH from the zone's input, never from the routing map: a stale
          // map entry would send the command to the source the zone just left.
          const block = this.playerBlockFor(this.lastZoneInput.get(command.zone));
          if (block === undefined) {
            this.deps.log.debug(`${this.deviceId}: ${stateId} ignored — ${command.zone} is not playing a media source`);
            break;
          }
          await this.runTransport(block, command.action);
          break;
        }
      }
    } catch (e) {
      this.deps.log.warn(`${this.deviceId}: write to ${stateId} failed: ${errorMessage(e)}`);
    }
  }

  /**
   * Run one transport action on the given player source. The CD transport routes
   * through the one `setCDPlayback(action)` method (not the per-action helpers, one
   * of which sends the wrong command in the library).
   *
   * @param block the source the zone is playing
   * @param action the transport action
   */
  private async runTransport(block: "netusb" | "cd", action: PlayerTransport): Promise<void> {
    const client = this.deps.client;
    if (block === "netusb") {
      const net: Record<PlayerTransport, () => Promise<unknown>> = {
        play: () => client.playNet(),
        pause: () => client.pauseNet(),
        stop: () => client.stopNet(),
        next: () => client.nextNet(),
        prev: () => client.prevNet(),
        repeatToggle: () => client.toggleNetRepeat(),
        shuffleToggle: () => client.toggleNetShuffle(),
      };
      await net[action]();
      return;
    }
    const cd: Record<PlayerTransport, () => Promise<unknown>> = {
      play: () => client.setCDPlayback("play"),
      pause: () => client.setCDPlayback("pause"),
      stop: () => client.setCDPlayback("stop"),
      next: () => client.setCDPlayback("next"),
      prev: () => client.setCDPlayback("previous"),
      repeatToggle: () => client.toggleCDRepeat(),
      shuffleToggle: () => client.toggleCDShuffle(),
    };
    await cd[action]();
  }
}
