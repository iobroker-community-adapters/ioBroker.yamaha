import { parseYxcFeatures } from "./capability";
import { mapYxcToObjects } from "./object-mapper";
import { parseYxcStatus, stateToYxc, type YxcCommand } from "./command-mapper";
import { zonesToRefresh } from "./push";
import type { ObjectDef } from "../catalog/types";

/** Renew interval for the push registration + state poll, well under the ~20 min expiry. */
const KEEPALIVE_MS = 5 * 60 * 1000;

/** The subset of the YamahaYXC client the controller uses (so tests can inject a fake). */
export interface YxcClientLike {
  /** Read the device's capabilities (zones, functions, inputs, ranges). */
  getFeatures(): Promise<unknown>;
  /** Read a zone's current status. */
  getStatus(zone: string): Promise<unknown>;
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
}

/** Log surface the controller needs. */
export interface YxcControllerLog {
  /** Routine detail. */
  debug(message: string): void;
  /** Relevant events. */
  info(message: string): void;
  /** Warnings. */
  warn(message: string): void;
}

/** The adapter callbacks the controller drives — narrow, so no adapter mock is needed in tests. */
export interface YxcControllerDeps {
  /** The YXC (MusicCast) client for this device. */
  client: YxcClientLike;
  /** Register a handler for pushes from this device (wired to the shared receiver by IP). */
  registerPush(onPush: (event: unknown) => void): void;
  /** Schedule the keepalive handler; returns a function that cancels it. */
  scheduleKeepalive(handler: () => void, ms: number): () => void;
  /** Create or update an object in the device tree. */
  upsertObject(id: string, def: ObjectDef): Promise<void>;
  /** Write a state value with ack (device-originated). */
  setStateAck(id: string, value: boolean | number | string): void;
  /** Adapter log. */
  log: YxcControllerLog;
}

/**
 * Drives one MusicCast (YXC) device: read capabilities, build the object tree,
 * seed state from getStatus, and route commands both ways. Device pushes arrive
 * via the shared receiver as re-fetch signals; a keepalive poll renews the push
 * registration (the fix for the musiccast "stops updating" bug) and doubles as
 * the poll-only fallback when the push port is unavailable. Create-only.
 */
export class YxcDeviceController {
  private zones: string[] = [];
  private cancelKeepalive: (() => void) | undefined;

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
    this.deps.registerPush(event => this.onPush(event));
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

  /** Cancel the keepalive. Synchronous — safe to call from onUnload. */
  public close(): void {
    this.cancelKeepalive?.();
    this.cancelKeepalive = undefined;
  }

  /**
   * Handle a device push: each named zone is re-fetched via getStatus (the push
   * itself is a change signal, not a value carrier).
   *
   * @param event the parsed push event
   */
  private onPush(event: unknown): void {
    for (const zone of zonesToRefresh(event)) {
      if (this.zones.includes(zone)) {
        void this.refreshZone(zone);
      }
    }
  }

  /** Poll the primary zone, which renews the push registration and refreshes state. */
  private async keepalive(): Promise<void> {
    await this.refreshZone(this.zones[0] ?? "main");
  }

  /**
   * Fetch a zone's status and write its amp states with ack.
   *
   * @param zone the zone to refresh
   */
  private async refreshZone(zone: string): Promise<void> {
    try {
      const status = await this.deps.client.getStatus(zone);
      for (const update of parseYxcStatus(status, zone)) {
        this.deps.setStateAck(`${this.deviceId}.${update.id}`, update.value);
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: getStatus(${zone}) failed: ${e instanceof Error ? e.message : String(e)}`);
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
      }
    } catch (e) {
      this.deps.log.warn(`${this.deviceId}: ${command.method} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
