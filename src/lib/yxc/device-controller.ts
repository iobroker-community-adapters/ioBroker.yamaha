import { createHash } from "node:crypto";
import { parseYxcFeatures } from "./capability";
import { mapYxcToObjects } from "./object-mapper";
import {
  parseYxcDistribution,
  parseYxcPlayInfo,
  parseYxcStatus,
  parseYxcTunerInfo,
  stateToYxc,
  type YxcCommand,
} from "./command-mapper";
import { mediaToRefresh, zonesToRefresh } from "./push";
import type { ObjectDef } from "../catalog/types";
import type { StateValue } from "../types";
import type { ConnectionHandle, ControllerLog } from "../controller";
import { errorMessage } from "../util";

/** Renew interval for the push registration + state poll, well under the ~20 min expiry. */
const KEEPALIVE_MS = 5 * 60 * 1000;

/**
 * Report a drop after this many consecutive keepalive polls in which every zone
 * failed. MusicCast has no socket-drop event, so a run of failed polls is how a
 * gone device is noticed — letting the supervisor flip info.connection and reconnect.
 */
const MAX_KEEPALIVE_FAILURES = 3;

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

/** The subset of the YamahaYXC client the controller uses (so tests can inject a fake). */
export interface YxcClientLike {
  /** Read the device's capabilities (zones, functions, inputs, ranges). */
  getFeatures(): Promise<unknown>;
  /** Read a zone's current status. */
  getStatus(zone: string): Promise<unknown>;
  /** Read the device's system info (model name, firmware). */
  getDeviceInfo(): Promise<unknown>;
  /**
   * Read a player source's play info. `undefined` reads the network/USB player,
   * `"cd"` the disc player, `"tuner"` the tuner (band/frequency/RDS).
   */
  getPlayInfo(source?: string): Promise<unknown>;
  /** Set a zone's power. */
  power(on: boolean, zone: string): Promise<unknown>;
  /** Set a zone's absolute volume (raw YXC scale). */
  setVolumeTo(to: number, zone: string): Promise<unknown>;
  /** Set a zone's mute. */
  mute(on: boolean, zone: string): Promise<unknown>;
  /** Select a zone's input. */
  setInput(input: string, zone: string): Promise<unknown>;
  /** Select a zone's sound program. */
  setSound(program: string, zone: string): Promise<unknown>;
  /** Turn a zone's enhancer on/off. */
  setEnhancer(on: boolean, zone: string): Promise<unknown>;
  /** Turn a zone's pure direct on/off. */
  setPureDirect(on: boolean, zone: string): Promise<unknown>;
  /** Set a zone's subwoofer trim. */
  setSubwooferVolumeTo(to: number, zone: string): Promise<unknown>;
  /** Set a zone's tone-control bass. */
  setBassTo(to: number, zone: string): Promise<unknown>;
  /** Set a zone's tone-control treble. */
  setTrebleTo(to: number, zone: string): Promise<unknown>;
  /** Set a zone's sleep timer in minutes. */
  sleep(minutes: number, zone: string): Promise<unknown>;
  /** Turn a zone's Direct mode on/off. */
  setDirect(on: boolean, zone: string): Promise<unknown>;
  /** Turn a zone's Clear Voice on/off. */
  setClearVoice(on: boolean, zone: string): Promise<unknown>;
  /** Turn a zone's bass extension on/off. */
  setBassExtension(on: boolean, zone: string): Promise<unknown>;
  /** Set a zone's balance. */
  setBalance(value: number, zone: string): Promise<unknown>;
  /** Set the manual equalizer's three bands (low/mid/high) in one call. */
  setEqualizer(low: number, mid: number, high: number, zone: string): Promise<unknown>;
  /** Start the network/USB player. */
  playNet(): Promise<unknown>;
  /** Pause the network/USB player. */
  pauseNet(): Promise<unknown>;
  /** Stop the network/USB player. */
  stopNet(): Promise<unknown>;
  /** Skip to the next track. */
  nextNet(): Promise<unknown>;
  /** Skip to the previous track. */
  prevNet(): Promise<unknown>;
  /** Drive the CD transport with a YXC action word (`play`, `pause`, `stop`, `next`, `previous`). */
  setCDPlayback(action: string): Promise<unknown>;
  /** Toggle network/USB repeat. */
  toggleNetRepeat(): Promise<unknown>;
  /** Toggle network/USB shuffle. */
  toggleNetShuffle(): Promise<unknown>;
  /** Toggle CD repeat. */
  toggleCDRepeat(): Promise<unknown>;
  /** Toggle CD shuffle. */
  toggleCDShuffle(): Promise<unknown>;
  /** Open/close the CD tray. */
  toggleTray(): Promise<unknown>;
  /** Set the tuner band. */
  setBand(band: string): Promise<unknown>;
  /** Set the tuner frequency for a band. */
  setFreq(band: string, freq: number): Promise<unknown>;
  /** Turn party mode on/off. */
  setPartyMode(on: boolean): Promise<unknown>;
  /** Recall a network/USB preset. */
  recallPreset(num: number, zone: string): Promise<unknown>;
  /** Read the MusicCast-Link distribution info (role, group, client list). */
  getDistributionInfo(): Promise<unknown>;
  /** Set the group master's client roster (link/unlink sequence). */
  setServerInfo(info: {
    group_id: string;
    zone: string;
    type: "add" | "remove";
    client_list: string[];
  }): Promise<unknown>;
  /** Set a group member's membership (link/unlink sequence). */
  setClientInfo(info: { group_id: string; zone: string[] }): Promise<unknown>;
  /** Start distributing to the group's clients (called on the master). */
  startDistribution(num: number): Promise<unknown>;
  /** Stop distributing, breaking up the group (called on the master). */
  stopDistribution(): Promise<unknown>;
}

/** The adapter callbacks the controller drives — narrow, so no adapter mock is needed in tests. */
export interface YxcControllerDeps {
  /** The YXC (MusicCast) client for this device. */
  client: YxcClientLike;
  /** Resolve another configured device's client by IP, for forming a multiroom group. */
  clientFor?: (ip: string) => YxcClientLike | undefined;
  /** Register a push handler for this device (by IP); returns a function that unregisters it. */
  registerPush(onPush: (event: unknown) => void): () => void;
  /** Schedule the keepalive handler; returns a function that cancels it. */
  scheduleKeepalive(handler: () => void, ms: number): () => void;
  /** Create or update an object in the device tree. */
  upsertObject(id: string, def: ObjectDef): Promise<void>;
  /** Write a state value with ack (device-originated). */
  setStateAck(id: string, value: boolean | number | string): void;
  /** Adapter log. */
  log: ControllerLog;
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
  private dropHandler: ((reason?: Error) => void) | undefined;
  private failedKeepalives = 0;
  private dropped = false;
  /** The tuner's current band, cached so a frequency write can supply it (setFreq needs band + freq). */
  private lastTunerBand = "fm";
  /** Each zone's last-seen equalizer bands, cached so one band write can supply the other two. */
  private readonly lastEqualizer = new Map<string, { low: number; mid: number; high: number }>();
  /** Whether the device reports MusicCast-Link distribution (gates the dist poll and objects). */
  private hasDistribution = false;
  /** The device's last-seen distribution role (none/server/client), for the leave-group path. */
  private lastDistRole = "none";

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
    const capabilities = parseYxcFeatures(await this.deps.client.getFeatures());
    const objects = mapYxcToObjects(capabilities);
    if (objects.length === 0) {
      this.deps.log.warn(`${this.deviceId}: no capabilities reported — creating no objects`);
      return false;
    }
    // Parents before children (channels before their states) — created in order.
    for (const object of objects) {
      await this.deps.upsertObject(`${this.deviceId}.${object.id}`, object);
    }
    // The model name (getDeviceInfo) for the device-manager card. Best-effort: a device that
    // does not answer getDeviceInfo still connects — the model line just stays empty.
    try {
      const model = modelNameFrom(await this.deps.client.getDeviceInfo());
      if (model) {
        await this.deps.upsertObject(`${this.deviceId}.info`, {
          id: "info",
          type: "channel",
          common: { name: "Info" },
        });
        await this.deps.upsertObject(`${this.deviceId}.info.model`, {
          id: "info.model",
          type: "state",
          common: { name: "Model", type: "string", role: "text", read: true, write: false },
        });
        this.deps.setStateAck(`${this.deviceId}.info.model`, model);
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getDeviceInfo failed (${errorMessage(e)})`);
    }
    this.zones = capabilities.zones.map(zone => zone.id);
    for (const zone of this.zones) {
      await this.refreshZone(zone);
    }
    this.mediaBlocks = capabilities.media;
    await this.refreshMedia();
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
    // Multiroom writes need controller state (the cached role), so they bypass the pure command map.
    if (stateId === "dist.leaveGroup") {
      void this.leaveGroup();
      return;
    }
    if (stateId === "dist.linkClient") {
      void this.linkClient(String(value));
      return;
    }
    const command = stateToYxc(stateId, value);
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
  public onDrop(cb: (reason?: Error) => void): void {
    this.dropHandler = cb;
  }

  /** Cancel the keepalive and unregister the push handler. Synchronous — safe from onUnload. */
  public close(): void {
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
  }

  /**
   * Poll every zone (which renews the push registration and refreshes state) and the
   * media sources. If every zone poll fails for MAX_KEEPALIVE_FAILURES runs in a row,
   * the device is judged gone and a drop is reported so the supervisor can flip
   * info.connection and reconnect.
   */
  private async keepalive(): Promise<void> {
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
  private reportDrop(): void {
    if (this.dropped) {
      return;
    }
    this.dropped = true;
    this.dropHandler?.(new Error(`${MAX_KEEPALIVE_FAILURES} keepalive polls failed`));
  }

  /** Refresh every player source the device offers (network player, cd, tuner). */
  private async refreshMedia(): Promise<void> {
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
  private async refreshMediaSource(block: string): Promise<void> {
    const arg = block === "netusb" ? undefined : block;
    const parse = (info: unknown): StateValue[] =>
      block === "tuner" ? parseYxcTunerInfo(info) : parseYxcPlayInfo(info, block === "cd" ? "cd" : "netPlayer");
    try {
      const info = await this.deps.client.getPlayInfo(arg);
      for (const update of parse(info)) {
        this.deps.setStateAck(`${this.deviceId}.${update.id}`, update.value);
        if (update.id === "tuner.band") {
          this.lastTunerBand = String(update.value);
        }
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getPlayInfo(${arg ?? ""}) failed: ${errorMessage(e)}`);
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
        this.deps.setStateAck(`${this.deviceId}.${update.id}`, update.value);
        if (update.id === "dist.role") {
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
      this.deps.log.debug(`${this.deviceId}: leaveGroup failed: ${errorMessage(e)}`);
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
      this.deps.log.debug(`${this.deviceId}: linkClient(${clientIp}) failed: ${errorMessage(e)}`);
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
        this.deps.setStateAck(`${this.deviceId}.${update.id}`, update.value);
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
    const prefix = zone === "main" ? "" : `${zone}.`;
    const band = (b: string): number | undefined => {
      const u = updates.find(x => x.id === `${prefix}equalizer${b}`);
      return typeof u?.value === "number" ? u.value : undefined;
    };
    if (band("Low") === undefined && band("Mid") === undefined && band("High") === undefined) {
      return;
    }
    const cur = this.lastEqualizer.get(zone) ?? { low: 0, mid: 0, high: 0 };
    this.lastEqualizer.set(zone, {
      low: band("Low") ?? cur.low,
      mid: band("Mid") ?? cur.mid,
      high: band("High") ?? cur.high,
    });
  }

  /**
   * Send a mapped command to the device through the matching client method.
   *
   * @param command the YXC command to apply
   */
  private async applyCommand(command: YxcCommand): Promise<void> {
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
          // The method name carries the band; the other two come from the cached status.
          const band = command.method.slice("setEqualizer".length).toLowerCase() as "low" | "mid" | "high";
          const next = { ...(this.lastEqualizer.get(zone) ?? { low: 0, mid: 0, high: 0 }), [band]: Number(value) };
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
          this.deps.log.warn(`${this.deviceId}: unknown YXC command "${command.method}" — ignored`);
      }
    } catch (e) {
      this.deps.log.warn(`${this.deviceId}: ${command.method} failed: ${errorMessage(e)}`);
    }
  }
}
