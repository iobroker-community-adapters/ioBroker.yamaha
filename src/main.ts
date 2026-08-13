import * as utils from "@iobroker/adapter-core";
import { createSocket } from "node:dgram";
import { get as httpGet } from "node:http";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { attemptDevice } from "./lib/attempt-device";
import { searchInterfaces } from "./lib/network-interfaces";
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
import { readDiscovered, writeDiscovered } from "./lib/discovered-store";
import { discoveredStoreDeps } from "./lib/discovered-store-deps";
import { YxcPushReceiver } from "./lib/yxc/push-receiver";
import { YamahaDeviceManagement } from "./device-management";
import type { DeviceRecord } from "./lib/types";
import { DeviceSupervisor, type ConnectionHandle } from "./lib/lifecycle/device-supervisor";
import { ReconnectStrategy } from "./lib/lifecycle/reconnect-strategy";

/** Supervisor reconnect backoff bounds (exponential: 1s, 2s … capped at 60s). */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;

/** Abort a discovery description fetch after this long, so a dead device cannot hang it. */
const FETCH_TIMEOUT_MS = 4000;

/** How often the discovery M-SEARCH is repeated — multicast is lossy, one dropped packet must not hide a receiver. */
const SSDP_SEARCH_BURST = 3;
/** Spacing between the repeated M-SEARCH sends, inside the collect window. */
const SSDP_SEARCH_INTERVAL_MS = 1000;

/** The three transports in attempt order — also the per-transport `info.transports.*` state ids. */
const TRANSPORT_IDS = ["ynca", "yxc", "xml"] as const;

/**
 * ioBroker.yamaha — controls Yamaha AV receivers and MusicCast devices.
 *
 * Each configured device is driven by a supervisor that keeps a multi-transport
 * handle online: every protocol the device answers — YNCA (amp control over a held
 * TCP connection, event-pushed), YXC (MusicCast, push + poll), XML/YNC (pre-2010,
 * polled over HTTP) — connects in parallel on one object tree, each datapoint owned
 * by the best-fitting transport. All YXC devices share one UDP push receiver, keyed
 * by source IP.
 */
export class Yamaha extends utils.Adapter {
  private readonly supervisors: DeviceSupervisor[] = [];
  private readonly deviceConnected = new Map<string, boolean>();
  private pushReceiver: YxcPushReceiver | undefined;
  /** Device-manager backend: the receivers as cards with add/edit/delete. */
  private readonly deviceManagement: YamahaDeviceManagement;

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
    this.deviceManagement = new YamahaDeviceManagement(this);
  }

  /** Start a supervisor for each configured device, then subscribe to state changes. */
  private async onReady(): Promise<void> {
    // Load admin translations for the device-manager cards — a UI concern, in its own
    // guarded block so an i18n failure never aborts core device startup below.
    try {
      await utils.I18n.init(join(this.adapterDir, "admin"), this);
    } catch (e) {
      this.log.warn(`could not load admin translations (${errorMessage(e)}); card labels may be untranslated`);
    }
    try {
      await this.setState("info.connection", { val: false, ack: true });
      await this.migrateLegacyDevice();
      // The device list is the switch: filled → use exactly those (manual); empty
      // → discover on the network and run what is found (auto). XML/pre-2010 devices
      // never answer SSDP, so they are always added manually.
      const configured = parseDevices(this.config.devices);
      const devices = configured.length > 0 ? configured : await this.autoDiscover();
      const knownDeviceIps = new Set(devices.map(device => device.ip));
      await this.cleanupStaleObjects(new Set(devices.map(device => device.id)));
      this.subscribeStates("*");
      const pushReceiver = new YxcPushReceiver({
        log: { debug: message => this.log.debug(message), warn: message => this.log.warn(message) },
        schedule: (cb, ms) => this.setTimeout(cb, ms),
        cancel: handle => this.clearTimeout(handle),
      });
      pushReceiver.start();
      this.pushReceiver = pushReceiver;
      // One supervisor per device: it keeps retrying until the device answers on at
      // least one transport and reconnects on a drop, so a device off at start joins on its own.
      for (const device of devices) {
        this.deviceConnected.set(device.id, false);
        await this.ensureDeviceHeader(device.id);
        const supervisor = new DeviceSupervisor({
          attempt: () => this.attemptDevice(device, pushReceiver, knownDeviceIps),
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
    // A drop clears the per-transport flags; a (re)connect sets them again via onTransports.
    if (!connected) {
      this.setTransports(deviceId, []);
    }
    const anyConnected = [...this.deviceConnected.values()].some(Boolean);
    void this.setState("info.connection", { val: anyConnected, ack: true });
  }

  /**
   * Reflect the live transport set into a device's `info.transports.*` flags so the
   * device-manager card shows which protocols (YNCA/YXC/XML) are connected right now.
   *
   * @param deviceId the id-safe device id
   * @param names the transports live now (empty on a drop)
   */
  private setTransports(deviceId: string, names: string[]): void {
    const live = new Set(names);
    for (const proto of TRANSPORT_IDS) {
      void this.setState(`${deviceId}.info.transports.${proto}`, { val: live.has(proto), ack: true });
    }
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
    // statusStates.onlineId lets the admin paint a green/red reachability symbol on the
    // device object itself (as govee does), fed by the per-device connection state.
    // extendObject with preserve:name so an upgrade adds the symbol without overwriting
    // a name the user changed.
    await this.extendObject(
      deviceId,
      {
        type: "device",
        common: { name: deviceId, statusStates: { onlineId: `${this.namespace}.${deviceId}.info.connection` } },
        native: {},
      },
      { preserve: { common: ["name"] } },
    );
    await this.setObjectNotExistsAsync(`${deviceId}.info`, { type: "channel", common: { name: "Info" }, native: {} });
    await this.setObjectNotExistsAsync(`${deviceId}.info.connection`, {
      type: "state",
      common: { name: "Connected", type: "boolean", role: "indicator.reachable", read: true, write: false, def: false },
      native: {},
    });
    // Model name shown on the device-manager card. Filled by whichever transport reports it
    // (YNCA MODELNAME, YXC/XML model); created here so the card's model line binds even for an
    // offline device or a transport that does not report a model.
    await this.setObjectNotExistsAsync(`${deviceId}.info.model`, {
      type: "state",
      common: { name: "Model", type: "string", role: "text", read: true, write: false, def: "" },
      native: {},
    });
    // Per-transport connection flags, fed by the live set from connectTransports and read live
    // by the device-manager card indicators. Created here so an offline device's card still
    // renders all three (false) instead of nothing.
    await this.setObjectNotExistsAsync(`${deviceId}.info.transports`, {
      type: "channel",
      common: { name: "Transports" },
      native: {},
    });
    for (const proto of TRANSPORT_IDS) {
      await this.setObjectNotExistsAsync(`${deviceId}.info.transports.${proto}`, {
        type: "state",
        common: {
          name: `${proto.toUpperCase()} connected`,
          type: "boolean",
          role: "indicator.reachable",
          read: true,
          write: false,
          def: false,
        },
        native: {},
      });
    }
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
   * Bring one device online across ALL its transports: every protocol that answers
   * — YNCA (amp control over a held TCP connection), YXC (MusicCast), XML/YNC
   * (pre-2010) — connects in parallel on one object tree. Returns a connection handle
   * the supervisor keeps, or null when no transport answers this attempt. Each
   * datapoint is owned by exactly one transport (owner-policy), so the mappers never
   * collide on a shared id.
   *
   * @param device the configured device record
   * @param pushReceiver the shared YXC push receiver
   * @param knownDeviceIps IPs of all configured devices, for resolving a multiroom client
   * @returns a connection handle, or null when no transport connected
   */
  private attemptDevice(
    device: DeviceRecord,
    pushReceiver: YxcPushReceiver,
    knownDeviceIps: Set<string>,
  ): Promise<ConnectionHandle | null> {
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
      onTransports: names => this.setTransports(device.id, names),
      knownDeviceIps,
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
    const store = discoveredStoreDeps(this);
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
        `add a device in the admin to switch to manual mode`,
    );
    return merged;
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
   * Run an SSDP M-SEARCH and collect the responders' description URL and address.
   *
   * With a configured network interface the search leaves exactly that one; left empty it
   * leaves EVERY non-internal IPv4 interface at once (one socket each), because multicast
   * egress otherwise follows only the host's default route — on a multi-homed host whose
   * default route is not the AV network that means the receiver is never reached and nothing
   * is found. Responders from all interfaces are merged into one list; the caller
   * de-duplicates by address.
   *
   * @param target the search target (device type)
   * @param timeoutMs how long to collect responses
   * @returns the responders
   */
  private ssdpSearch(target: string, timeoutMs: number): Promise<Array<{ location: string; address: string }>> {
    return new Promise(resolve => {
      const bindAddrs = searchInterfaces(this.config.networkInterface, networkInterfaces());
      const responders: Array<{ location: string; address: string }> = [];
      const sockets: ReturnType<typeof createSocket>[] = [];
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        for (const socket of sockets) {
          try {
            socket.close();
          } catch {
            // already closed
          }
        }
        resolve(responders);
      };
      // Open one search socket bound to a single interface (or the default route when bindAddr
      // is undefined). Every socket shares the responders list and the one settle timeout.
      const searchFrom = (bindAddr: string | undefined): void => {
        const socket = createSocket("udp4");
        sockets.push(socket);
        socket.on("message", (msg, rinfo) => {
          const location = /LOCATION:\s*(\S+)/i.exec(msg.toString());
          if (location) {
            responders.push({ location: location[1], address: rinfo.address });
          }
        });
        socket.on("error", err => {
          // One interface failing (typically a stale selected IP after a DHCP change) must not
          // kill the search on the others — warn and drop just this socket; the timeout still
          // resolves whatever the rest found.
          this.log.warn(
            `discovery socket failed${bindAddr ? ` on interface ${bindAddr}` : ""}: ${errorMessage(err)}${
              bindAddr ? " — check the Network Interface setting" : ""
            }`,
          );
          try {
            socket.close();
          } catch {
            // already closed
          }
        });
        const sendSearch = (): void => {
          if (settled) {
            return;
          }
          const msearch = `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 3\r\nST: ${target}\r\n\r\n`;
          try {
            socket.send(msearch, 1900, "239.255.255.250");
          } catch {
            // socket already closed by an error above
          }
        };
        socket.bind(0, bindAddr, () => {
          // Pin OUTGOING multicast to this interface. bind() only sets the source address; the
          // egress interface is IP_MULTICAST_IF — without it the OS uses its default route, so
          // the search can leave the wrong NIC on a multi-homed host (Node dgram docs).
          if (bindAddr) {
            try {
              socket.setMulticastInterface(bindAddr);
            } catch {
              this.log.info(`discovery: could not pin multicast egress to ${bindAddr} — using the default interface`);
            }
          }
          // Multicast is lossy and a single request can be dropped — repeat the M-SEARCH a few
          // times inside the collect window so one lost packet does not hide a receiver.
          for (let i = 0; i < SSDP_SEARCH_BURST; i++) {
            this.setTimeout(sendSearch, i * SSDP_SEARCH_INTERVAL_MS);
          }
        });
      };
      // Configured → that one interface; empty → every non-internal IPv4; none usable → default route.
      if (bindAddrs.length === 0) {
        searchFrom(undefined);
      } else {
        for (const bindAddr of bindAddrs) {
          searchFrom(bindAddr);
        }
      }
      this.setTimeout(finish, timeoutMs);
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
