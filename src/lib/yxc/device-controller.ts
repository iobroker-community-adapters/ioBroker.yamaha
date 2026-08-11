import { parseYxcFeatures } from "./capability";
import { mapYxcToObjects } from "./object-mapper";
import { parseYxcPlayInfo, parseYxcStatus, parseYxcTunerInfo, stateToYxc, type YxcCommand } from "./command-mapper";
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

/** The subset of the YamahaYXC client the controller uses (so tests can inject a fake). */
export interface YxcClientLike {
  /** Read the device's capabilities (zones, functions, inputs, ranges). */
  getFeatures(): Promise<unknown>;
  /** Read a zone's current status. */
  getStatus(zone: string): Promise<unknown>;
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
}

/** The adapter callbacks the controller drives — narrow, so no adapter mock is needed in tests. */
export interface YxcControllerDeps {
  /** The YXC (MusicCast) client for this device. */
  client: YxcClientLike;
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
    this.zones = capabilities.zones.map(zone => zone.id);
    for (const zone of this.zones) {
      await this.refreshZone(zone);
    }
    this.mediaBlocks = capabilities.media;
    await this.refreshMedia();
    this.cancelPush = this.deps.registerPush(event => this.onPush(event));
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
  public handleStateChange(fullStateId: string, ack: boolean, value: unknown): void {
    if (ack) {
      return;
    }
    const prefix = `${this.deviceId}.`;
    if (!fullStateId.startsWith(prefix)) {
      return;
    }
    const command = stateToYxc(fullStateId.slice(prefix.length), value);
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
   * Fetch a zone's status and write its amp states with ack.
   *
   * @param zone the zone to refresh
   * @returns true if the status was fetched, false if the request failed
   */
  private async refreshZone(zone: string): Promise<boolean> {
    try {
      const status = await this.deps.client.getStatus(zone);
      for (const update of parseYxcStatus(status, zone)) {
        this.deps.setStateAck(`${this.deviceId}.${update.id}`, update.value);
      }
      return true;
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getStatus(${zone}) failed: ${errorMessage(e)}`);
      return false;
    }
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
