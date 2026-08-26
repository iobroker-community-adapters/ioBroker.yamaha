import * as utils from "@iobroker/adapter-core";
import { createSocket } from "node:dgram";
import { get as httpGet } from "node:http";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { attemptDevice } from "./lib/attempt-device";
import { searchInterfaces } from "./lib/network-interfaces";
import { isGroupEnabled } from "./lib/catalog/groups";
import { iconForModel } from "./lib/device-type";
import {
  LABEL_RANK,
  type LabelRank,
  legacyDeviceRow,
  mergeDiscovered,
  nextDeviceLabel,
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
import { ReachabilityDedup } from "./lib/lifecycle/reachability-dedup";
import { createSubunitCache, isAvailSnapshot, type YncaSubunitCache } from "./lib/ynca/subunit-cache";
import { ProbeMemory } from "./lib/lifecycle/probe-memory";

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
  /** deviceId → its supervisor, so a state change goes to ONE device, not to all of them. */
  private readonly supervisorById = new Map<string, DeviceSupervisor>();
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
      this.log.info('starting — a "ready" message will follow for each device');
      await this.setState("info.connection", { val: false, ack: true });
      await this.migrateLegacyDevice();
      await this.migrateGroupZones();
      // The device list is the switch: filled → use exactly those (manual); empty
      // → discover on the network and run what is found (auto). XML/pre-2010 devices
      // never answer SSDP, so they are always added manually.
      const configured = parseDevices(this.config.devices, (dropped, takenId) =>
        this.log.warn(`device "${dropped}" skipped — its object id "${takenId}" is already used by another device`),
      );
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
      if (configured.length > 0) {
        this.log.info(`setting up ${devices.length} configured device(s)...`);
      }
      for (const device of devices) {
        this.deviceConnected.set(device.id, false);
        await this.ensureDeviceHeader(device.id);
        const reachability = new ReachabilityDedup();
        const subunitCache = await this.loadYncaSubunitCache(device.id);
        // Held here, not in the controllers: those are rebuilt on every connection attempt.
        const probeMemory = new ProbeMemory();
        const supervisor = new DeviceSupervisor({
          attempt: () =>
            this.attemptDevice(device, pushReceiver, knownDeviceIps, reachability, subunitCache, probeMemory),
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
        this.supervisorById.set(device.id, supervisor);
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
    // Objects whose datapoint group the user switched off — remove them so turning a group from
    // on to off cleans up its whole subtree (a toggle change restarts the instance, so this runs).
    const config = this.config as unknown as Record<string, unknown>;
    const disabled = existing.filter(full => {
      for (const deviceId of deviceIds) {
        const base = `${this.namespace}.${deviceId}.`;
        if (full.startsWith(base) && !isGroupEnabled(full.slice(base.length), config)) {
          return true;
        }
      }
      return false;
    });
    for (const fullId of [...stale, ...renamed, ...disabled]) {
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
    if (disabled.length > 0) {
      this.log.info(`removed ${disabled.length} object(s) from switched-off datapoint groups`);
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
    // A device that has not reported its model yet would sit in the tree without any
    // symbol — an upgraded instance shows that on every start before the first report,
    // and a device that never answers shows it for good. Seed the default silhouette,
    // but only when there is none: overwriting would flip a soundbar back to the
    // receiver default for the seconds until its model arrives.
    let icon: string | undefined;
    try {
      const existing = await this.getObjectAsync(deviceId);
      icon = existing?.common?.icon ? undefined : iconForModel(undefined);
    } catch {
      icon = undefined;
    }
    await this.extendObject(
      deviceId,
      {
        type: "device",
        common: {
          name: deviceId,
          ...(icon ? { icon } : {}),
          statusStates: { onlineId: `${this.namespace}.${deviceId}.info.connection` },
        },
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

  /** The icon last written per device, so repeated model reports do not re-write the object. */
  private readonly deviceIcons = new Map<string, string>();

  /** The label this adapter wrote per device, with the rank of the source behind it. */
  private readonly deviceLabels = new Map<string, { name: string; rank: LabelRank }>();

  /**
   * Give the device node a name a user recognises, once the device reports one.
   *
   * An instance upgraded from the previous adapter carries the receiver's ip as its
   * device name — that adapter knew nothing but an ip, so the migration had nothing
   * else to call it. The object id stays that ip for good (history and visualisation
   * bindings hang off it), but the displayed name does not have to.
   *
   * A name the user typed is never touched, and the model never replaces a name the
   * device reported for itself — see {@link nextDeviceLabel}.
   *
   * @param deviceId the id-safe device id
   * @param candidate the reported name (a MusicCast zone name, or the model)
   * @param rank how trustworthy the candidate is
   */
  private async updateDeviceLabel(deviceId: string, candidate: string, rank: LabelRank): Promise<void> {
    const own = this.deviceLabels.get(deviceId);
    try {
      const current = (await this.getObjectAsync(deviceId))?.common?.name;
      const label = nextDeviceLabel(
        typeof current === "string" ? current : undefined,
        deviceId,
        candidate,
        rank,
        own?.name,
        own?.rank,
      );
      if (label === undefined) {
        return;
      }
      // Deliberately without `preserve: { common: ["name"] }`: nextDeviceLabel has just
      // established that the present name is the adapter's own placeholder, not a user's.
      await this.extendObject(deviceId, { common: { name: label } });
      this.deviceLabels.set(deviceId, { name: label, rank });
      this.log.debug(`${deviceId}: device name set to "${label}"`);
    } catch (e) {
      this.log.debug(`${deviceId}: setting the device name failed (${errorMessage(e)})`);
    }
  }

  /**
   * Paint the device-class silhouette on the device node once the model is known —
   * detected from the reported model name, written only when it actually changes.
   *
   * @param deviceId the id-safe device id
   * @param model the reported model name
   */
  private async updateDeviceIcon(deviceId: string, model: string): Promise<void> {
    const icon = iconForModel(model);
    if (this.deviceIcons.get(deviceId) === icon) {
      return;
    }
    this.deviceIcons.set(deviceId, icon);
    try {
      await this.extendObject(deviceId, { common: { icon } });
    } catch (e) {
      this.log.debug(`${deviceId}: setting device icon failed (${errorMessage(e)})`);
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
   * Fold the removed `group_zones` toggle into `group_multiroom` — zone 2/3/4 now
   * belong to the multiroom group. Existing installs that had zones on but multiroom
   * off would otherwise lose their zone datapoints after the update.
   */
  private async migrateGroupZones(): Promise<void> {
    const config = this.config as unknown as Record<string, unknown>;
    if (!("group_zones" in config)) {
      return;
    }
    // (`!group_multiroom` only reads as a guard — the assignment sets it to true
    // either way, so an already-on multiroom group is not changed by it.)
    if (config.group_zones && !config.group_multiroom) {
      config.group_multiroom = true;
    }
    delete config.group_zones;
    try {
      const obj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
      if (obj?.native) {
        if (obj.native.group_zones && !obj.native.group_multiroom) {
          obj.native.group_multiroom = true;
        }
        delete obj.native.group_zones;
        await this.setForeignObjectAsync(`system.adapter.${this.namespace}`, obj);
        this.log.info("migrated group_zones setting into group_multiroom");
      }
    } catch (e) {
      this.log.warn(`could not persist group_zones migration (${errorMessage(e)})`);
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
   * @param reachability dedup for the "no reachable transport" warning (one instance per device,
   *   held by the caller across retries — see {@link ReachabilityDedup})
   * @param yncaSubunitCache per-device cache of the YNCA AVAIL probe (skips the probe on reconnects)
   * @param probeMemory per-device memory for constant device answers (skips re-asking on reconnects)
   * @returns a connection handle, or null when no transport connected
   */
  private attemptDevice(
    device: DeviceRecord,
    pushReceiver: YxcPushReceiver,
    knownDeviceIps: Set<string>,
    reachability: ReachabilityDedup,
    yncaSubunitCache: YncaSubunitCache,
    probeMemory: ProbeMemory,
  ): Promise<ConnectionHandle | null> {
    return attemptDevice(device, {
      reachability,
      yncaSubunitCache,
      probeMemory,
      // Group gate for the YNCA sweep: a disabled group's functions are never even fetched.
      isEntryEnabled: id => isGroupEnabled(id, this.config as unknown as Record<string, unknown>),
      log: {
        debug: message => this.log.debug(message),
        info: message => this.log.info(message),
        warn: message => this.log.warn(message),
      },
      upsertObject: async (id, def) => {
        // Gate on the datapoint group: a switched-off group's objects are not created. The id is
        // "<deviceId>.<relativeId>"; groupOf reads the relative part.
        if (!isGroupEnabled(id.slice(id.indexOf(".") + 1), this.config as unknown as Record<string, unknown>)) {
          return;
        }
        await this.extendObject(id, { type: def.type, common: def.common, native: {} });
      },
      setStateAck: (id, value) => {
        // Same group gate as upsertObject, so a switched-off group seeds no orphan value either.
        if (!isGroupEnabled(id.slice(id.indexOf(".") + 1), this.config as unknown as Record<string, unknown>)) {
          return;
        }
        void this.setState(id, { val: value, ack: true });
        // A model report also decides the device-class icon on the device node — and, for a
        // device still carrying the ip it was migrated with, its readable name.
        if (id.endsWith(".info.model") && typeof value === "string" && value.length > 0) {
          const reporting = id.slice(0, id.indexOf("."));
          void this.updateDeviceIcon(reporting, value);
          void this.updateDeviceLabel(reporting, value, LABEL_RANK.model);
        }
      },
      onDeviceName: name => void this.updateDeviceLabel(device.id, name, LABEL_RANK.deviceName),
      timers: {
        schedule: (handler, ms) => this.setTimeout(handler, ms),
        cancel: handle => this.clearTimeout(handle),
      },
      registerPush: (ip, onPush) => pushReceiver.register(ip, onPush),
      pushActive: () => pushReceiver.isListening(),
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
    // The adapter subscribes to its whole namespace, so every one of its own acked writes
    // comes back here too — during a sweep that is hundreds of events. Route by the id's
    // first segment instead of offering each one to every device in turn.
    const deviceId = relative.slice(0, relative.indexOf("."));
    this.supervisorById.get(deviceId)?.handleStateChange(relative, state.ack, state.val);
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
    this.log.info("auto-discovery via SSDP (older XML-only devices must be added manually)");
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
    const merged = mergeDiscovered(known, found, (dropped, takenId) =>
      this.log.warn(`discovered device "${dropped}" skipped — its object id "${takenId}" is already taken`),
    );
    await writeDiscovered(store, merged);
    const remembered = merged.length - found.length;
    const suffix = remembered > 0 ? ` (${remembered} more remembered from a previous run)` : "";
    this.log.info(`setting up ${merged.length} discovered device(s)${suffix}...`);
    return merged;
  }

  /**
   * Load a device's persisted YNCA subunit-cache (the AVAIL probe result) from its
   * device object's native part, wrapped so updates persist back there. The device
   * object is the right home: writing an instance object's native restarts the
   * adapter, a device object's does not.
   *
   * @param deviceId the id-safe device id
   * @returns the per-device cache
   */
  private async loadYncaSubunitCache(deviceId: string): Promise<YncaSubunitCache> {
    let stored: unknown;
    try {
      stored = (await this.getObjectAsync(deviceId))?.native?.yncaAvail;
    } catch {
      stored = undefined;
    }
    return createSubunitCache(isAvailSnapshot(stored) ? stored : undefined, snapshot => {
      void this.extendObject(deviceId, { native: { yncaAvail: snapshot ?? null } });
    });
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
        // A connection dropped mid-body emits on the RESPONSE stream, not the request —
        // without this handler that is an unhandled error event instead of a rejection.
        res.on("error", reject);
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
