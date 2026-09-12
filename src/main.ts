import * as utils from "@iobroker/adapter-core";
import { createSocket } from "node:dgram";
import { get as httpGet } from "node:http";
import { networkInterfaces } from "node:os";
import { attemptDevice } from "./lib/attempt-device";
import { searchInterfaces } from "./lib/network-interfaces";
import { isGroupEnabled } from "./lib/catalog/groups";
import type { ObjectDef } from "./lib/catalog/types";
import {
  asPercentObject,
  fromPercent,
  isAmpVolumeId,
  toPercent,
  volumeBoundsOf,
  type VolumeBounds,
} from "./lib/catalog/volume-percent";
import { iconForModel } from "./lib/device-type";
import {
  BOUND_FIELDS,
  type BoundFields,
  boundsOfCommon,
  childlessChannelIds,
  LABEL_RANK,
  type LabelRank,
  legacyDeviceRow,
  mergeDiscovered,
  neverWrittenStateIds,
  nextDeviceLabel,
  parseDevices,
  unionDevices,
  renamedObjectIds,
  staleObjects,
  stripNamespace,
} from "./lib/pure-helpers";
import { errorMessage, MAX_HTTP_BODY_BYTES } from "./lib/util";
import { tName } from "./lib/i18n";
import { discoverYamaha } from "./lib/discovery";
import { readDiscovered, readIgnored, writeDiscovered } from "./lib/discovered-store";
import { discoveredStoreDeps, ignoredStoreDeps } from "./lib/discovered-store-deps";
import { YxcPushReceiver } from "./lib/yxc/push-receiver";
import { YamahaDeviceManagement } from "./device-management";
import type { DeviceSource, DeviceRecord } from "./lib/types";
import { DeviceSupervisor, type ConnectionHandle } from "./lib/lifecycle/device-supervisor";
import { ReconnectStrategy } from "./lib/lifecycle/reconnect-strategy";
import { ReachabilityDedup } from "./lib/lifecycle/reachability-dedup";
import type { YncaSubunitCache } from "./lib/ynca/subunit-cache";
import type { ProbeMemory } from "./lib/lifecycle/probe-memory";
import { DeviceProfileStore } from "./lib/lifecycle/capability-profile";

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
 * How long the datapoint balance waits for quiet before it logs. Devices connect
 * asynchronously and in parallel, so the line has to outlast the slowest of them.
 */
const DATAPOINT_BALANCE_SETTLE_MS = 5000;

/**
 * Shortest gap between two network searches triggered by an offline auto-found device. A
 * receiver that moved to another address answers nowhere else, so the search is the only way
 * back to it — but a device that is simply switched off must not turn that into a scan loop.
 */
const REDISCOVER_MIN_INTERVAL_MS = 300000;

/**
 * How long a device object's native writes are collected before ONE extendObject carries them
 * (the probe memory persists on every change — dozens within a first connect's first second).
 */
const NATIVE_PERSIST_WINDOW_MS = 250;

/**
 * A map or set keyed by namespace-relative state ids — the shape {@link YamahaAdapter.forgetUnder}
 * prunes when a device goes. Structural on purpose: `Map<string, T>` and `Set<string>` both fit.
 */
interface StateKeyedCache {
  keys(): IterableIterator<string>;
  delete(key: string): boolean;
}

/** A device's native patch waiting for its coalescing window to end. */
interface PendingNative {
  /** The merged patch (latest value per key wins). */
  native: Record<string, unknown>;
  /** The window timer; undefined when the adapter refused one (shutdown) and the write ran at once. */
  timer?: ioBroker.Timeout;
}

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
  /**
   * What each volume datapoint declares on the DEVICE'S OWN scale, while percent mode replaces
   * that declaration with 0…100 %. Filled by `upsertObject` — the object is always written before
   * any value for it — and read by both value directions, so the conversion has exactly one
   * source. Keyed by the full state id, so zones and devices never mix.
   */
  private readonly volumeScales = new Map<string, VolumeBounds>();

  private readonly supervisorById = new Map<string, DeviceSupervisor>();
  private readonly deviceConnected = new Map<string, boolean>();
  /** deviceId → the record it is currently running with, so an address change is visible. */
  private readonly deviceRecords = new Map<string, DeviceRecord>();
  /** The addresses of all supervised devices — a multiroom group resolves its clients through it. */
  private readonly knownDeviceIps = new Set<string>();
  /** Whether the network search runs in this instance — see {@link searchesTheNetwork}. */
  private discovering = false;
  /** Armed while an auto-found device is offline: the search that can bring it back. */
  private rediscoverTimer: ioBroker.Timeout | undefined;
  /** When the last background search ran, so the retry cannot become a scan loop. */
  private lastRediscovery = 0;
  private pushReceiver: YxcPushReceiver | undefined;
  /**
   * Set the moment teardown begins: a connect attempt still in flight then resolves into
   * a closing adapter and must not arm keepalives/timers any more — the framework would
   * refuse them anyway, but with a warn line per attempt ("setInterval called, but
   * adapter is shutting down", seen live on the 1.7.0 upgrade restart).
   */
  private unloading = false;
  /** Device-manager backend: the receivers as cards with add/edit/delete. */
  private readonly deviceManagement: YamahaDeviceManagement;
  /**
   * Every datapoint that existed when this run started, filled ONCE before the cleanup and
   * before any device connects. Without it the balance below would report the whole tree as
   * new on every restart: `upsertObject` runs `extendObject` on every state it touches (the
   * role/unit retrofit), so "did the create path run?" is not the same question as "is this
   * datapoint new?".
   */
  private readonly knownDatapoints = new Set<string>();
  /**
   * The `common.states` map every existing datapoint carried when this run started, then the
   * map last written by this run — what a clearing write has to be judged against (#619).
   * Filled from the same start-up read as {@link knownDatapoints}; no per-state database read.
   */
  private readonly storedStates = new Map<string, Record<string, string>>();
  /**
   * The numeric bounds every existing datapoint carried when this run started, then the ones
   * last written by this run — judged the same way {@link storedStates} is, from the one
   * start-up read, never a database read per state.
   *
   * A bound the new definition DROPS has to be cleared explicitly: `extendObject` merges, so an
   * old `min`/`max` outlives the definition that put it there forever. Measured on
   * `tuner.frequency`, whose FM-only envelope had to go once a DAB receiver reported 180064 kHz
   * into it — without a clearing write exactly the installations with the problem would keep it.
   */
  private readonly storedBounds = new Map<string, BoundFields>();
  /** State ids (namespace-relative) some transport upserted in THIS run — live claims. */
  private readonly touchedThisRun = new Set<string>();
  /** Devices that reported connected at least once in this run (gates the orphan purge). */
  private readonly readyDevices = new Set<string>();
  private createdDatapoints = 0;
  private removedDatapoints = 0;
  /** Debounce for the balance line, so one config change produces ONE line, not one per device. */
  private balanceTimer: ioBroker.Timeout | undefined;
  /** Set when the start-up snapshot failed — a balance without it would be wrong, so none is written. */
  private balanceDisabled = false;
  /**
   * True while the settle pass runs. Its own purges report their removals, which used to
   * re-arm the timer and run the whole pass a second time five seconds later — two more full
   * reads of the object tree for a round that could only ever remove nothing (audit 2026-09-06).
   */
  private balanceSettling = false;
  /**
   * Latched after the first failed database write, so an outage warns once and the
   * repeats stay at debug until a write goes through again (nut2 `failedUps` pattern).
   */
  private stateWritesFailing = false;
  /** Per device, its capability profile (probe memory, YNCA snapshot, purge marker) — see loadDeviceProfile. */
  private readonly profiles = new Map<string, DeviceProfileStore>();
  /** Per device, the native patch inside its coalescing window (see persistDeviceNative). */
  private readonly pendingNative = new Map<string, PendingNative>();

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
    try {
      this.log.info('starting — a "ready" message will follow for each device');
      await this.setState("info.connection", { val: false, ack: true });
      await this.migrateLegacyDevice();
      await this.migrateGroupZones();
      // The running set is the UNION of the device table and the discovery store, and whether
      // the network search runs at all is its own setting. Until 2.9.0 the table WAS the switch
      // — filled meant manual, empty meant auto — so the two could never be combined, and
      // turning a single discovered device into a manual one dropped every other one from the
      // run (their trees went with them). XML/pre-2010 devices never answer SSDP, so they are
      // always added by hand; that is exactly the case the mixed mode exists for.
      const configured = parseDevices(this.config.devices, (dropped, takenId) =>
        this.log.warn(`device "${dropped}" skipped — its object id "${takenId}" is already used by another device`),
      );
      this.discovering = this.searchesTheNetwork(configured.length);
      const devices = unionDevices(configured, this.discovering ? await this.autoDiscover() : []);
      if (this.unloading) {
        // Stopped during the initial network search: it resolves on its own clock, and
        // everything below — push socket, subscriptions, device sockets and timers —
        // would come up on an instance that is already gone, with nothing left to close it.
        return;
      }
      // The start-up search (blocking first setup, or the background one below) is the first
      // search of this run — an offline device must not fire another one right behind it.
      this.lastRediscovery = Date.now();
      for (const device of devices) {
        this.knownDeviceIps.add(device.ip);
      }
      // Before the cleanup and before any device connects — see knownDatapoints.
      await this.snapshotExistingDatapoints();
      await this.cleanupStaleObjects(new Set(devices.map(device => device.id)));
      await this.ensureInstanceInfoObjects();
      await this.subscribeToStates();
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
        // Per device, so one failure does not cost the rest of the run: startDevice writes
        // header objects and the disconnected stamp, and a states/objects hiccup on device
        // two used to abort onReady — devices three and four never came up, the overview was
        // never written and the background search never ran (audit 2026-09-06).
        try {
          await this.startDevice(device, pushReceiver);
        } catch (e) {
          this.log.error(`${device.id}: could not be set up (${errorMessage(e)}) — the other devices continue`);
        }
      }
      this.writeDeviceOverview();
      // Auto mode with remembered devices: they started WITHOUT waiting for the network
      // search — it runs behind them, adds newcomers and moves a device that changed address.
      if (this.discovering && devices.length > 0) {
        void this.discoverAdditionalDevices(pushReceiver);
      }
    } catch (e) {
      this.log.error(`onReady failed: ${errorMessage(e)}`);
    }
  }

  /**
   * Bring one device under supervision: header objects, disconnected stamp, the
   * per-device caches, and the supervisor that keeps it connected. Factored out of
   * onReady so the background discovery can start a late-found device the same way.
   *
   * @param device the device record
   * @param pushReceiver the shared YXC push receiver
   */
  private async startDevice(device: DeviceRecord, pushReceiver: YxcPushReceiver): Promise<void> {
    // Both callers check `unloading` after their network search resolves (onReady and
    // discoverAdditionalDevices) — a device handed over after onUnload never gets here.
    this.deviceConnected.set(device.id, false);
    this.deviceRecords.set(device.id, { ...device });
    this.knownDeviceIps.add(device.ip);
    await this.ensureDeviceHeader(device.id, device.ip, device.source ?? "discovered");
    // Stamp it disconnected BEFORE the first attempt: ioBroker keeps a state's last value
    // forever, so a crash or a power cut would otherwise leave the device green until it
    // reports again — and a device that never answers would stay green for good.
    await this.setState(`${device.id}.info.connection`, { val: false, ack: true });
    // The three protocol flags follow the same rule: left at their last value, a crash
    // would show "YNCA connected" on the card next to a red connection dot — for good, if
    // the device never answers again.
    this.setTransports(device.id, []);
    const reachability = new ReachabilityDedup();
    // Held here, not in the controllers: those are rebuilt on every connection attempt;
    // persisted at the device object (one capability profile), so a restart starts from the
    // remembered answers.
    const profile = await this.loadDeviceProfile(device.id);
    const subunitCache = profile.subunitCache;
    const probeMemory = profile.probeMemory;
    const supervisor = new DeviceSupervisor({
      attempt: () =>
        this.attemptDevice(device, pushReceiver, this.knownDeviceIps, reachability, subunitCache, probeMemory),
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

  /**
   * The background half of auto-discovery: search the network, bring devices online that are
   * not supervised yet, and move a device that answers at a NEW address. The remembered devices
   * did not wait for this — the search window (seconds) used to gate every restart although the
   * devices were already known.
   *
   * The address half matters because the object id — and with it the whole tree, its history and
   * every visualisation binding — is fixed to the device, not to where it sits. A receiver that
   * moved by DHCP is the same device at a new address, so its supervisor is rebuilt there instead
   * of retrying an address nobody answers at any more.
   *
   * @param pushReceiver the shared YXC push receiver
   */
  private async discoverAdditionalDevices(pushReceiver: YxcPushReceiver): Promise<void> {
    try {
      const merged = await this.runDiscovery();
      if (this.unloading) {
        return; // the search outlived the adapter — nothing may start now
      }
      let changed = false;
      for (const device of merged) {
        const running = this.deviceRecords.get(device.id);
        try {
          if (!running) {
            this.log.info(`discovery found ${device.id} — setting up`);
            await this.startDevice(device, pushReceiver);
            changed = true;
          } else if (running.ip !== device.ip) {
            this.log.info(`${device.id}: address changed from ${running.ip} to ${device.ip} — reconnecting it there`);
            this.knownDeviceIps.delete(running.ip);
            this.stopDevice(device.id);
            await this.startDevice(device, pushReceiver);
            changed = true;
          }
        } catch (e) {
          // Same rule as the start-up loop: one device must not end the round for the others.
          this.log.error(`${device.id}: could not be set up (${errorMessage(e)}) — the other devices continue`);
        }
      }
      if (changed) {
        this.writeDeviceOverview();
      }
    } catch (e) {
      this.log.warn(`background discovery failed: ${errorMessage(e)}`);
    }
  }

  /**
   * Whether this instance searches the network at all.
   *
   * Three operating modes out of two independent things — this setting and the device table:
   * `auto` searches while the table is empty (what every installation did before 2.9.0, so an
   * update changes nothing by itself), `always` searches next to a filled table (mixed mode),
   * `never` runs the table alone. The setting is three-valued on purpose: a checkbox would need
   * a default in `io-package.json`, and either value would be wrong for half the existing
   * installations — `auto` is right for all of them without writing anything.
   *
   * @param manualCount how many devices the instance's table holds
   * @returns whether the network search runs
   */
  private searchesTheNetwork(manualCount: number): boolean {
    const mode = this.config.discovery ?? "auto";
    return mode === "always" || (mode === "auto" && manualCount === 0);
  }

  /**
   * Arm a background search because an auto-found device is offline — the only way back to a
   * receiver that moved to another address, since it answers at the remembered one no more.
   * Throttled: a device that is merely switched off must not turn this into a scan loop, and
   * one timer covers however many devices are down.
   *
   * @param deviceId the device that just went offline
   */
  private scheduleRediscovery(deviceId: string): void {
    // Per device, not per instance: a manual device sits at an address the user typed, so there
    // is nothing to search for — it is simply off. Only a discovered one can have moved.
    if (this.deviceRecords.get(deviceId)?.source !== "discovered") {
      return;
    }
    if (!this.discovering || this.unloading || this.rediscoverTimer !== undefined) {
      return;
    }
    const receiver = this.pushReceiver;
    if (!receiver) {
      return;
    }
    const due = Math.max(0, REDISCOVER_MIN_INTERVAL_MS - (Date.now() - this.lastRediscovery));
    this.rediscoverTimer = this.setTimeout(() => {
      this.rediscoverTimer = undefined;
      this.lastRediscovery = Date.now();
      if (!this.unloading) {
        void this.discoverAdditionalDevices(receiver);
      }
    }, due);
  }

  /**
   * Stop supervising one device and release its supervisor. The object tree is untouched —
   * a readdress puts the same device straight back on it.
   *
   * @param deviceId the id-safe device id
   */
  private stopDevice(deviceId: string): void {
    const supervisor = this.supervisorById.get(deviceId);
    if (!supervisor) {
      return;
    }
    supervisor.close();
    this.supervisorById.delete(deviceId);
    const index = this.supervisors.indexOf(supervisor);
    if (index >= 0) {
      this.supervisors.splice(index, 1);
    }
  }

  /**
   * Drop every entry of a state-id-keyed cache that belongs to one device.
   *
   * The caches are keyed by namespace-relative state ids (`stripNamespace` in
   * {@link snapshotExistingDatapoints}), so a device owns exactly the keys under its own prefix.
   *
   * @param cache a map or set keyed by namespace-relative state ids
   * @param deviceId the id-safe device id
   */
  private forgetUnder(cache: StateKeyedCache, deviceId: string): void {
    const prefix = `${deviceId}.`;
    for (const key of [...cache.keys()]) {
      if (key.startsWith(prefix)) {
        cache.delete(key);
      }
    }
  }

  /**
   * Remove one device for good: stop talking to it and delete its object tree.
   *
   * Driven by the device manager's delete action. Deleting a discovered device used to only
   * empty the remembered list — the supervisor kept the connection, the tree stayed, and the card
   * came back on the next start. Now the delete is what it says; the id is additionally kept in
   * the ignored list (device manager) so a later search does not put the device back.
   *
   * @param deviceId the id-safe device id
   */
  public async removeDevice(deviceId: string): Promise<void> {
    this.stopDevice(deviceId);
    // A native patch still inside its coalescing window would fire AFTER the delete below and
    // recreate the device object as a bare orphan — cancel it before anything else.
    const pendingNative = this.pendingNative.get(deviceId);
    if (pendingNative) {
      this.clearTimeout(pendingNative.timer);
      this.pendingNative.delete(deviceId);
    }
    const record = this.deviceRecords.get(deviceId);
    if (record) {
      this.knownDeviceIps.delete(record.ip);
    }
    this.deviceRecords.delete(deviceId);
    this.deviceConnected.delete(deviceId);
    this.readyDevices.delete(deviceId);
    // Everything else this device left behind goes with it. A cache that survives makes the
    // adapter believe it already did the work: re-adding the SAME id finds the icon cache
    // intact, `updateDeviceIcon` bails on the identity check, and the card keeps the default
    // silhouette `ensureDeviceHeader` seeds — a soundbar shows a receiver until the next start.
    this.deviceIcons.delete(deviceId);
    this.deviceLabels.delete(deviceId);
    this.profiles.delete(deviceId);
    this.forgetUnder(this.knownDatapoints, deviceId);
    this.forgetUnder(this.storedStates, deviceId);
    this.forgetUnder(this.storedBounds, deviceId);
    this.forgetUnder(this.touchedThisRun, deviceId);
    this.forgetUnder(this.volumeScales, deviceId);
    try {
      await this.delObjectAsync(deviceId, { recursive: true });
    } catch (e) {
      this.log.warn(`could not remove the object tree of "${deviceId}" (${errorMessage(e)})`);
    }
    this.writeState("info.connection", [...this.deviceConnected.values()].some(Boolean));
    this.writeDeviceOverview();
  }

  /**
   * Subscribe to the adapter's own states — OBSERVED, like every other database call.
   *
   * `subscribeStates` without a callback returns a promise, and its wildcard branch reads the
   * matching objects first: any failure there ends in `maybeCallbackWithError`, which rejects
   * for everything except the plain "database closed" case (js-controller-common-db source).
   * Left unawaited that is an unhandled rejection — and js-controller turns those into an
   * adapter stop, the same trap the nine bare state writes carried.
   *
   * A failure is loud but not fatal: without the subscription the tree still fills from the
   * devices, only user writes stop being applied. Saying so beats a silent half-working
   * instance, and beats losing the whole start over it.
   */
  private async subscribeToStates(): Promise<void> {
    try {
      await this.subscribeStatesAsync("*");
    } catch (e) {
      this.log.error(
        `could not subscribe to state changes (${errorMessage(e)}) — the tree still updates, ` +
          `but writes to datapoints will not reach the device until the instance is restarted`,
      );
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
    if (connected && !this.readyDevices.has(deviceId)) {
      this.readyDevices.add(deviceId);
      // Arm the settle pass even when the connect created nothing new — the once-per-
      // version orphan purge rides the same settled moment as the balance line.
      this.scheduleDatapointBalance();
    }
    this.deviceConnected.set(deviceId, connected);
    this.writeState(`${deviceId}.info.connection`, connected);
    // A drop clears the per-transport flags; a (re)connect sets them again via onTransports.
    if (!connected) {
      this.setTransports(deviceId, []);
      // A discovered device may simply have moved — only a search can find it again.
      this.scheduleRediscovery(deviceId);
    }
    const anyConnected = [...this.deviceConnected.values()].some(Boolean);
    this.writeState("info.connection", anyConnected);
    this.writeDeviceOverview();
  }

  /**
   * The three overview datapoints: how many devices this instance runs, how many are
   * connected right now, and whether that is all of them. Derived from the SAME map that
   * feeds the per-device markers and written in the same round — computed separately they
   * would drift away from what the single devices say.
   *
   * `devicesAllOnline` needs at least one device: zero of zero is not "everything is fine".
   */
  private writeDeviceOverview(): void {
    const total = this.deviceConnected.size;
    const online = [...this.deviceConnected.values()].filter(Boolean).length;
    this.writeState("info.devicesTotal", total);
    this.writeState("info.devicesOnline", online);
    this.writeState("info.devicesAllOnline", total > 0 && online === total);
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
      this.writeState(`${deviceId}.info.transports.${proto}`, live.has(proto));
    }
  }

  /**
   * Write a state with ack — and OBSERVE the promise. js-controller turns an unhandled
   * promise rejection into an adapter stop (`_exceptionHandler` → exit code
   * UNCAUGHT_EXCEPTION, read in the controller source), and `setState` rejects whenever
   * the states database is not reachable for a moment (`ERROR_DB_CLOSED`, or a pending
   * command cancelled by a reconnecting Redis). Nine fire-and-forget writes used to run
   * bare: one hiccup while a device pushed a value would have restarted the whole
   * instance. The failure lands in the log instead — once per outage at warn, then at
   * debug until a write succeeds again; during teardown it is expected and stays silent.
   *
   * @param id the state id (namespace-relative)
   * @param value the value to write
   */
  private writeState(id: string, value: ioBroker.StateValue): void {
    this.setState(id, { val: value, ack: true }).then(
      () => {
        this.stateWritesFailing = false;
      },
      (e: unknown) => this.noteWriteFailure(`state ${id}`, e),
    );
  }

  /**
   * Persist a device object's `native` part — observed like {@link writeState}. The two
   * per-device caches (YNCA subunit probe, probe memory) persist through it.
   *
   * @param deviceId the device object id
   * @param native the native fields to merge into the object
   */
  private persistDeviceNative(deviceId: string, native: Record<string, unknown>): void {
    // Coalesced per device: the probe memory persists on EVERY change, and a first connect
    // changes it dozens of times within a second (every observed enum value, every declared
    // list) — each was one extendObject on the device object. Latest wins, one write per window.
    const pending = this.pendingNative.get(deviceId);
    if (pending) {
      Object.assign(pending.native, native);
      return;
    }
    const entry: PendingNative = { native: { ...native } };
    this.pendingNative.set(deviceId, entry);
    // this.setTimeout refuses during shutdown (returns undefined) — then write at once.
    entry.timer = this.setTimeout(() => this.flushDeviceNative(deviceId), NATIVE_PERSIST_WINDOW_MS);
    if (!entry.timer) {
      void this.flushDeviceNative(deviceId);
    }
  }

  /**
   * Write a device's pending native patch now (the coalescing window ended, or the adapter is
   * unloading).
   *
   * @param deviceId the id-safe device id
   * @returns the write, for the unload path to wait on
   */
  private flushDeviceNative(deviceId: string): Promise<void> {
    const pending = this.pendingNative.get(deviceId);
    if (!pending) {
      return Promise.resolve();
    }
    this.pendingNative.delete(deviceId);
    this.clearTimeout(pending.timer);
    return this.extendObject(deviceId, { native: pending.native }).then(
      () => {
        this.stateWritesFailing = false;
      },
      (e: unknown) => this.noteWriteFailure(`device object ${deviceId}`, e),
    );
  }

  /**
   * Log a failed database write: warn on the first failure of an outage, debug for the
   * repeats, silence while unloading (the database is going down with us).
   *
   * @param what which write failed, for the log line
   * @param e the rejection reason
   */
  private noteWriteFailure(what: string, e: unknown): void {
    if (this.unloading) {
      return;
    }
    const message = `could not write ${what} (${errorMessage(e)})`;
    if (this.stateWritesFailing) {
      this.log.debug(message);
      return;
    }
    this.stateWritesFailing = true;
    this.log.warn(`${message} — repeats stay at debug until a write succeeds`);
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
    const allObjects = await this.getAdapterObjectsAsync();
    const existing = Object.keys(allObjects);
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
    // The reasons stay available for diagnosis; the user sees ONE balance line instead of
    // three counts they have to add up themselves.
    if (stale.length > 0) {
      this.log.debug(`removed ${stale.length} object(s) from a previous configuration`);
    }
    if (renamed.length > 0) {
      this.log.debug(`removed ${renamed.length} renamed object(s) from an earlier version`);
    }
    if (disabled.length > 0) {
      this.log.debug(`removed ${disabled.length} object(s) from switched-off datapoint groups`);
    }
    // Channels and device nodes go with them, but only datapoints are counted — that is what
    // the user switched on or off, and what they look for in the object tree.
    this.noteDatapointsRemoved(
      [...stale, ...renamed, ...disabled].filter(fullId => allObjects[fullId]?.type === "state"),
    );
  }

  /**
   * Remove read-capable states under a CONNECTED device that never carried a value and were not
   * (re)created by this run's transports — over-declarations of an earlier adapter version that
   * today's claim-with-proof creation no longer makes. Deleting them is lossless (no value, no
   * history). Runs after the tree settled, so a device that has not connected in this run keeps
   * its tree untouched — its sweep happens on the first start that reaches it.
   *
   * TWO starts decide, not one (2.7.0): a receiver in standby answers many functions
   * `@RESTRICTED`, so one run seeing a datapoint untouched is no proof the device lost it. The
   * first run RECORDS the candidates in the device's capability profile (`pendingPurge`), the
   * next run deletes those still untouched and still never filled, and forgets the rest. A device
   * is examined once per adapter version (`purgeVersion`) OR whenever it carries a recorded
   * candidate — the confirmation has to reach its second start even without a new version.
   */
  private async purgeNeverFilled(): Promise<void> {
    const candidates: string[] = [];
    for (const deviceId of this.readyDevices) {
      const profile = this.profiles.get(deviceId);
      if (profile?.purgeVersion !== this.version || (profile?.pendingPurge.length ?? 0) > 0) {
        candidates.push(deviceId);
      }
    }
    if (candidates.length === 0) {
      return;
    }
    const allObjects = await this.getAdapterObjectsAsync();
    const states = await this.getStatesAsync("*");
    const untouched = neverWrittenStateIds(allObjects, states, new Set(candidates), this.namespace).filter(
      fullId => !this.touchedThisRun.has(stripNamespace(fullId, this.namespace)),
    );
    const purged: string[] = [];
    for (const deviceId of candidates) {
      const profile = this.profiles.get(deviceId);
      const seenNow = untouched
        .filter(fullId => fullId.startsWith(`${this.namespace}.${deviceId}.`))
        .map(fullId => stripNamespace(fullId, this.namespace));
      const recorded = new Set(profile?.pendingPurge ?? []);
      const confirmed = seenNow.filter(id => recorded.has(id));
      for (const id of confirmed) {
        try {
          await this.delObjectAsync(id);
          purged.push(`${this.namespace}.${id}`);
        } catch {
          // already gone
        }
      }
      // Whatever is untouched THIS run and was not just deleted waits for the next run.
      profile?.setPendingPurge(seenNow.filter(id => !confirmed.includes(id)));
      profile?.markPurged(this.version ?? "");
    }
    if (purged.length > 0) {
      this.log.debug(`removed ${purged.length} never-filled object(s), confirmed over two starts`);
      this.noteDatapointsRemoved(purged);
    }
  }

  /**
   * Remove folders that hold no datapoint any more, under the devices that connected this run.
   *
   * The two sweeps above only ever delete datapoints, so a folder emptied by a tree rework stays
   * behind and promises content it can never get — `player.server` is the live case: the v2.0.0
   * migration deletes the SERVER source's playback copies, and the new tree gives that source no
   * datapoint of its own. Runs on every start, not once per version: an empty folder is wrong
   * whenever it is found, and re-reading the objects after the orphan purge catches the ones that
   * purge just emptied. Not counted in the datapoint balance — a folder is not a datapoint.
   */
  private async purgeChildlessChannels(): Promise<void> {
    if (this.readyDevices.size === 0) {
      return;
    }
    const empty = childlessChannelIds(await this.getAdapterObjectsAsync(), this.readyDevices, this.namespace);
    for (const fullId of empty) {
      try {
        await this.delObjectAsync(stripNamespace(fullId, this.namespace));
      } catch {
        // already removed together with its parent
      }
    }
    if (empty.length > 0) {
      this.log.debug(`removed ${empty.length} empty folder(s) left over from an earlier object tree`);
    }
  }

  /**
   * Empty an object's stored `common.states` when it holds a key the new map lacks, so the
   * following merge-write results in exactly the new map (memory
   * `reference_iobroker_objekt_aendern_ohne_loeschen`: never delete an object to change it,
   * write `null` for the key instead). Judged against the start-up snapshot, then against what
   * this run last wrote — never a database read per state.
   *
   * @param id the object id (namespace-relative)
   * @param next the map about to be written
   */
  private async clearStaleStates(id: string, next: Record<string, string>): Promise<void> {
    const stored = this.storedStates.get(id);
    if (stored && Object.keys(stored).some(key => !(key in next))) {
      await this.extendObject(id, { common: { states: null } });
    }
    this.storedStates.set(id, next);
  }

  /**
   * Clear a bound the new definition no longer declares, so the following merge-write leaves
   * exactly the new bounds behind — the same rule {@link clearStaleStates} applies to a
   * shrinking dropdown (`reference_iobroker_objekt_aendern_ohne_loeschen`: write `null` for the
   * key, never delete the object). Judged against the start-up snapshot and then against what
   * this run wrote, so it costs no read per state.
   *
   * @param id the object id (namespace-relative)
   * @param next the common part about to be written
   */
  private async clearStaleBounds(id: string, next: ObjectDef["common"]): Promise<void> {
    const stored = this.storedBounds.get(id);
    const gone = BOUND_FIELDS.filter(field => stored?.[field] !== undefined && next[field] === undefined);
    this.storedBounds.set(id, { min: next.min, max: next.max, step: next.step });
    if (gone.length === 0) {
      return;
    }
    // ⚠️ NOT the `null` write `clearStaleStates` uses. A dropdown has a neutral value — an empty
    // map — and `null` reaches it. A bound has none: the merge writes `common.max = null`, and
    // js-controller's range check then compares against it numerically, where `null` counts as 0
    // and every reading is "greater than max" (`reference_attribut_entfernen_ohne_setobject`, and
    // the merge semantics measured in `reference_iobroker_objekt_aendern_ohne_loeschen`). The key
    // has to GO, which is read → delete → re-create; `setObject` is the checker's S5054.
    const object = await this.getObjectAsync(id);
    if (object?.type !== "state") {
      return;
    }
    // The READ common rides along, so nothing the object already carries is lost in the rewrite.
    const common = { ...object.common } as ioBroker.StateCommon & Record<string, unknown>;
    for (const field of gone) {
      delete common[field];
    }
    try {
      // Explicitly non-recursive: a state has no children, and this must never take a tree with it.
      await this.delObjectAsync(id, { recursive: false });
    } catch (e) {
      // The merge that follows would only put the object back as it was — nothing is lost, but the
      // stale bound stays, so it belongs in the log rather than passing silently.
      this.log.debug(`${id}: could not drop the stale bound(s) ${gone.join(", ")} (${errorMessage(e)})`);
      return;
    }
    await this.extendObject(id, { type: "state", common, native: object.native });
  }

  /**
   * Remember every datapoint that already exists, ONCE per adapter run.
   *
   * @see knownDatapoints for why the create path alone cannot answer "is this new?"
   */
  private async snapshotExistingDatapoints(): Promise<void> {
    try {
      for (const [fullId, object] of Object.entries(await this.getAdapterObjectsAsync())) {
        if (object?.type === "state") {
          const id = stripNamespace(fullId, this.namespace);
          this.knownDatapoints.add(id);
          const common = object.common as
            { states?: unknown; min?: unknown; max?: unknown; step?: unknown } | undefined;
          const states = common?.states;
          if (states !== null && typeof states === "object") {
            this.storedStates.set(id, states as Record<string, string>);
          }
          this.storedBounds.set(id, boundsOfCommon(common));
        }
      }
    } catch (e) {
      // Without the snapshot the balance would call every datapoint new; better to stay
      // silent about it than to log a wrong number.
      this.log.debug(`could not read the existing datapoints (${errorMessage(e)}); balance line disabled`);
      this.balanceDisabled = true;
    }
  }

  /**
   * Count a datapoint the device tree just created — new ones only.
   *
   * @param id the state id relative to the namespace
   */
  private noteDatapointCreated(id: string): void {
    if (this.knownDatapoints.has(id)) {
      return;
    }
    this.knownDatapoints.add(id);
    this.createdDatapoints++;
    this.scheduleDatapointBalance();
  }

  /**
   * Count removed datapoints, and let them count again should they ever come back.
   *
   * @param fullIds the removed ids, namespace included
   */
  private noteDatapointsRemoved(fullIds: readonly string[]): void {
    for (const fullId of fullIds) {
      this.knownDatapoints.delete(stripNamespace(fullId, this.namespace));
      this.removedDatapoints++;
    }
    if (fullIds.length > 0) {
      this.scheduleDatapointBalance();
    }
  }

  /**
   * Log the balance once the tree has settled. A device connects asynchronously and several
   * devices connect at once, so the line waits for quiet instead of firing per device — the
   * user made ONE change and reads ONE result.
   */
  private scheduleDatapointBalance(): void {
    if (this.balanceDisabled || this.balanceSettling) {
      return;
    }
    this.clearTimeout(this.balanceTimer);
    this.balanceTimer = this.setTimeout(() => {
      this.balanceTimer = undefined;
      void (async () => {
        this.balanceSettling = true;
        // The tree has settled: sweep the never-filled orphans FIRST, so their
        // removals land in the same balance line the user is about to read.
        try {
          await this.purgeNeverFilled();
        } catch (e) {
          this.log.debug(`orphan purge failed (${errorMessage(e)}); skipped for this run`);
        }
        // Then the folders those removals (or an earlier version's tree rework) left empty.
        try {
          await this.purgeChildlessChannels();
        } catch (e) {
          this.log.debug(`empty-folder purge failed (${errorMessage(e)}); skipped for this run`);
        }
        const parts: string[] = [];
        if (this.createdDatapoints > 0) {
          parts.push(`created ${this.createdDatapoints} datapoint(s)`);
        }
        if (this.removedDatapoints > 0) {
          parts.push(`removed ${this.removedDatapoints} datapoint(s)`);
        }
        this.createdDatapoints = 0;
        this.removedDatapoints = 0;
        // Silent when nothing changed: a plain restart must not write a line.
        if (parts.length > 0) {
          this.log.info(`Object tree updated: ${parts.join(", ")}`);
        }
        this.balanceSettling = false;
      })();
    }, DATAPOINT_BALANCE_SETTLE_MS);
  }

  /**
   * Refresh the adapter's OWN `info.*` objects.
   *
   * js-controller creates them from `io-package.json` `instanceObjects` when the instance is
   * added, and leaves an existing object's `common` alone on every later upgrade — so an
   * instance that predates a change keeps whatever the old version wrote. Measured after the
   * name translation went live: five of them still carried a plain-string name while the whole
   * rest of the tree was translated. Writing them here every start closes that half; extendObject
   * merges, so a recording setting or anything else a user attached survives.
   */
  private async ensureInstanceInfoObjects(): Promise<void> {
    // Spelled out with LITERAL ids on purpose. A loop over a table reads more compactly, but
    // then neither a reader nor the consistency gate can see which manifest objects are
    // actually refreshed — and "the call exists" is not the same question as "the call runs
    // for THIS object". This is the one place where that distinction cost a release (2.1.1).
    await this.extendObject("info", {
      type: "channel",
      common: { name: tName("information") },
      native: {},
    });
    await this.extendObject("info.connection", {
      type: "state",
      common: {
        name: tName("deviceOrServiceConnected"),
        desc: tName("descDeviceOrServiceConnected"),
        type: "boolean",
        role: "indicator.connected",
        read: true,
        write: false,
      },
      native: {},
    });
    await this.extendObject("info.devicesTotal", {
      type: "state",
      common: { name: tName("devicesTotal"), type: "number", role: "value", read: true, write: false },
      native: {},
    });
    await this.extendObject("info.devicesOnline", {
      type: "state",
      common: { name: tName("devicesOnline"), type: "number", role: "value", read: true, write: false },
      native: {},
    });
    await this.extendObject("info.devicesAllOnline", {
      type: "state",
      common: { name: tName("allDevicesOnline"), type: "boolean", role: "indicator", read: true, write: false },
      native: {},
    });
  }

  /**
   * Create AND refresh a device's header objects (the device node, its info channel and a
   * per-device connection indicator) so its state is visible even while offline.
   *
   * Written with `extendObject` on every start, not created once: an object that already exists
   * is otherwise never touched again, so an instance upgraded from an older version keeps
   * whatever that version wrote — measured live after the name translation, where these were the
   * only device datapoints left with a plain-string name (`info.model`/`info.firmware` came out
   * right only because a catalog entry upserts them on top). extendObject merges, so a recording
   * setting a user attached survives.
   *
   * @param deviceId the id-safe device id
   * @param ip the device's current address (from config or discovery)
   * @param source where the address came from — kept at the device object so the adapter, the
   *   card and the edit path all know it without re-deriving it from which table happens to be
   *   filled (which said the same thing about every device on the instance)
   */
  private async ensureDeviceHeader(deviceId: string, ip: string, source: DeviceSource): Promise<void> {
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
        native: { source },
      },
      { preserve: { common: ["name"] } },
    );
    await this.extendObject(`${deviceId}.info`, {
      type: "channel",
      common: { name: tName("info") },
      native: {},
    });
    await this.extendObject(`${deviceId}.info.connection`, {
      type: "state",
      common: {
        name: tName("connected"),
        // Its own explanation key: the name key `connected` is shared with the Bluetooth
        // source's "Connected", which means something else entirely.
        desc: tName("descDeviceConnected"),
        type: "boolean",
        role: "indicator.reachable",
        read: true,
        write: false,
        def: false,
      },
      native: {},
    });
    // Model name shown on the device-manager card. Filled by whichever transport reports it
    // (YNCA MODELNAME, YXC/XML model); created here so the card's model line binds even for an
    // offline device or a transport that does not report a model.
    await this.extendObject(`${deviceId}.info.model`, {
      type: "state",
      common: { name: tName("model"), type: "string", role: "text", read: true, write: false, def: "" },
      native: {},
    });
    // The device's address — for a discovered device it lived only in the adapter's
    // internals, so no diagnosis (log capture, browser access to the device's own pages)
    // could name it without a network search. Refreshed every start: DHCP may move it.
    await this.extendObject(`${deviceId}.info.ip`, {
      type: "state",
      common: { name: tName("ipAddress"), type: "string", role: "info.ip", read: true, write: false, def: "" },
      native: {},
    });
    await this.setState(`${deviceId}.info.ip`, { val: ip, ack: true });
    // Per-transport connection flags, fed by the live set from connectTransports and read live
    // by the device-manager card indicators. Created here so an offline device's card still
    // renders all three (false) instead of nothing.
    await this.extendObject(`${deviceId}.info.transports`, {
      type: "channel",
      common: { name: tName("transports"), desc: tName("descTransports") },
      native: {},
    });
    for (const proto of TRANSPORT_IDS) {
      await this.extendObject(`${deviceId}.info.transports.${proto}`, {
        type: "state",
        common: {
          name: tName("transportConnected", proto.toUpperCase()),
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
    if (config.group_zones) {
      config.group_multiroom = true;
    }
    delete config.group_zones;
    try {
      const obj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
      if (obj?.native) {
        if (obj.native.group_zones) {
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
        // A SHRINKING dropdown needs a clearing write first: extendObject merges `common.states`
        // key by key, so the old entries would survive every update (#619 — the reporter would
        // have seen no change at all). Only when the stored map carries a key the new one lacks;
        // an unchanged or growing map is one write, as before.
        if (def.type === "state" && def.common.states) {
          await this.clearStaleStates(id, def.common.states);
        }
        const written = this.presentVolume(id, def);
        if (written.type === "state") {
          await this.clearStaleBounds(id, written.common);
        }
        await this.extendObject(id, { type: written.type, common: written.common, native: {} });
        if (def.type === "state") {
          this.noteDatapointCreated(id);
          this.touchedThisRun.add(id);
        }
      },
      setStateAck: (id, value) => {
        // Same group gate as upsertObject, so a switched-off group seeds no orphan value either.
        if (!isGroupEnabled(id.slice(id.indexOf(".") + 1), this.config as unknown as Record<string, unknown>)) {
          return;
        }
        this.writeState(id, this.volumeAsShown(id, value));
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
        schedule: (handler, ms) => (this.unloading ? undefined : this.setTimeout(handler, ms)),
        cancel: handle => this.clearTimeout(handle),
      },
      registerPush: (ip, onPush) => pushReceiver.register(ip, onPush),
      pushActive: () => pushReceiver.isListening(),
      scheduleKeepalive: (handler, ms) => {
        if (this.unloading) {
          return () => {};
        }
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
    const value = state.ack ? state.val : this.volumeAsDeviceScale(relative, state.val);
    this.supervisorById.get(deviceId)?.handleStateChange(relative, state.ack, value);
  }

  /**
   * Synchronous teardown — no await, call the callback immediately (SIGKILL otherwise).
   *
   * @param callback function to invoke once teardown is complete
   */
  private onUnload(callback: () => void): void {
    try {
      this.unloading = true;
      this.clearTimeout(this.balanceTimer);
      this.clearTimeout(this.rediscoverTimer);
      this.pushReceiver?.close();
      for (const supervisor of this.supervisors) {
        supervisor.close();
      }
      // A stopped adapter talks to nothing, so no device may keep claiming to be connected —
      // that state paints the symbol on the device object (statusStates.onlineId), and the
      // instance-wide info.connection alone would leave every device green. The protocol
      // flags and the overview go with them; devicesTotal stays, how many devices there are
      // did not change.
      //
      // The callback goes LAST, after the writes: reporting "done" straight away loses them,
      // the host tears the process down as soon as it is told.
      const writes: Promise<unknown>[] = [this.setState("info.connection", { val: false, ack: true })];
      for (const deviceId of this.deviceConnected.keys()) {
        this.deviceConnected.set(deviceId, false);
        writes.push(this.setState(`${deviceId}.info.connection`, { val: false, ack: true }));
        // The protocol flags on the card go down with the connection — a stopped adapter
        // is connected over no protocol.
        for (const proto of TRANSPORT_IDS) {
          writes.push(this.setState(`${deviceId}.info.transports.${proto}`, { val: false, ack: true }));
        }
      }
      writes.push(this.setState("info.devicesOnline", { val: 0, ack: true }));
      writes.push(this.setState("info.devicesAllOnline", { val: false, ack: true }));
      // A device memory still inside its coalescing window is written now — a timer on a
      // stopped adapter never fires, and the memory is what the next start rests on.
      for (const deviceId of [...this.pendingNative.keys()]) {
        writes.push(this.flushDeviceNative(deviceId));
      }
      void Promise.all(writes)
        .catch(() => {
          /* states DB already going down — nothing left to report to */
        })
        .finally(callback);
      return;
    } catch {
      // fall through
    }
    callback();
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
    if (known.length > 0) {
      // Remembered devices start NOW — the network search used to gate every restart
      // by its collect window although the devices were already known. It still runs,
      // in the background, to pick up newcomers (see discoverAdditionalDevices).
      this.log.info(`setting up ${known.length} remembered device(s); the network search runs in the background`);
      return known;
    }
    this.log.info("auto-discovery via SSDP (older XML-only devices must be added manually)");
    const merged = await this.runDiscovery();
    this.log.info(`setting up ${merged.length} discovered device(s)...`);
    return merged;
  }

  /**
   * Search the network, merge with the remembered devices, and persist the result.
   * Shared by the blocking first-setup path and the background search.
   *
   * @returns the merged device records
   */
  private async runDiscovery(): Promise<DeviceRecord[]> {
    // Every search counts against the throttle, whoever asked for it — otherwise the first
    // offline device would fire another one right behind the start-up search.
    this.lastRediscovery = Date.now();
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
    const merged = mergeDiscovered(known, found, (dropped, takenId) =>
      this.log.warn(`discovered device "${dropped}" skipped — its object id "${takenId}" is already taken`),
    );
    // Devices the user deleted from the card list stay out — otherwise the next search simply
    // undoes the delete. So do the ones that live in the device table: a receiver the user gave
    // a fixed address and entered by hand would otherwise come back as a SECOND card, and the
    // store would carry the found address back over the typed one (`mergeDiscovered` updates a
    // known id's address). Both the id and the address are matched — the search reads the name
    // off the device, the user typed their own, so the same receiver can carry two ids.
    const ignored = new Set(await readIgnored(ignoredStoreDeps(this)));
    const manual = parseDevices(this.config.devices);
    const manualIds = new Set(manual.map(device => device.id));
    const manualIps = new Set(manual.map(device => device.ip));
    const kept = merged.filter(
      device => !ignored.has(device.id) && !manualIds.has(device.id) && !manualIps.has(device.ip),
    );
    await writeDiscovered(store, kept);
    return kept;
  }

  /**
   * Load a device's capability profile — the one persisted memory of what the device told us
   * (probe memory, YNCA subunit snapshot, purge marker) — from its device object's native
   * part, wrapped so every change persists back there through the coalescing writer. The
   * device object is the right home: writing an instance object's native restarts the
   * adapter, a device object's does not. Legacy keys of 2.5.2/2.6.0 are converted at load.
   *
   * @param deviceId the id-safe device id
   * @returns the per-device profile store
   */
  private async loadDeviceProfile(deviceId: string): Promise<DeviceProfileStore> {
    let native: Record<string, unknown> | undefined;
    try {
      native = (await this.getObjectAsync(deviceId))?.native;
    } catch {
      native = undefined;
    }
    const store = new DeviceProfileStore(deviceId, native, {
      adapterVersion: this.version ?? "",
      now: () => new Date().toISOString(),
      persist: patch => this.persistDeviceNative(deviceId, patch),
      log: message => this.log.debug(message),
    });
    this.profiles.set(deviceId, store);
    return store;
  }

  /**
   * The object definition to write for a datapoint, once percent mode has had its say.
   *
   * Applied to the FINISHED definition, after the coordinator picked the owner, so one rule covers
   * all three transports and every zone: the decibels YNCA and XML declare in their catalogs and
   * the display scale MusicCast reports are all just "the device's own scale" here. The bounds it
   * replaces are remembered, because they are what the two value directions convert against.
   *
   * @param id the full object id
   * @param def the definition the coordinator produced
   * @returns the definition to write
   */
  private presentVolume(id: string, def: ObjectDef): ObjectDef {
    if (def.type !== "state" || !isAmpVolumeId(id.slice(id.indexOf(".") + 1))) {
      return def;
    }
    const bounds = volumeBoundsOf(def);
    if (!bounds) {
      // Nothing declared to convert against. Percent would be a number with no meaning, so the
      // datapoint keeps the device's own scale even with the switch on, and says so once.
      this.volumeScales.delete(id);
      if (this.config.volumeAsPercent) {
        this.log.debug(`${id}: no declared range — keeping the device's own scale instead of percent`);
      }
      return def;
    }
    this.volumeScales.set(id, bounds);
    return this.config.volumeAsPercent ? asPercentObject(def) : def;
  }

  /**
   * A device value on its way into a datapoint, converted when that datapoint is in percent.
   *
   * @param id the full state id
   * @param value the value the transport reported, on the device's own scale
   * @returns the value to store
   */
  private volumeAsShown(id: string, value: boolean | number | string): boolean | number | string {
    const bounds = this.config.volumeAsPercent ? this.volumeScales.get(id) : undefined;
    return bounds && typeof value === "number" ? toPercent(value, bounds) : value;
  }

  /**
   * A user's write on its way out, converted back to the scale the device expects.
   *
   * Only unacked writes reach here: an acked one is the adapter's own echo, already in percent,
   * and converting it a second time would walk the value down on every poll.
   *
   * @param relativeId the state id without the namespace
   * @param value the value the user wrote
   * @returns the value to hand to the device's supervisor
   */
  private volumeAsDeviceScale(relativeId: string, value: ioBroker.StateValue): ioBroker.StateValue {
    const bounds = this.config.volumeAsPercent ? this.volumeScales.get(relativeId) : undefined;
    return bounds && typeof value === "number" ? fromPercent(value, bounds) : value;
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
        let bytes = 0;
        res.on("data", chunk => {
          bytes += (chunk as Buffer).length;
          if (bytes > MAX_HTTP_BODY_BYTES) {
            // A description document is a few KB — whatever streams past the cap is not one.
            res.destroy(new Error(`description too large: ${url}`));
            return;
          }
          data += String(chunk);
        });
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
