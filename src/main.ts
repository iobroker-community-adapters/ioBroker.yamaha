import * as utils from "@iobroker/adapter-core";
import { createSocket } from "node:dgram";
import { get as httpGet } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { attemptDevice } from "./lib/attempt-device";
import {
  legacyDeviceRow,
  mergeDiscovered,
  parseDevices,
  renamedObjectIds,
  staleObjects,
  stripNamespace,
} from "./lib/pure-helpers";
import { errorMessage } from "./lib/util";
import { discoverYamaha } from "./lib/discovery";
import { readDiscovered, writeDiscovered, type DiscoveredStoreDeps } from "./lib/discovered-store";
import { YxcPushReceiver } from "./lib/yxc/push-receiver";
import type { DeviceRecord } from "./lib/types";
import { DeviceSupervisor, type ConnectionHandle } from "./lib/lifecycle/device-supervisor";
import { ReconnectStrategy } from "./lib/lifecycle/reconnect-strategy";

/** Supervisor reconnect backoff bounds (exponential: 1s, 2s … capped at 60s). */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;

/** Abort a discovery description fetch after this long, so a dead device cannot hang it. */
const FETCH_TIMEOUT_MS = 4000;

/**
 * ioBroker.yamaha — controls Yamaha AV receivers and MusicCast devices.
 *
 * Each configured device is driven by a supervisor that keeps one transport
 * controller online, tried in order: YNCA (amp control over a held TCP
 * connection, event-pushed), then YXC (MusicCast speakers and soundbars), then
 * XML/YNC (pre-2010 receivers, polled over HTTP). All YXC devices share one UDP
 * push receiver, keyed by source IP.
 */
export class Yamaha extends utils.Adapter {
  private readonly supervisors: DeviceSupervisor[] = [];
  private readonly deviceConnected = new Map<string, boolean>();
  private pushReceiver: YxcPushReceiver | undefined;
  /** Set once a device has connected over XML, so `native.hasXmlDevice` is written only once. */
  private xmlMarked = false;

  /**
   * @param options adapter options passed through by js-controller
   */
  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({
      ...options,
      name: "yamaha",
    });

    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }

  /** Start a supervisor for each configured device, then subscribe to state changes. */
  private async onReady(): Promise<void> {
    try {
      await this.setState("info.connection", { val: false, ack: true });
      await this.migrateLegacyDevice();
      // The device table is the switch: filled → use exactly those (manual); empty
      // → discover on the network and run what is found (auto). XML/pre-2010 devices
      // never answer SSDP, so they always go into the table manually.
      const configured = parseDevices(this.config.devices);
      const devices = configured.length > 0 ? configured : await this.autoDiscover();
      await this.cleanupStaleObjects(new Set(devices.map(device => device.id)));
      this.subscribeStates("*");
      const pushReceiver = new YxcPushReceiver({
        log: { debug: message => this.log.debug(message), warn: message => this.log.warn(message) },
        schedule: (cb, ms) => this.setTimeout(cb, ms),
        cancel: handle => this.clearTimeout(handle),
      });
      pushReceiver.start();
      this.pushReceiver = pushReceiver;
      // One supervisor per device: it keeps retrying until a transport connects and
      // reconnects on a drop, so a device that is off at start joins on its own.
      for (const device of devices) {
        this.deviceConnected.set(device.id, false);
        await this.ensureDeviceHeader(device.id);
        const supervisor = new DeviceSupervisor({
          attempt: () => this.attemptDevice(device, pushReceiver),
          schedule: (cb, ms) => this.setTimeout(cb, ms),
          cancel: handle => this.clearTimeout(handle as ioBroker.Timeout | undefined),
          onConnectionChange: connected => this.reportConnection(device.id, connected),
          backoff: new ReconnectStrategy(RECONNECT_BASE_MS, RECONNECT_MAX_MS),
          log: {
            debug: message => this.log.debug(message),
            info: message => this.log.info(message),
            warn: message => this.log.warn(message),
          },
        });
        this.supervisors.push(supervisor);
        supervisor.start();
      }
    } catch (e) {
      this.log.error(`onReady failed: ${errorMessage(e)}`);
    }
  }

  /**
   * Aggregate one device's connection state into the adapter's `info.connection`
   * (true while at least one device is connected).
   *
   * @param deviceId the device reporting
   * @param connected whether that device is currently connected
   */
  private reportConnection(deviceId: string, connected: boolean): void {
    this.deviceConnected.set(deviceId, connected);
    void this.setState(`${deviceId}.info.connection`, { val: connected, ack: true });
    const anyConnected = [...this.deviceConnected.values()].some(Boolean);
    void this.setState("info.connection", { val: anyConnected, ack: true });
  }

  /**
   * One-shot startup cleanup: delete every object that does not belong to a
   * configured device (the previous adapter's whole tree, and any device dropped
   * from the config). Runs before the devices connect; a configured device's
   * subtree is kept whether or not it has connected yet.
   *
   * @param deviceIds the ids of the currently configured devices
   */
  private async cleanupStaleObjects(deviceIds: Set<string>): Promise<void> {
    const existing = Object.keys(await this.getAdapterObjectsAsync());
    const stale = staleObjects(existing, deviceIds, this.namespace);
    // Old states this version renamed/moved (e.g. system.model -> info.model): delete the
    // old object so it does not linger orphaned beside the new one under a kept device.
    const renamed = renamedObjectIds(existing, deviceIds, this.namespace);
    for (const fullId of [...stale, ...renamed]) {
      try {
        await this.delObjectAsync(stripNamespace(fullId, this.namespace));
      } catch {
        // already removed together with its parent
      }
    }
    if (stale.length > 0) {
      this.log.info(`removed ${stale.length} object(s) from a previous configuration`);
    }
    if (renamed.length > 0) {
      this.log.info(`removed ${renamed.length} renamed object(s) from an earlier version`);
    }
  }

  /**
   * Create a device's header objects (the device node, its info channel and a
   * per-device connection indicator) so its state is visible even while offline.
   *
   * @param deviceId the id-safe device id
   */
  private async ensureDeviceHeader(deviceId: string): Promise<void> {
    await this.setObjectNotExistsAsync(deviceId, { type: "device", common: { name: deviceId }, native: {} });
    await this.setObjectNotExistsAsync(`${deviceId}.info`, { type: "channel", common: { name: "Info" }, native: {} });
    await this.setObjectNotExistsAsync(`${deviceId}.info.connection`, {
      type: "state",
      common: { name: "Connected", type: "boolean", role: "indicator.connected", read: true, write: false, def: false },
      native: {},
    });
  }

  /**
   * Carry over the previous adapter's single-device config into the device table.
   * The old yamaha stored one receiver as `config.ip` (older installs: `config.IP`);
   * the new adapter uses a `devices` table, so an upgraded instance would otherwise
   * start with an empty table and lose its receiver. Persists the row so the admin
   * table shows it, and fills `this.config` in memory so this run already drives it.
   */
  private async migrateLegacyDevice(): Promise<void> {
    const config = this.config as unknown as Record<string, unknown>;
    const row = legacyDeviceRow(config);
    if (!row) {
      return;
    }
    // Fill the in-memory config first, so this run already drives the device even
    // if persisting the table below fails — persistence is a convenience for the
    // admin view, not a precondition for running.
    config.devices = [row];
    try {
      await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, { native: { devices: [row] } });
      this.log.info(`carried the previous single-device config (${row.ip}) over into the device table`);
    } catch (e) {
      this.log.warn(
        `could not persist the migrated device table (${errorMessage(e)}); ` + `running with the in-memory value`,
      );
    }
  }

  /**
   * Bring one device online across its transports, tried in order: YNCA (amp
   * control over a held TCP connection), then YXC (MusicCast), then XML/YNC
   * (pre-2010). Returns a connection handle the supervisor keeps, or null when no
   * transport answers this attempt. The transport that connects owns the device's
   * object tree, so the mappers never collide on a shared id.
   *
   * @param device the configured device record
   * @param pushReceiver the shared YXC push receiver
   * @returns a connection handle, or null when no transport connected
   */
  private attemptDevice(device: DeviceRecord, pushReceiver: YxcPushReceiver): Promise<ConnectionHandle | null> {
    return attemptDevice(device, {
      log: {
        debug: message => this.log.debug(message),
        info: message => this.log.info(message),
        warn: message => this.log.warn(message),
      },
      upsertObject: async (id, def) => {
        await this.extendObject(id, { type: def.type, common: def.common, native: {} });
      },
      setStateAck: (id, value) => void this.setState(id, { val: value, ack: true }),
      timers: {
        schedule: (handler, ms) => this.setTimeout(handler, ms),
        cancel: handle => this.clearTimeout(handle),
      },
      registerPush: (ip, onPush) => pushReceiver.register(ip, onPush),
      scheduleKeepalive: (handler, ms) => {
        const timer = this.setInterval(handler, ms);
        return () => {
          if (timer) {
            this.clearInterval(timer);
          }
        };
      },
      xmlPollIntervalMs: this.xmlPollIntervalMs(),
      onXmlConnected: () => void this.markXmlDevice(),
    });
  }

  /**
   * Route a state change to every device's supervisor (each forwards to its
   * active controller, which ignores ids outside its subtree and its acked echoes).
   *
   * @param id the full state id
   * @param state the new state (null when deleted)
   */
  private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
    if (!state) {
      return;
    }
    const relative = stripNamespace(id, this.namespace);
    for (const supervisor of this.supervisors) {
      supervisor.handleStateChange(relative, state.ack, state.val);
    }
  }

  /**
   * Synchronous teardown — no await, call the callback immediately (SIGKILL otherwise).
   *
   * @param callback function to invoke once teardown is complete
   */
  private onUnload(callback: () => void): void {
    try {
      this.pushReceiver?.close();
      for (const supervisor of this.supervisors) {
        supervisor.close();
      }
      void this.setState("info.connection", { val: false, ack: true });
      callback();
    } catch {
      callback();
    }
  }

  /**
   * Auto-discovery for an empty device table: scan the network, merge the finds with
   * the devices remembered from earlier runs (standby protection), persist the merged
   * set and return it. XML/pre-2010 receivers do not answer SSDP and never appear here.
   *
   * @returns the device records to run this session
   */
  private async autoDiscover(): Promise<DeviceRecord[]> {
    const store = this.discoveredStoreDeps();
    const known = await readDiscovered(store);
    let found: Array<{ ip: string; name: string }> = [];
    try {
      found = await discoverYamaha({
        search: (target, ms) => this.ssdpSearch(target, ms),
        fetch: url => this.fetchUrl(url),
        log: { debug: message => this.log.debug(message), warn: message => this.log.warn(message) },
      });
    } catch (e) {
      this.log.warn(`auto-discovery scan failed, using the remembered devices: ${errorMessage(e)}`);
    }
    const merged = mergeDiscovered(known, found);
    await writeDiscovered(store, merged);
    this.log.info(
      `auto-discovery: ${found.length} found, running ${merged.length} device(s); ` +
        `add devices to the table to switch to manual mode`,
    );
    return merged;
  }

  /**
   * File access for the discovered-devices store — a JSON file in the instance data
   * directory (no `native` write, so no restart). A missing file reads as absent.
   *
   * @returns the store's read/write/log dependencies
   */
  private discoveredStoreDeps(): DiscoveredStoreDeps {
    const path = join(utils.getAbsoluteInstanceDataDir(this), "discovered.json");
    return {
      read: async () => {
        try {
          return await readFile(path, "utf8");
        } catch {
          return undefined;
        }
      },
      write: async content => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content, "utf8");
      },
      log: { debug: message => this.log.debug(message) },
    };
  }

  /**
   * The XML/YNC poll interval in milliseconds, from `config.xmlPollInterval`
   * (seconds, default 60).
   *
   * @returns the interval in ms
   */
  private xmlPollIntervalMs(): number {
    const seconds = Number((this.config as unknown as Record<string, unknown>).xmlPollInterval);
    return (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000;
  }

  /**
   * Remember, once, that a device connected over the XML transport, so the admin can
   * reveal the XML poll-interval field (`hidden: "!data.hasXmlDevice"`). Writing to
   * `native` restarts the instance a single time — the same one-off as the legacy
   * migration; guarded so it never loops.
   */
  private markXmlDevice(): void {
    if (this.xmlMarked || (this.config as unknown as Record<string, unknown>).hasXmlDevice === true) {
      this.xmlMarked = true;
      return;
    }
    this.xmlMarked = true;
    void this.extendForeignObject(`system.adapter.${this.namespace}`, { native: { hasXmlDevice: true } }).catch(e =>
      this.log.warn(`could not persist hasXmlDevice: ${errorMessage(e)}`),
    );
  }

  /**
   * Run an SSDP M-SEARCH and collect the responders' description URL and address.
   *
   * @param target the search target (device type)
   * @param timeoutMs how long to collect responses
   * @returns the responders
   */
  private ssdpSearch(target: string, timeoutMs: number): Promise<Array<{ location: string; address: string }>> {
    return new Promise(resolve => {
      const socket = createSocket("udp4");
      const responders: Array<{ location: string; address: string }> = [];
      socket.on("message", (msg, rinfo) => {
        const location = /LOCATION:\s*(\S+)/i.exec(msg.toString());
        if (location) {
          responders.push({ location: location[1], address: rinfo.address });
        }
      });
      socket.on("error", () => socket.close());
      socket.bind(() => {
        const msearch = `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 3\r\nST: ${target}\r\n\r\n`;
        socket.send(msearch, 1900, "239.255.255.250");
      });
      this.setTimeout(() => {
        socket.close();
        resolve(responders);
      }, timeoutMs);
    });
  }

  /**
   * Fetch a URL over HTTP and resolve its body.
   *
   * @param url the URL to fetch
   * @returns the response body
   */
  private fetchUrl(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = httpGet(url, res => {
        let data = "";
        res.on("data", chunk => (data += String(chunk)));
        res.on("end", () => resolve(data));
      });
      req.on("error", reject);
      req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error(`fetch timed out: ${url}`)));
    });
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Yamaha(options);
} else {
  // Start the instance directly
  (() => new Yamaha())();
}
