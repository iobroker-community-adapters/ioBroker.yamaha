import * as utils from "@iobroker/adapter-core";
import { createSocket } from "node:dgram";
import { get as httpGet } from "node:http";
import { networkInterfaces } from "node:os";
import { attemptDevice } from "./lib/attempt-device";
import { isIPv4, resolveIPv4, searchInterfaces } from "./lib/network-interfaces";
import { isGroupEnabled } from "./lib/catalog/groups";
import { writableNumber } from "./lib/catalog/value-coerce";
import type { ObjectDef } from "./lib/catalog/types";
import {
  asPercentObject,
  fromPercent,
  isAmpVolumeId,
  toPercent,
  volumeBoundsOf,
  type VolumeBounds,
} from "./lib/catalog/volume-percent";
import { DEVICE_TYPE_ICONS, iconForModel } from "./lib/device-type";
import {
  BOUND_FIELDS,
  type BoundFields,
  boundsOfCommon,
  childlessChannelIds,
  LABEL_RANK,
  type LabelRank,
  labelRankOf,
  legacyDeviceRow,
  mergeDiscovered,
  neverWrittenStateIds,
  nextDeviceLabel,
  isDottedQuad,
  parseDevices,
  rowDeviceId,
  sanitizeId,
  unionDevices,
  renamedObjectIds,
  staleObjects,
  stripNamespace,
} from "./lib/pure-helpers";
import { ID_SCHEME, modelId, serialId } from "./lib/device-id";
import {
  copyDeviceTree,
  enumMembersUnder,
  movedId,
  type DeviceMoveDeps,
  type MoveReport,
} from "./lib/lifecycle/device-move";
import { moveWithEnums } from "./lib/enum-carry";
import { DeviceBody, errorMessage } from "./lib/util";
import { migrateNativeKeys, type NativeKeyMigration } from "./lib/native-key-migration";
import { tName } from "./lib/i18n";
import { discoverYamaha, probeDescription, type DiscoveredDevice } from "./lib/discovery";
import { SsdpListener, type SsdpNotify } from "./lib/ssdp-listener";
import { isExcluded, readDiscovered, readExcluded, readIgnored, writeDiscovered } from "./lib/discovered-store";
import { identityFrom, mergeIdentity, sameDevice, type DeviceIdentity } from "./lib/device-identity";
import { discoveredStoreDeps, excludedStoreDeps, ignoredStoreDeps } from "./lib/discovered-store-deps";
import { YxcPushReceiver } from "./lib/yxc/push-receiver";
import { PushLiveness } from "./lib/yxc/push-liveness";
import { YamahaDeviceManagement } from "./device-management";
import type { DeviceSource, DeviceRecord } from "./lib/types";
import { DeviceSupervisor, type ConnectionHandle } from "./lib/lifecycle/device-supervisor";
import { ReconnectStrategy } from "./lib/lifecycle/reconnect-strategy";
import type { YncaSubunitCache } from "./lib/ynca/subunit-cache";
import type { ProbeMemory } from "./lib/lifecycle/probe-memory";
import { DeviceProfileStore, loadCapabilityProfile, profileIdentityOf } from "./lib/lifecycle/capability-profile";

/** Supervisor reconnect backoff bounds (exponential: 1s, 2s … capped at 60s). */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;
/** Longest a delete waits for a device's running connection attempt (every transport times out sooner). */
const REMOVE_SETTLE_CAP_MS = 30000;

/** The adapter's own object tree as `getAdapterObjectsAsync` lists it. */
type AdapterObjects = Awaited<ReturnType<ioBroker.Adapter["getAdapterObjectsAsync"]>>;

/** The pictograms THIS version draws — anything else in `common.icon` is an older adapter's drawing. */
const CURRENT_PICTOGRAMS: ReadonlySet<string> = new Set(Object.values(DEVICE_TYPE_ICONS));

/**
 * The model a device object's capability profile remembers, for a device that is off right now.
 * Any transport's identity will do — the model name is the same on all three.
 *
 * @param native the device object's native part (untrusted storage)
 * @returns the remembered model name, or undefined
 */
function rememberedModel(native: Record<string, unknown> | undefined): string | undefined {
  try {
    const identity = profileIdentityOf(loadCapabilityProfile(native).memory ?? {});
    const fromProfile = identity.ynca?.model ?? identity.yxc?.model ?? identity.xml?.model;
    // `native.model` sits next to the identity, outside the capability profile: a discovery-schema
    // bump empties the profile, the model stays (audit 2026-09-24, A22).
    return fromProfile ?? (typeof native?.model === "string" && native.model.length > 0 ? native.model : undefined);
  } catch {
    return undefined;
  }
}

/** Abort a discovery description fetch after this long, so a dead device cannot hang it. */
const FETCH_TIMEOUT_MS = 4000;

/** How often the discovery M-SEARCH is repeated — multicast is lossy, one dropped packet must not hide a receiver. */
const SSDP_SEARCH_BURST = 3;
/** Spacing between the repeated M-SEARCH sends, inside the collect window. */
const SSDP_SEARCH_INTERVAL_MS = 1000;

/**
 * Instance settings an earlier release declared and this one no longer reads. js-controller adds a
 * missing key on an update but never removes one, so each stayed in every installation for good.
 * Where the code still takes a value over, that happens BEFORE the drop: `ip` becomes the device
 * table row (`migrateLegacyDevice`), `group_zones` folds into `group_multiroom`
 * (`migrateGroupZones`), and every device writes the 2.8.0 `volumeAsPercent` switch down as its own
 * answer (`ensureDeviceHeader`) — which is why the drop runs after the devices were set up.
 */
const NATIVE_KEY_MIGRATIONS: NativeKeyMigration[] = [
  { drop: "elapsedInterval" }, // 0.1.x — the play-time poll
  { drop: "webserverEnabled" }, // 0.1.x — the built-in web server
  { drop: "webserverPort" }, // 0.1.x — its port
  { drop: "ip" }, // 0.5.x — the single receiver's address
  { drop: "intervall" }, // 0.5.x — the XML poll interval, now `xmlPollInterval`
  { drop: "refreshOnRealtime" }, // 0.5.x — realtime refresh
  { drop: "useRealtime" }, // 0.5.x — realtime events
  { drop: "hasXmlDevice" }, // until 0.14.0
  { drop: "group_zones" }, // until 0.17.0 — the zones group joined the multiroom group
  { drop: "volumeAsPercent" }, // 2.8.0 — the percent switch is a device setting since 2.9.0
  // Manifest keys of earlier releases that js-controller keeps in the instance's `common` for good.
  { commonDrop: "license" }, // since 0.1.0 — `common.licenseInformation` replaced it
  { commonDrop: "localLink" }, // since 0.1.0 — the adapter has no web page of its own
  { commonDrop: "materialize" }, // since 0.3.21 — the admin page is jsonConfig
  { commonDrop: "messagebox" }, // since 0.1.0 — `supportedMessages` declares what the adapter receives
  { commonDrop: "nondeletable" }, // since 0.0.2 — an instance must be deletable
];

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
 * The gap before the FIRST search after a device lost a transport. A receiver that moved answers
 * nowhere at its old address, so the first transport to notice is the signal — waiting for the
 * last one (MusicCast: three five-minute polls) and then the throttle above made an address
 * change take twenty minutes. A device that stays off falls back to the throttle above.
 */
const REDISCOVER_QUICK_INTERVAL_MS = 20000;

/**
 * How long one unknown address is left alone after its description was probed on a NOTIFY. A
 * device repeats its alive every few minutes for every service it has; one probe per address
 * per minute is plenty, and a non-Yamaha device on the network costs one fetch a minute at most.
 */
const NOTIFY_PROBE_THROTTLE_MS = 60000;
/**
 * …unless the description could not be read: a receiver announces itself early in its boot,
 * before its HTTP server answers, and repeats the announcement within seconds — the boot burst
 * must not be locked out for a minute on the first miss.
 */
const NOTIFY_RETRY_MS = 5000;

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
  /**
   * Per volume datapoint, the definition the coordinator produced BEFORE percent had its say —
   * what the live switch rebuilds from, so turning it changes the object without a restart.
   */
  private readonly volumeDefs = new Map<string, ObjectDef>();
  /**
   * Per device, whether its volume datapoints read 0…100 %. A device setting, not an instance
   * one: the adapter serves several receivers and 2.8.0's single checkbox hit all of them.
   */
  private readonly volumePercent = new Map<string, boolean>();
  /**
   * The instance-wide percent switch of 2.8.0, read once per start. It decides what a device
   * that has not been asked yet inherits — see {@link ensureDeviceHeader}.
   */
  private legacyVolumePercent = false;

  private readonly supervisorById = new Map<string, DeviceSupervisor>();
  private readonly deviceConnected = new Map<string, boolean>();
  /** deviceId → the record it is currently running with, so an address change is visible. */
  private readonly deviceRecords = new Map<string, DeviceRecord>();
  /** The addresses of all supervised devices — a multiroom group resolves its clients through it. */
  private readonly knownDeviceIps = new Set<string>();
  /**
   * deviceId → the IPv4 address a row's HOSTNAME resolves to. Every packet the adapter matches (an
   * SSDP answer, a NOTIFY, a MusicCast event) carries the numeric source address; compared with the
   * name, a migrated `yamaha.fritz.box` row was started a second time or warned about as "elsewhere"
   * (audit 2026-09-24, A12).
   */
  private readonly resolvedHosts = new Map<string, string>();
  /** Whether the network search runs in this instance — see {@link searchesTheNetwork}. */
  private discovering = false;
  /**
   * The devices deleted in this session. A search that was already in flight when the card was
   * deleted read the stores BEFORE the exclusion was written — without this set it would
   * remember and start the device again a few seconds after the user removed it.
   */
  private readonly removed = new Set<string>();
  /**
   * The merge path (absorb what a search or a NOTIFY found, then start or move devices) runs one
   * at a time. Two overlapping runs — the quick re-search and a boot announcement — both found the
   * old supervisor stopped and started two for the same device; the first held the receiver's one
   * YNCA connection until the adapter stopped (audit 2026-09-24, A2).
   */
  private mergeChain: Promise<unknown> = Promise.resolve();
  /** The setup of a device in progress (header, profile) — a delete waits for it before it deletes. */
  private readonly starting = new Map<string, Promise<void>>();
  /**
   * Per device, the object definitions last written — shared by every connection attempt, so a
   * device that comes back as a whole writes only what changed (audit 2026-09-24, A14). Dropped for
   * a device whenever objects of it are deleted, or a returning object would be skipped as unchanged.
   */
  private readonly writtenObjects = new Map<string, Map<string, string>>();
  /**
   * deviceId → the address a MANUAL device was last seen answering at, away from its typed one.
   * The warning is said once per new address, not on every search.
   */
  private readonly warnedElsewhere = new Map<string, string>();
  /**
   * The search problems already warned about — a failing interface and an id collision of a find
   * repeat on every search (every five minutes while a device is offline); said once, then debug
   * (audit 2026-09-24, A15).
   */
  private readonly warnedSearch = new Set<string>();
  /** The devices whose connection attempt failed at least once in this session — "offline" proven, not assumed. */
  private readonly failedOnce = new Set<string>();
  /** deviceId → how many transports it had live at the last report, so a LOSS is visible. */
  private readonly liveTransportCount = new Map<string, number>();
  /** The offline devices a search already said it could not find — said once per outage. */
  private readonly reportedMissing = new Set<string>();
  /** Armed while an auto-found device is offline: the search that can bring it back. */
  private rediscoverTimer: ioBroker.Timeout | undefined;
  /** When the last background search ran, so the retry cannot become a scan loop. */
  private lastRediscovery = 0;
  private pushReceiver: YxcPushReceiver | undefined;
  /** The passive SSDP listener — only while the search is on; undefined when port 1900 could not be bound. */
  private ssdpListener: SsdpListener | undefined;
  /** address → when its description was last probed on a NOTIFY (the per-address throttle). */
  private readonly notifyProbed = new Map<string, number>();
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
  /**
   * Ids (namespace-relative) the never-filled purge recorded for confirmation during THIS process.
   * "Two starts decide" means two PROCESS starts: a later balance pass of the same run (another
   * device settling) must not confirm what an earlier pass only recorded (audit 2026-09-24).
   */
  private readonly recordedThisRun = new Set<string>();
  /**
   * Ids (namespace-relative) a transport's own declaration proves absent on the device — the
   * MusicCast getFeatures function lists, which do not depend on standby. The purge takes a
   * never-filled, untouched one on the first start instead of waiting for a second.
   */
  private readonly declaredAbsent = new Set<string>();
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
  /** Per device, the last write to its device object — the next one waits for it (see writeDeviceObject). */
  private readonly deviceObjectWrites = new Map<string, Promise<unknown>>();
  /** The devices whose id is final under the 3.0.0 rule (`native.idScheme`) — see checkIdDecision. */
  private readonly idDecided = new Set<string>();
  /** The devices whose id was already judged in this run — once per process is enough. */
  private readonly idChecked = new Set<string>();

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
      // Before anything reads a device id: the table rows and the discovery store come out of it
      // carrying the ids the trees now live under, and the cleanup below never sees an old one.
      const unmoved = await this.migrateDeviceIds();
      // The running set is the UNION of the device table and the discovery store, and whether
      // the network search runs at all is its own setting. Until 2.9.0 the table WAS the switch
      // — filled meant manual, empty meant auto — so the two could never be combined, and
      // turning a single discovered device into a manual one dropped every other one from the
      // run (their trees went with them). XML/pre-2010 devices never answer SSDP, so they are
      // always added by hand; that is exactly the case the mixed mode exists for.
      const configured = parseDevices(this.config.devices, (dropped, takenId) =>
        this.log.warn(`device "${dropped}" skipped — its object id "${takenId}" is already used by another device`),
      );
      // The 2.8.0 instance-wide percent switch: read from the instance OBJECT, not from
      // `this.config`. The key is out of the config schema now, so `this.config` is no longer a
      // source to build on — the object still carries what the user chose.
      const instance = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
      this.legacyVolumePercent =
        (instance?.native as { volumeAsPercent?: unknown } | undefined)?.volumeAsPercent === true;
      this.discovering = this.searchesTheNetwork(configured);
      const devices = unionDevices(configured, this.discovering ? await this.autoDiscover(configured.length) : []);
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
      // Devices the discovery store still remembers while the search is off. They do not run
      // this time, but the user never deleted them — so their trees stay and they are stamped
      // offline instead. Until 2.9.1 the first hand-entered receiver silently took every found
      // one's object tree with it, recordings and VIS bindings included.
      const idle = this.discovering ? [] : await this.rememberedButIdle(devices);
      // Before the cleanup and before any device connects — see knownDatapoints. The listing
      // is read once and handed on: the cleanup runs on the very same tree.
      const listing = await this.snapshotExistingDatapoints(unmoved);
      await this.cleanupStaleObjects(
        new Set(devices.map(device => device.id)),
        new Set(idle.map(device => device.id)),
        listing,
      );
      await this.ensureInstanceInfoObjects();
      await this.markIdleDevicesOffline(idle);
      await this.subscribeToStates();
      const pushReceiver = new YxcPushReceiver({
        log: {
          debug: message => this.log.debug(message),
          info: message => this.log.info(message),
          warn: message => this.log.warn(message),
        },
        schedule: (cb, ms) => this.setTimeout(cb, ms),
        cancel: handle => this.clearTimeout(handle),
      });
      pushReceiver.start();
      this.pushReceiver = pushReceiver;
      if (configured.length > 0) {
        // Routine, so debug: what the adapter is ABOUT to try is not an event — a device that
        // answers says so with its own "ready" line, one that is off says nothing (krobi
        // 2026-09-22: a "setting up" line for a receiver without power asserts what is not).
        this.log.debug(`connecting ${configured.length} configured device(s)`);
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
      // Every running device wrote the old percent switch down in its header by now — the
      // settings earlier releases declared can go.
      if (!this.unloading) {
        await this.dropObsoleteSettings([...devices, ...idle]);
      }
      // After the table rows, like the search: an announcement is read against the RUNNING set —
      // heard before, a moved device was taken for a stranger (audit 2026-09-24, A8).
      if (this.discovering) {
        await this.startSsdpListener();
      }
      this.writeDeviceOverview();
      // Auto mode with remembered devices: they started WITHOUT waiting for the network
      // search — it runs behind them, adds newcomers and moves a device that changed address.
      if (this.discovering && devices.length > 0) {
        void this.discoverAdditionalDevices(pushReceiver);
      }
      this.scheduleIdleSearch();
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
    // One supervisor per device: a second start for a running id would put two of them on the
    // same tree and the same YNCA socket (audit 2026-09-24, A2).
    if (this.supervisorById.has(device.id) || this.starting.has(device.id)) {
      this.log.debug(`${device.id}: already running — not started a second time`);
      return;
    }
    const setup = this.setUpDevice(device, pushReceiver);
    this.starting.set(device.id, setup);
    try {
      await setup;
    } finally {
      this.starting.delete(device.id);
    }
  }

  /**
   * The body of {@link startDevice}.
   *
   * @param device the device record
   * @param pushReceiver the shared YXC push receiver
   */
  private async setUpDevice(device: DeviceRecord, pushReceiver: YxcPushReceiver): Promise<void> {
    // Both callers check `unloading` after their network search resolves (onReady and
    // discoverAdditionalDevices) — a device handed over after onUnload never gets here.
    this.deviceConnected.set(device.id, false);
    this.deviceRecords.set(device.id, { ...device });
    this.knownDeviceIps.add(device.ip);
    if (!isIPv4(device.ip)) {
      const resolved = await resolveIPv4(device.ip);
      if (resolved) {
        this.resolvedHosts.set(device.id, resolved);
        this.knownDeviceIps.add(resolved);
      } else {
        this.log.debug(`${device.id}: ${device.ip} does not resolve to an IPv4 address right now`);
      }
    }
    // What the search learned about the device rides on the record; the device object gets it
    // now (persistDeviceNative needs the record above), the header read below merges what the
    // object already carried from earlier runs.
    this.learnIdentity(device.id, device.identity);
    await this.ensureDeviceHeader(device.id, device.ip, device.source ?? "discovered");
    // Stamp it disconnected BEFORE the first attempt: ioBroker keeps a state's last value
    // forever, so a crash or a power cut would otherwise leave the device green until it
    // reports again — and a device that never answers would stay green for good.
    await this.setState(`${device.id}.info.connection`, { val: false, ack: true });
    // The three protocol flags follow the same rule: left at their last value, a crash
    // would show "YNCA connected" on the card next to a red connection dot — for good, if
    // the device never answers again.
    this.setTransports(device.id, []);
    // Held here, not in the controllers: those are rebuilt on every connection attempt;
    // persisted at the device object (one capability profile), so a restart starts from the
    // remembered answers.
    const profile = await this.loadDeviceProfile(device.id);
    if (this.unloading || this.removed.has(device.id)) {
      return; // deleted, or the adapter stopped, while the header was written
    }
    const subunitCache = profile.subunitCache;
    const probeMemory = profile.probeMemory;
    // Whether this device's MusicCast events arrive — a verdict of the device, not of one connection
    // (audit 2026-09-24, C1).
    const pushLiveness = new PushLiveness();
    // Narrowing (attempt-device.ts: only the transports the description advertises) applies
    // INSIDE a streak of failed attempts. The first attempt after a success — the start, and the
    // first reconnect after a drop — always tries all three: a firmware update that brings
    // MusicCast reboots the receiver, drops the connection, and is seen right there. Without
    // this a narrowed set could never widen again, silently.
    let failedInARow = 0;
    const supervisor = new DeviceSupervisor({
      deviceId: device.id,
      attempt: async signal => {
        const handle = await this.attemptDevice(
          { ...device, services: failedInARow > 0 ? device.services : undefined },
          pushReceiver,
          this.knownDeviceIps,
          subunitCache,
          probeMemory,
          signal,
          pushLiveness,
        );
        failedInARow = handle ? 0 : failedInARow + 1;
        return handle;
      },
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
      const found = await this.searchNetwork();
      if (this.unloading) {
        return; // the search outlived the adapter — nothing may start now
      }
      const touched = await this.serializedMerge(async () => {
        const merged = await this.absorbFinds(found);
        return this.unloading ? new Set<string>() : this.reconcileDiscovered(merged, pushReceiver);
      });
      // "Off, not moved": an offline device the whole network did not answer for keeps its
      // objects and its address — the supervisor retries there. A debug line, once per outage:
      // being off is a state the datapoints show, not an event for the log.
      for (const [deviceId, connected] of this.deviceConnected) {
        const record = this.deviceRecords.get(deviceId);
        if (connected || !record || record.source === "manual" || touched.has(deviceId)) {
          continue;
        }
        if (!this.reportedMissing.has(deviceId)) {
          this.reportedMissing.add(deviceId);
          // debug, not info: an offline device is a state (`info.connection`), not an event.
          this.log.debug(`${deviceId}: not found on the network — keeping its objects and retrying at ${record.ip}`);
        }
      }
    } catch (e) {
      this.log.warn(`background discovery failed: ${errorMessage(e)}`);
    }
    this.scheduleIdleSearch();
  }

  /**
   * Bring the running set in line with what a search (or a NOTIFY probe) established: start a
   * device that is not supervised yet, move one that answers at a NEW address — and for a
   * migrated table row, write the new address into the table (the instance restarts on it; the
   * supervisor already runs at the new address until then).
   *
   * @param merged the records the search established (`absorbFinds`)
   * @param pushReceiver the shared YXC push receiver
   * @returns the ids this round started or moved
   */
  private async reconcileDiscovered(
    merged: readonly DeviceRecord[],
    pushReceiver: YxcPushReceiver,
  ): Promise<Set<string>> {
    const touched = new Set<string>();
    for (const device of merged) {
      if (this.removed.has(device.id)) {
        continue; // deleted while this search was running — see `removed`
      }
      const running = this.deviceRecords.get(device.id);
      try {
        if (!running) {
          this.log.info(`discovery found ${device.id} — setting up`);
          await this.startDevice(device, pushReceiver);
          touched.add(device.id);
        } else if (running.ip !== device.ip) {
          const migrated = device.source === "migrated";
          const tableNote = migrated ? "; updated the device table, the instance restarts on it" : "";
          this.log.info(
            `${device.id}: address changed from ${running.ip} to ${device.ip} — reconnecting it there${tableNote}`,
          );
          this.knownDeviceIps.delete(running.ip);
          // Wait for the old address's attempt in flight, as the delete does: a second
          // supervisor started next to a still-connecting one would have both writing info.*
          // and coordinating the tree for the same id.
          const old = this.supervisorById.get(device.id);
          this.stopDevice(device.id);
          await this.awaitSettled(old);
          // The wait is long enough for a delete or the unload to arrive (audit 2026-09-24, A2/A9).
          if (this.removed.has(device.id) || this.unloading) {
            continue;
          }
          await this.startDevice(device, pushReceiver);
          touched.add(device.id);
          if (migrated) {
            await this.updateTableAddress(device.id, device.ip);
          }
        }
      } catch (e) {
        // Same rule as the start-up loop: one device must not end the round for the others.
        this.log.error(`${device.id}: could not be set up (${errorMessage(e)}) — the other devices continue`);
      }
    }
    if (touched.size > 0) {
      this.writeDeviceOverview();
    }
    return touched;
  }

  /**
   * Write a migrated row's new address into the device table. The row's NAME stays (it is the
   * old address, and it marks the row as migrated — see `parseDevices`); only `ip` moves, and the
   * row is found by its id (`rowDeviceId`: the stored one, or the one 2.x derived from the name).
   * Writing the instance's native restarts the adapter — a rare event, once per DHCP change.
   *
   * @param deviceId the row's id
   * @param ip the address the search proved
   */
  private async updateTableAddress(deviceId: string, ip: string): Promise<void> {
    const instanceId = `system.adapter.${this.namespace}`;
    const instance = await this.getForeignObjectAsync(instanceId);
    // A delete in the meantime writes its own table — this write would put the row back.
    if (this.removed.has(deviceId) || this.unloading) {
      return;
    }
    const rows = (instance?.native as { devices?: unknown } | undefined)?.devices;
    if (!Array.isArray(rows)) {
      return;
    }
    const devices = rows.map(row => {
      const entry = row as { id?: unknown; name?: unknown; ip?: unknown };
      const rowIp = typeof entry.ip === "string" ? entry.ip : "";
      return rowIp !== "" && rowDeviceId({ ...entry, ip: rowIp }) === deviceId
        ? { ...entry, ip }
        : { ...entry, ip: rowIp };
    });
    await this.extendForeignObjectAsync(instanceId, { native: { devices } });
  }

  /**
   * Start the passive listener on the interfaces the active search leaves from. A bind failure
   * (port 1900 held by a service without `reuseAddr`) is said once; the adapter then finds an
   * address change through its periodic search only, as it did before.
   */
  private async startSsdpListener(): Promise<void> {
    const listener = new SsdpListener({
      interfaces: searchInterfaces(this.config.networkInterface, networkInterfaces()),
      log: {
        debug: message => this.log.debug(message),
        info: message => this.log.info(message),
        warn: message => this.log.warn(message),
      },
      onAlive: (notify, address) => this.onSsdpAlive(notify, address),
    });
    try {
      await listener.start();
      this.ssdpListener = listener;
    } catch (e) {
      listener.close();
      this.log.warn(
        `SSDP listener unavailable (${errorMessage(e)}) — address changes are found by the periodic search only`,
      );
    }
  }

  /**
   * A device announced itself. Three cases, cheapest first: the address is a running device's
   * (its periodic alive — nothing to do), the address was probed within the minute (leave it),
   * else fetch its description and absorb it exactly as a search result — a known device at a
   * new address is moved, a newcomer is started, a stranger is dropped.
   *
   * @param notify what the device said
   * @param address where it said it from
   */
  private onSsdpAlive(notify: SsdpNotify, address: string): void {
    if (this.unloading || !notify.location || this.knownDeviceIps.has(address)) {
      return;
    }
    const now = Date.now();
    const last = this.notifyProbed.get(address);
    if (last !== undefined && now - last < NOTIFY_PROBE_THROTTLE_MS) {
      return;
    }
    this.notifyProbed.set(address, now);
    this.absorbNotify(notify.location, address).catch((e: unknown) =>
      this.log.debug(`SSDP alive from ${address}: not absorbed (${errorMessage(e)})`),
    );
  }

  /**
   * Fetch the announcing device's description and run it through the one merge path.
   *
   * @param location the description URL it announced
   * @param address its address
   */
  private async absorbNotify(location: string, address: string): Promise<void> {
    const found = await probeDescription(
      {
        fetch: url => this.fetchUrl(url),
        log: { debug: message => this.log.debug(message), warn: message => this.log.warn(message) },
      },
      location,
      address,
    );
    if (found === undefined) {
      // Ask again after seconds, not after the full throttle — see NOTIFY_RETRY_MS. Only for a
      // description that could not be READ: a device that is no Yamaha stays on the full throttle
      // (audit 2026-09-24, A7).
      this.notifyProbed.set(address, Date.now() - NOTIFY_PROBE_THROTTLE_MS + NOTIFY_RETRY_MS);
      return;
    }
    if (found === null) {
      return;
    }
    const receiver = this.pushReceiver;
    if (!receiver || this.unloading) {
      return;
    }
    this.log.debug(`SSDP alive from ${address}: ${found.name || found.model || "a Yamaha device"} announced itself`);
    await this.serializedMerge(async () => {
      const merged = await this.absorbFinds([found]);
      if (!this.unloading) {
        await this.reconcileDiscovered(merged, receiver);
      }
    });
  }

  /**
   * Run one merge (absorb + reconcile) behind the one in flight — see `mergeChain`.
   *
   * @param run the merge
   * @returns what the merge returns
   */
  private serializedMerge<T>(run: () => Promise<T>): Promise<T> {
    const next = this.mergeChain.then(run, run);
    this.mergeChain = next.catch(() => undefined);
    return next;
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
   * "Empty" means: no row the user TYPED. A migrated row (`{ name: ip, ip }`, written by the
   * 0.5.4 upgrade) is not the user's decision to run the table alone — and it follows the
   * device to a new address only through the search, so the search must stay on for it.
   *
   * @param configured the records the instance's table holds
   * @returns whether the network search runs
   */
  private searchesTheNetwork(configured: readonly DeviceRecord[]): boolean {
    const mode = this.config.discovery ?? "auto";
    return mode === "always" || (mode === "auto" && configured.every(device => device.source === "migrated"));
  }

  /**
   * The devices the discovery store still remembers that are NOT part of this run: the network
   * search is off, so nothing looked for them. They keep their objects — switching the search
   * off is a configuration change, not a delete, and only the card's delete button removes a
   * device (it takes the record out of the store in the same step).
   *
   * @param running the devices this run does start
   * @returns the remembered records that stay idle
   */
  private async rememberedButIdle(running: readonly DeviceRecord[]): Promise<DeviceRecord[]> {
    const runningIds = new Set(running.map(device => device.id));
    const remembered = await readDiscovered(discoveredStoreDeps(this));
    return remembered.filter(device => !runningIds.has(device.id));
  }

  /**
   * Stamp the idle devices disconnected and say once why they are idle. ioBroker keeps a
   * state's last value forever, so a kept tree would otherwise still claim "connected,
   * YNCA ✓" while nothing is talking to the device — the same lie the disconnected stamp in
   * {@link startDevice} prevents for a device that does run.
   *
   * Every write is guarded on the object being there: nothing starts these devices, so
   * nothing creates their header either, and a blind write would leave bare orphan states
   * behind for a device whose tree is already gone.
   *
   * @param idle the remembered devices that do not run this time
   */
  private async markIdleDevicesOffline(idle: readonly DeviceRecord[]): Promise<void> {
    if (idle.length === 0) {
      return;
    }
    for (const device of idle) {
      const ids = [
        `${device.id}.info.connection`,
        ...TRANSPORT_IDS.map(protocol => `${device.id}.info.transports.${protocol}`),
      ];
      for (const id of ids) {
        if (await this.getObjectAsync(id)) {
          await this.setState(id, { val: false, ack: true });
        }
      }
    }
    const names = idle.map(device => device.id).join(", ");
    // Two levels for two situations. "Never" is what the user asked for, so it is a fact, not
    // a problem. With "Automatic" the SETTING stopped the search the moment the first device
    // was typed in — the user did not choose that, and without this line nothing tells them
    // why half their receivers went quiet.
    if ((this.config.discovery ?? "auto") === "never") {
      this.log.info(
        `${idle.length} remembered device(s) stay idle — the network search is off (${names}); their objects are kept, use the delete button on a card to remove one`,
      );
    } else {
      this.log.warn(
        `${idle.length} remembered device(s) are not running: the device list is filled and the network search is set to Automatic (${names}) — their objects are kept; set the search to Always to run them next to the devices you entered`,
      );
    }
  }

  /**
   * Arm a background search because an auto-found device is offline — the only way back to a
   * receiver that moved to another address, since it answers at the remembered one no more.
   * Throttled: a device that is merely switched off must not turn this into a scan loop, and
   * one timer covers however many devices are down.
   *
   * Two gaps: the first search after a device lost a transport comes quickly (a move is the one
   * cause a search heals); every further one while it stays gone waits the long throttle. An
   * armed timer is never shortened — the search it carries covers every device that is down.
   *
   * @param deviceId the device that just went offline (or lost a transport)
   * @param quick whether this is the first sign of an outage
   */
  private scheduleRediscovery(deviceId: string, quick = false): void {
    // Per device, not per instance: a manual device sits at an address the user typed, so there
    // is nothing to search for — it is simply off. A discovered device may have moved, and so
    // may a migrated row (nobody typed its address).
    if (this.deviceRecords.get(deviceId)?.source === "manual") {
      return;
    }
    if (!this.discovering || this.unloading || this.rediscoverTimer !== undefined) {
      return;
    }
    const receiver = this.pushReceiver;
    if (!receiver) {
      return;
    }
    const due = Math.max(
      0,
      (quick ? REDISCOVER_QUICK_INTERVAL_MS : REDISCOVER_MIN_INTERVAL_MS) - (Date.now() - this.lastRediscovery),
    );
    this.rediscoverTimer = this.setTimeout(() => {
      this.rediscoverTimer = undefined;
      this.lastRediscovery = Date.now();
      if (!this.unloading) {
        void this.discoverAdditionalDevices(receiver);
      }
    }, due);
  }

  /**
   * The shared written-definitions map of one device (see `writtenObjects`).
   *
   * @param deviceId the id-safe device id
   * @returns the map
   */
  private writtenObjectsOf(deviceId: string): Map<string, string> {
    let map = this.writtenObjects.get(deviceId);
    if (!map) {
      map = new Map<string, string>();
      this.writtenObjects.set(deviceId, map);
    }
    return map;
  }

  /**
   * Forget what was written for the device an object id belongs to — called on every delete, so a
   * deleted object is written again when a transport builds it once more.
   *
   * @param id the object id, with or without the namespace
   */
  private forgetWritten(id: string): void {
    const relative = stripNamespace(id, this.namespace);
    const dot = relative.indexOf(".");
    this.writtenObjects.get(dot < 0 ? relative : relative.slice(0, dot))?.clear();
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
   * Take an identity a transport, the search or the stored object reported for a running device:
   * merge it into the record (the search matches on it), persist it at the device object
   * (`native.identity`, what the delete action reads), and — for a discovered device — write it
   * into the discovery store so the next start's search knows it before any transport answers.
   *
   * @param deviceId the id-safe device id
   * @param identity what was learned, if anything
   */
  private learnIdentity(deviceId: string, identity: DeviceIdentity | undefined): void {
    const record = this.deviceRecords.get(deviceId);
    if (!record || !identity) {
      return;
    }
    const merged = mergeIdentity(record.identity, identity);
    if (JSON.stringify(merged) === JSON.stringify(record.identity)) {
      return;
    }
    record.identity = merged;
    this.persistDeviceNative(deviceId, { identity: merged });
    if (record.source === "discovered" && merged) {
      this.rememberIdentity(deviceId, merged).catch((e: unknown) =>
        this.log.debug(`${deviceId}: could not store the identity (${errorMessage(e)})`),
      );
    }
  }

  /**
   * Carry a learned identity into the discovery store's record.
   *
   * @param deviceId the id-safe device id
   * @param identity the identity to store
   */
  private async rememberIdentity(deviceId: string, identity: DeviceIdentity): Promise<void> {
    const store = discoveredStoreDeps(this);
    const known = await readDiscovered(store);
    const entry = known.find(device => device.id === deviceId);
    if (!entry || JSON.stringify(entry.identity) === JSON.stringify(identity)) {
      return;
    }
    entry.identity = identity;
    await writeDiscovered(store, known);
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
    this.removed.add(deviceId);
    // A setup still writing the header would recreate what the delete below removes.
    await this.starting.get(deviceId)?.catch(() => undefined);
    const supervisor = this.supervisorById.get(deviceId);
    this.stopDevice(deviceId);
    // `stopDevice` marks the supervisor closed, but an attempt already past its await keeps
    // building the object tree — deleted underneath it, everything it writes afterwards
    // survives as an orphan. Wait for it; the cap is a safety net, every transport attempt ends
    // by its own timeout well within it.
    await this.awaitSettled(supervisor);
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
    const resolved = this.resolvedHosts.get(deviceId);
    if (resolved) {
      this.knownDeviceIps.delete(resolved);
      this.resolvedHosts.delete(deviceId);
    }
    this.deviceRecords.delete(deviceId);
    this.deviceConnected.delete(deviceId);
    this.readyDevices.delete(deviceId);
    this.failedOnce.delete(deviceId);
    this.warnedElsewhere.delete(deviceId);
    this.liveTransportCount.delete(deviceId);
    this.reportedMissing.delete(deviceId);
    this.idDecided.delete(deviceId);
    this.idChecked.delete(deviceId);
    // Everything else this device left behind goes with it. A cache that survives makes the
    // adapter believe it already did the work: re-adding the SAME id finds the icon cache
    // intact, `updateDeviceIcon` bails on the identity check, and the card keeps the default
    // silhouette `ensureDeviceHeader` seeds — a soundbar shows a receiver until the next start.
    this.deviceIcons.delete(deviceId);
    this.deviceLabels.delete(deviceId);
    this.deviceObjectWrites.delete(deviceId);
    this.writtenObjects.delete(deviceId);
    this.lastModel.delete(deviceId);
    this.storedModels.delete(deviceId);
    this.profiles.delete(deviceId);
    this.forgetUnder(this.knownDatapoints, deviceId);
    this.forgetUnder(this.storedStates, deviceId);
    this.forgetUnder(this.storedBounds, deviceId);
    this.forgetUnder(this.touchedThisRun, deviceId);
    this.forgetUnder(this.recordedThisRun, deviceId);
    this.forgetUnder(this.declaredAbsent, deviceId);
    this.forgetUnder(this.volumeScales, deviceId);
    this.forgetUnder(this.volumeDefs, deviceId);
    this.volumePercent.delete(deviceId);
    // Counted like the datapoint balance — state objects only, not the channels and the device
    // node around them — so the one line below says what the delete took (krobi 2026-09-22).
    let removed = 0;
    try {
      const prefix = `${this.namespace}.${deviceId}.`;
      const listing = await this.getAdapterObjectsAsync();
      removed = Object.entries(listing).filter(([id, obj]) => id.startsWith(prefix) && obj?.type === "state").length;
    } catch (e) {
      this.log.debug(`${deviceId}: could not count its datapoints before the delete (${errorMessage(e)})`);
    }
    try {
      await this.delObjectAsync(deviceId, { recursive: true });
      this.log.info(`${deviceId}: device deleted — removed ${removed} datapoint(s)`);
    } catch (e) {
      this.log.warn(`could not remove the object tree of "${deviceId}" (${errorMessage(e)})`);
    }
    this.writeState("info.connection", [...this.deviceConnected.values()].some(Boolean));
    this.writeDeviceOverview();
    // The last device gone: nothing else would arm a search any more (audit 2026-09-24, A11).
    this.scheduleIdleSearch();
  }

  /**
   * The device manager admitted deleted devices again: forget the session's deletes for them
   * (`removed` would otherwise keep them out until the restart) and search now — with `always`
   * and every device online no search would run by itself before the next restart.
   *
   * @param lifted the ids the user ticked
   */
  public rediscoverNow(lifted: readonly string[]): void {
    for (const id of lifted) {
      this.removed.delete(id);
    }
    const receiver = this.pushReceiver;
    if (!this.discovering && !this.unloading && lifted.length > 0) {
      // The user admitted a device and nothing will look for it — say so instead of nothing
      // (audit 2026-09-24, A18).
      this.log.info(
        `${lifted.join(", ")}: admitted again — the network search is off; add it by hand or set the search to Always`,
      );
      return;
    }
    if (!this.discovering || !receiver || this.unloading) {
      return;
    }
    // A search the user asked for is an event, not a poll: say what it looks for, and — when
    // that device is not there — that the admission holds and what brings it back.
    this.log.info(`searching the network for ${lifted.join(", ")}`);
    const before = new Set(this.deviceRecords.keys());
    void this.discoverAdditionalDevices(receiver).then(() => {
      // A device deleted under 2.x comes back under its 3.0.0 id, not the one it was deleted by —
      // a device that appeared in this search is the answer, whatever its id.
      const appeared = [...this.deviceRecords.keys()].some(id => !before.has(id));
      for (const id of lifted) {
        if (!this.deviceRecords.has(id) && !appeared) {
          this.log.info(
            `${id}: not on the network right now — admitted again; it is added when it announces itself or the next search sees it`,
          );
        }
      }
    });
  }

  /**
   * While NO device runs, keep searching on the long throttle. Nothing else would: the
   * rediscovery is armed by a device that went offline, and with none running only the NOTIFY
   * listener is left — a device switched on after the start, or admitted again while it was
   * off, would wait for the next restart if its announcement was missed.
   */
  private scheduleIdleSearch(): void {
    if (this.deviceRecords.size > 0 || !this.discovering || this.unloading || this.rediscoverTimer !== undefined) {
      return;
    }
    const receiver = this.pushReceiver;
    if (!receiver) {
      return;
    }
    this.rediscoverTimer = this.setTimeout(() => {
      this.rediscoverTimer = undefined;
      this.lastRediscovery = Date.now();
      if (!this.unloading) {
        void this.discoverAdditionalDevices(receiver);
      }
    }, REDISCOVER_MIN_INTERVAL_MS);
  }

  /**
   * Wait for a supervisor's running connection attempt, capped so an unforeseen hang can
   * never block a delete for good.
   *
   * @param supervisor the device's supervisor, if it still had one
   */
  private async awaitSettled(supervisor: DeviceSupervisor | undefined): Promise<void> {
    if (!supervisor) {
      return;
    }
    let cap: ioBroker.Timeout | undefined;
    const capped = new Promise<void>(resolve => {
      cap = this.setTimeout(resolve, REMOVE_SETTLE_CAP_MS);
    });
    try {
      await Promise.race([supervisor.settled(), capped]);
    } catch {
      // The attempt's own failure is reported where it happened; the delete goes on.
    } finally {
      this.clearTimeout(cap);
    }
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
    if (connected) {
      this.failedOnce.delete(deviceId);
      this.reportedMissing.delete(deviceId);
      // On EVERY connect, not only the first: a reconnect over another transport can bring
      // the first serial this device ever reported.
      this.learnIdentity(deviceId, this.profiles.get(deviceId)?.identity());
      void this.checkIdDecision(deviceId);
    } else {
      this.failedOnce.add(deviceId);
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
    // A transport LOST is the first sign the device may have moved — the quick search, now,
    // instead of after the last transport gave up and the long throttle ran out.
    const before = this.liveTransportCount.get(deviceId) ?? 0;
    this.liveTransportCount.set(deviceId, live.size);
    if (live.size < before) {
      this.scheduleRediscovery(deviceId, true);
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
   * Written through `setStateChangedAsync`: js-controller compares against the database and
   * writes only when the value or the ack flag differs. That is what keeps a failed reconnect
   * attempt (eight identical markers every minute), a 60-s XML poll, the ~200-value YNCA
   * refresh after a reconnect and the 30-s model keepalive out of the history — and it still
   * confirms a user's write, because that one sits at ack:false and the echo's ack:true IS the
   * difference (audit 2026-09-15). Every datapoint here mirrors a device state; none is a
   * periodic measurement whose fresh timestamp would be the information.
   *
   * @param id the state id (namespace-relative)
   * @param value the value to write
   */
  private writeState(id: string, value: ioBroker.StateValue): void {
    this.setStateChangedAsync(id, { val: value, ack: true }).then(
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
    // A device that was removed has no object to patch any more — a late write from its last
    // attempt would recreate the device object as a bare orphan.
    if (!this.deviceRecords.has(deviceId)) {
      return;
    }
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
   * Merge into a device object — one write after the other per device. `extendObject` reads the
   * object, merges and writes it back; two of them at the same moment each write what they read,
   * and the later one takes the earlier one's fields away. Measured in the inventory run: the id
   * mark (`native.idScheme`) and the display name written in the same instant — the mark was gone
   * on three of eight devices, a different three on each run. Every writer of a device object's
   * `common`/`native` goes through here.
   *
   * @param deviceId the device id
   * @param patch what to merge
   * @returns the write
   */
  private writeDeviceObject(deviceId: string, patch: ioBroker.PartialObject): Promise<void> {
    const previous = this.deviceObjectWrites.get(deviceId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.extendObject(deviceId, patch))
      .then(() => undefined);
    this.deviceObjectWrites.set(
      deviceId,
      next.catch(() => undefined),
    );
    return next;
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
    return this.writeDeviceObject(deviceId, { native: pending.native }).then(
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
   * @param remembered ids the discovery store still holds that are idle this run
   * @param listing the object tree as the datapoint snapshot just read it; read here when absent
   */
  private async cleanupStaleObjects(
    deviceIds: Set<string>,
    remembered: ReadonlySet<string>,
    listing?: AdapterObjects,
  ): Promise<void> {
    const allObjects = listing ?? (await this.getAdapterObjectsAsync());
    const existing = Object.keys(allObjects);
    // Only the DELETION widens to the remembered ids. The two passes below stay on the
    // running set on purpose: an idle device is not being written to at all this run, so
    // neither a rename nor a switched-off group has any business reaching into its tree.
    const stale = staleObjects(existing, deviceIds, this.namespace, remembered);
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
      this.forgetWritten(fullId);
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
   * "Run" is a PROCESS start: an id recorded during this process waits for the next one, however
   * many balance passes this one makes. A datapoint a transport's declaration proves absent
   * ({@link declaredAbsent}) needs no second start — the declaration is no standby answer.
   */
  private async purgeNeverFilled(): Promise<void> {
    const candidates: string[] = [];
    for (const deviceId of this.readyDevices) {
      const profile = this.profiles.get(deviceId);
      const declared = [...this.declaredAbsent].some(id => id.startsWith(`${deviceId}.`));
      if (profile?.purgeVersion !== this.version || (profile?.pendingPurge.length ?? 0) > 0 || declared) {
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
      const confirmed = seenNow.filter(
        id => (recorded.has(id) && !this.recordedThisRun.has(id)) || this.declaredAbsent.has(id),
      );
      for (const id of confirmed) {
        this.forgetWritten(id);
        try {
          await this.delObjectAsync(id);
          purged.push(`${this.namespace}.${id}`);
        } catch {
          // already gone
        }
      }
      // Whatever is untouched THIS run and was not just deleted waits for the next process start.
      const waiting = seenNow.filter(id => !confirmed.includes(id));
      for (const id of waiting) {
        if (!recorded.has(id)) {
          this.recordedThisRun.add(id);
        }
      }
      profile?.setPendingPurge(waiting);
      profile?.markPurged(this.version ?? "");
    }
    if (purged.length > 0) {
      this.log.debug(
        `removed ${purged.length} never-filled object(s) — confirmed over two starts or declared absent by the device`,
      );
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
      this.forgetWritten(fullId);
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
    if (gone.length === 0) {
      this.storedBounds.set(id, { min: next.min, max: next.max, step: next.step });
      return;
    }
    // ⚠️ NOT the `null` write `clearStaleStates` uses. A dropdown has a neutral value — an empty
    // map — and `null` reaches it. A bound has none: the merge writes `common.max = null`, and
    // js-controller's range check then compares against it numerically, where `null` counts as 0
    // and every reading is "greater than max" (`reference_attribut_entfernen_ohne_setobject`, and
    // the merge semantics measured in `reference_iobroker_objekt_aendern_ohne_loeschen`). The key
    // has to GO — and a key leaves an object by ONE write of a copy without it, never by deleting
    // the object and creating it again: `delObject` drops the state's VALUE and removes the id
    // from every enum, so the user's room and function assignments go with it and nothing the
    // re-create writes brings them back (fleet rule, krobi 2026-09-12; `setObject` is the
    // checker's S5054, `setForeignObject` is not).
    const object = await this.getObjectAsync(id);
    if (object?.type !== "state") {
      return;
    }
    // The READ object rides along whole — `common.custom` (the user's logging), `native` and the
    // acl survive the rewrite because nothing but the dropped bounds is left out.
    const common = { ...object.common } as ioBroker.StateCommon & Record<string, unknown>;
    for (const field of gone) {
      delete common[field];
    }
    try {
      await this.setForeignObject(`${this.namespace}.${id}`, { ...object, common });
    } catch (e) {
      // Nothing is lost — the object still stands as it was — but the stale bound stays, so it
      // belongs in the log rather than passing silently.
      this.log.debug(`${id}: could not drop the stale bound(s) ${gone.join(", ")} (${errorMessage(e)})`);
      return;
    }
    // Only a written object may advance the snapshot: remembering bounds that never reached the
    // database would keep every later run from retrying the removal.
    this.storedBounds.set(id, { min: next.min, max: next.max, step: next.step });
  }

  /**
   * Remember every datapoint that already exists, ONCE per adapter run.
   *
   * @see knownDatapoints for why the create path alone cannot answer "is this new?"
   * @param read the listing the id migration read, when it moved nothing — one read of the tree
   * @returns the object listing it read, for the cleanup that follows — undefined when the read failed
   */
  private async snapshotExistingDatapoints(read?: AdapterObjects): Promise<AdapterObjects | undefined> {
    try {
      const listing = read ?? (await this.getAdapterObjectsAsync());
      for (const [fullId, object] of Object.entries(listing)) {
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
      return listing;
    } catch (e) {
      // Without the snapshot the balance would call every datapoint new; better to stay
      // silent about it than to log a wrong number.
      this.log.debug(`could not read the existing datapoints (${errorMessage(e)}); balance line disabled`);
      this.balanceDisabled = true;
      return undefined;
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
   * merges, so a recording setting or anything else a user attached survives. Only the name and
   * the description: the manifest owns the rest of the shape, and js-controller applies it.
   */
  private async ensureInstanceInfoObjects(): Promise<void> {
    // Spelled out with LITERAL ids on purpose. A loop over a table reads more compactly, but
    // then neither a reader nor the consistency gate can see which manifest objects are
    // actually refreshed — and "the call exists" is not the same question as "the call runs
    // for THIS object". This is the one place where that distinction cost a release (2.1.1).
    await this.extendObject("info", { common: { name: tName("information") } });
    await this.extendObject("info.connection", {
      common: { name: tName("deviceOrServiceConnected"), desc: tName("descDeviceOrServiceConnected") },
    });
    await this.extendObject("info.devicesTotal", { common: { name: tName("devicesTotal") } });
    await this.extendObject("info.devicesOnline", { common: { name: tName("devicesOnline") } });
    await this.extendObject("info.devicesAllOnline", { common: { name: tName("allDevicesOnline") } });
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
    // A device that has not reported its model yet would sit in the tree without any
    // symbol — an upgraded instance shows that on every start before the first report,
    // and a device that never answers shows it for good. Seed the pictogram of the model the
    // capability profile remembers (the default silhouette without one) when there is none —
    // and ALSO when the stored one is an older adapter's drawing: the 2.9.x icons had a fixed
    // colour and a <rect> body, invisible in the dark themes, and a device that is off during
    // the update would keep that drawing until it reports its model (2.10.0, seen live). A
    // current pictogram is left alone: overwriting would flip a soundbar back to the receiver
    // default for the seconds until its model arrives.
    let icon: string | undefined;
    // Percent is a DEVICE setting since 2.9.0. A device that carries no answer yet inherits the
    // instance-wide switch 2.8.0 had, so an upgrade keeps every receiver exactly as it was, and
    // the answer is written down here so it never has to be inherited again.
    let percent = this.legacyVolumePercent;
    // The display name the adapter established for this device, remembered AT the device object.
    // Deliberately not `preserve: { common: ["name"] }`: the adapter owns names (fleet rule, krobi
    // 2026-09-02) and sparing the field would only hide who wrote it. What it must not do is fall
    // back to the bare id on every start, so the name it wrote LAST is carried in `native.label`
    // and written again — by the adapter's own record, not by leaving the field out. Both writers
    // of a display name keep that record: the label updater below and the card's edit dialog, and
    // the rank says which of them may overrule the other.
    let label: string | undefined;
    let labelRank: LabelRank = LABEL_RANK.model;
    /** A name set on purpose that the adapter cannot have written — it stays untouched. */
    let foreignName = false;
    try {
      const existing = await this.getObjectAsync(deviceId);
      const stored = existing?.common?.icon;
      if (typeof stored === "string" && CURRENT_PICTOGRAMS.has(stored)) {
        // Remembered, so a later model report of the same class writes nothing.
        this.deviceIcons.set(deviceId, stored);
      } else {
        icon = iconForModel(rememberedModel(existing?.native));
        this.deviceIcons.set(deviceId, icon);
      }
      const native = existing?.native as
        | {
            volumeAsPercent?: unknown;
            label?: unknown;
            labelRank?: unknown;
            identity?: unknown;
            idScheme?: unknown;
          }
        | undefined;
      if (native?.idScheme === ID_SCHEME) {
        this.idDecided.add(deviceId);
      }
      const model = rememberedModel(existing?.native);
      if (model) {
        this.storedModels.set(deviceId, model);
      }
      const storedIdentity = identityFrom(
        typeof native?.identity === "object" && native.identity !== null ? native.identity : {},
      );
      if (storedIdentity) {
        this.learnIdentity(deviceId, storedIdentity);
      }
      const own = native?.volumeAsPercent;
      if (typeof own === "boolean") {
        percent = own;
      }
      const shown = existing?.common?.name;
      if (typeof native?.label === "string" && native.label.length > 0) {
        label = native.label;
        labelRank = labelRankOf(native.labelRank);
      } else if (typeof shown === "string" && shown.length > 0 && shown !== deviceId) {
        // ADOPTION, once per device: an instance upgraded from 2.10.0 or earlier carries a display
        // name with NO record behind it — writing `label ?? deviceId` without this would put the
        // bare id back on the first start after the update, and a receiver that is switched off
        // would keep the id until it next reports. The rank is `user` because the tree cannot tell
        // the two sources apart any more: the stored name may be a MusicCast zone name the adapter
        // wrote, or one the owner typed into the card's dialog — and silently replacing the second
        // is the worse mistake. Every name established from here on carries its true rank.
        label = shown;
        labelRank = LABEL_RANK.user;
      } else if (shown !== undefined && typeof shown !== "string") {
        // A name that is not a plain string was set on purpose (a translation object typed into
        // the admin). The adapter only ever writes plain strings, so this is none of its own and
        // it has nothing better to put there — it writes no name at all. Same rule the label
        // updater has always followed.
        foreignName = true;
      }
      if (label !== undefined) {
        // Seeding the in-memory record is what makes the decision survive a restart: without it
        // the adapter's OWN label reads as a stranger's on the next start (neither the id nor
        // anything it remembers writing), and a device that renames itself is never followed again.
        this.deviceLabels.set(deviceId, { name: label, rank: labelRank });
      }
    } catch {
      icon = undefined;
    }
    this.volumePercent.set(deviceId, percent);
    await this.writeDeviceObject(deviceId, {
      type: "device",
      common: {
        ...(foreignName ? {} : { name: label ?? deviceId }),
        ...(icon ? { icon } : {}),
        statusStates: { onlineId: `${this.namespace}.${deviceId}.info.connection` },
      },
      // The record rides along with the name, so the adoption above happens once per device, ever.
      native: { source, volumeAsPercent: percent, ...(label !== undefined ? { label, labelRank } : {}) },
    });
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

  /**
   * The model last reported per device in THIS run. The YNCA keepalive reports the model every
   * 30 s; the icon and name updaters behind it read the device object each time, so they run on
   * the first report of a run and on a model change only. Per run, not from the database: a new
   * adapter version with new pictograms must reach every existing device once.
   */
  private readonly lastModel = new Map<string, string>();
  /**
   * The model each device object remembers from an earlier run (`native.model`, or its profile) —
   * what `orphanOfModel` needs for a device that is off and whose profile a schema bump emptied.
   */
  private readonly storedModels = new Map<string, string>();

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
      // A translation object is a name somebody gave the device on purpose — the adapter only
      // ever writes plain strings, so it cannot be one of its own placeholders.
      if (current !== undefined && typeof current !== "string") {
        return;
      }
      const label = nextDeviceLabel(current, deviceId, candidate, rank, own?.name, own?.rank);
      if (label === undefined) {
        return;
      }
      // The marker rides in the SAME write as the name: a name in the tree without the record
      // behind it would read as a stranger's on the next start, and `ensureDeviceHeader` would
      // put the bare id back (that is the defect the record exists to close).
      await this.writeDeviceObject(deviceId, { common: { name: label }, native: { label, labelRank: rank } });
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
      await this.writeDeviceObject(deviceId, { common: { icon } });
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
    // The old key has to GO with the migration: js-controller never removes a native key by itself
    // (CLAUDE_PATTERNS, listen-port rule 5), and with it left in place, deleting the migrated
    // device emptied the table — and the next start migrated it again (audit 2026-09-24, A5). An
    // installation migrated by an earlier version still carries it next to its table.
    const leftover = "ip" in config || "IP" in config;
    if (!row && !leftover) {
      return;
    }
    // Fill the in-memory config first, so this run already drives the device even
    // if persisting the table below fails — persistence is a convenience for the
    // admin view, not a precondition for running.
    if (row) {
      config.devices = [row];
    }
    delete config.ip;
    delete config.IP;
    const instanceId = `system.adapter.${this.namespace}`;
    try {
      // One write of the object WITHOUT the old keys — an extend merges, it cannot remove a key.
      const instance = await this.getForeignObjectAsync(instanceId);
      if (!instance?.native) {
        return;
      }
      if (row) {
        instance.native.devices = [row];
      }
      delete instance.native.ip;
      delete instance.native.IP;
      await this.setForeignObject(instanceId, instance);
      if (row) {
        this.log.info(`carried the previous single-device config (${row.ip}) over into the device table`);
      } else {
        this.log.debug("removed the previous adapter's address key next to the device table");
      }
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
  /**
   * Remove the settings earlier releases declared ({@link NATIVE_KEY_MIGRATIONS}). The 2.8.0
   * percent switch stays while a known device has not written its own answer down yet — an idle
   * device is not written to in a run it does not take part in, so it inherits the switch the next
   * time it runs, and the key goes then. The write restarts the instance once; nothing after this
   * point binds anything that restart would leave behind.
   *
   * @param known every device of this run, running and idle
   */
  private async dropObsoleteSettings(known: readonly DeviceRecord[]): Promise<void> {
    let migrations = NATIVE_KEY_MIGRATIONS;
    if (this.legacyVolumePercent) {
      for (const device of known) {
        const own = ((await this.getObjectAsync(device.id))?.native as { volumeAsPercent?: unknown } | undefined)
          ?.volumeAsPercent;
        if (typeof own !== "boolean") {
          migrations = migrations.filter(m => !("drop" in m && m.drop === "volumeAsPercent"));
          break;
        }
      }
    }
    await migrateNativeKeys(this, migrations, errorMessage);
  }

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
        await this.setForeignObject(`system.adapter.${this.namespace}`, obj);
        this.log.info("migrated group_zones setting into group_multiroom");
      }
    } catch (e) {
      this.log.warn(`could not persist group_zones migration (${errorMessage(e)})`);
    }
  }

  /**
   * The object and state calls a tree move needs, over this adapter.
   *
   * @returns the move's dependencies
   */
  private moveDeps(): DeviceMoveDeps {
    return {
      namespace: this.namespace,
      objects: () => this.getAdapterObjectsAsync(),
      states: pattern => this.getForeignStatesAsync(pattern),
      setObject: async (id, obj) => {
        await this.setForeignObject(id, obj);
      },
      extendObject: async (id, patch) => {
        await this.extendForeignObjectAsync(id, patch);
      },
      setState: async (id, state) => {
        await this.setForeignStateAsync(id, state);
      },
      aliases: () => this.getForeignObjectsAsync("alias.*", "state"),
      setForeignObject: async (id, obj) => {
        await this.setForeignObject(id, obj);
      },
    };
  }

  /**
   * The one-time move of 3.0.0: every device an earlier version created under a name-derived id
   * (`B_ro` for "Büro", `Yamaha_RX-V685` for a factory name — and a second device of the same
   * name was skipped) moves to its model and the last four characters of its serial
   * (`wx-030-2b3c`, see `serialId`) as soon as both are known. Runs on every start, before anything
   * reads an id; a device whose id is final carries `native.idScheme` and costs one comparison.
   *
   * Three kinds of device: one whose model and serial the stored tree knows moves right here; one
   * whose model or serial the tree does not know yet (switched off since the update, or never asked
   * before 2.13.0 kept the model) is decided at its first contact ({@link checkIdDecision} writes the
   * journal) and moves at the next start; one whose journal says a move is due is moved here.
   *
   * The order keeps every step repeatable: the journal (`native.movingTo` at the OLD device object)
   * first, then the copy, then the table rows and the discovery store, and the old tree last — a
   * start that finds the journal again finds the copy complete and only finishes what is left.
   *
   * @returns the object listing it read when nothing moved (the datapoint snapshot reuses it)
   */
  private async migrateDeviceIds(): Promise<AdapterObjects | undefined> {
    try {
      const listing = await this.getAdapterObjectsAsync();
      const store = discoveredStoreDeps(this);
      const discovered = await readDiscovered(store);
      const rows = Array.isArray(this.config.devices) ? (this.config.devices as unknown[]) : [];
      const known = new Set([...parseDevices(rows).map(device => device.id), ...discovered.map(device => device.id)]);
      const devices = new Map<string, ioBroker.Object>();
      const prefix = `${this.namespace}.`;
      for (const [fullId, obj] of Object.entries(listing)) {
        const id = fullId.slice(prefix.length);
        if (obj?.type === "device" && !id.includes(".") && id !== "info") {
          devices.set(id, obj);
        }
      }
      const taken = new Set([...devices.keys(), ...known]);
      const moves: Array<{ from: string; to: string }> = [];
      const candidates: Array<{ id: string; model?: string; identity?: DeviceIdentity }> = [];
      for (const [id, obj] of devices) {
        const native = (obj.native ?? {}) as Record<string, unknown>;
        const journal = native.movingTo;
        if (typeof journal === "string" && /^[A-Za-z0-9\-_]+$/.test(journal) && journal !== id) {
          moves.push({ from: id, to: journal });
          taken.add(journal);
          continue;
        }
        // Only a device this instance runs: a tree the cleanup is about to delete is not moved first.
        if (native.idScheme === ID_SCHEME || !known.has(id)) {
          continue;
        }
        const record = discovered.find(device => device.id === id);
        candidates.push({
          id,
          model: rememberedModel(native) ?? record?.model,
          identity: this.storedIdentityOf(id, native, record),
        });
      }
      // By serial, so two devices of one model whose serials end alike get the same ids on every
      // installation and every start — the listing order of the object database is no order.
      candidates.sort((a, b) => (a.identity?.serial ?? a.id).localeCompare(b.identity?.serial ?? b.id));
      for (const { id, model, identity } of candidates) {
        const target = serialId(model, identity, new Set([...taken].filter(other => other !== id)));
        if (!target) {
          continue; // decided at its first contact — checkIdDecision
        }
        if (target === id) {
          await this.extendObject(id, { native: { idScheme: ID_SCHEME } });
          continue;
        }
        if (taken.has(target)) {
          this.log.warn(`${id}: its device id would be ${target}, which another device holds — it keeps ${id}`);
          continue;
        }
        taken.add(target);
        moves.push({ from: id, to: target });
      }
      if (moves.length === 0) {
        // Nothing moved: the tree is still what was read — the datapoint snapshot takes this listing.
        return listing;
      }
      const done: Array<{ from: string; to: string; report: MoveReport }> = [];
      for (const move of moves) {
        try {
          await this.extendObject(move.from, { native: { movingTo: move.to } });
          done.push({ ...move, report: await copyDeviceTree(this.moveDeps(), move.from, move.to) });
        } catch (e) {
          // The journal stays: the next start tries again, and this run keeps the device where it was.
          this.log.warn(
            `${move.from}: could not move to ${move.to} (${errorMessage(e)}) — tried again on the next start`,
          );
        }
      }
      if (done.length === 0) {
        return undefined;
      }
      const renamed = new Map(done.map(move => [move.from, move.to]));
      const nextDiscovered = discovered.map(record =>
        renamed.has(record.id) ? { ...record, id: renamed.get(record.id)! } : record,
      );
      if (nextDiscovered.some((record, index) => record !== discovered[index])) {
        await writeDiscovered(store, nextDiscovered);
      }
      await this.renameTableRows(rows, renamed);
      for (const move of done) {
        move.report.enums = await this.deleteMovedTree(move.from, move.to);
        const { datapoints, enums, aliases, history } = move.report;
        const carried = [
          ...(enums > 0 ? [`${enums} room/function entr${enums === 1 ? "y" : "ies"}`] : []),
          ...(aliases > 0 ? [`${aliases} alias(es)`] : []),
        ];
        this.log.info(
          `${move.from}: device id is now ${move.to} — moved ${datapoints} datapoint(s)` +
            `${carried.length > 0 ? ` with ${carried.join(", ")}` : ""}` +
            `${history > 0 ? `; ${history} recording(s) keep their history` : ""}`,
        );
      }
    } catch (e) {
      this.log.error(`moving the device ids failed (${errorMessage(e)}) — the devices run under their current ids`);
    }
    return undefined;
  }

  /**
   * Delete a moved device's old tree and carry its room and function assignments to the new ids —
   * through the fleet helper, in its order: the memberships are read first, the tree is deleted, the
   * new ids are written last. The delete removes the old ids from every enum, written back from the
   * adapter's enum cache, and would take away an id written before it.
   *
   * @param from the old device id
   * @param to the new device id
   * @returns how many room/function entries now list the moved objects
   */
  private async deleteMovedTree(from: string, to: string): Promise<number> {
    const fromFull = `${this.namespace}.${from}`;
    const toFull = `${this.namespace}.${to}`;
    const members = enumMembersUnder(await this.getForeignObjectsAsync("enum.*", "enum"), fromFull);
    const carried = new Set<string>();
    // One carry per moved member, nested so that every one reads before the single delete runs.
    let remove = async (): Promise<unknown> => this.delObjectAsync(from, { recursive: true });
    for (const oldId of members) {
      const inner = remove;
      const newId = movedId(oldId, fromFull, toFull)!;
      remove = async () => {
        for (const enumId of await moveWithEnums(this, oldId, newId, inner, errorMessage)) {
          carried.add(`${enumId}|${newId}`);
        }
      };
    }
    await remove();
    return carried.size;
  }

  /**
   * Point the table rows of moved devices at their new ids — in memory for this run and in the
   * instance object (whose write restarts the instance once; this run goes on with the same ids).
   * A typed row gets the new id as its name too, so a return to 2.x finds the tree it expects; a
   * row the 0.5.4 migration wrote keeps its address as the name, which is what makes it follow the
   * device (`parseDevices`).
   *
   * @param rows the rows as read
   * @param renamed old id → new id
   */
  private async renameTableRows(rows: readonly unknown[], renamed: ReadonlyMap<string, string>): Promise<void> {
    let changed = false;
    const next = rows.map(row => {
      const entry = row as { id?: unknown; name?: unknown; ip?: unknown };
      if (typeof entry.ip !== "string" || entry.ip === "") {
        return row;
      }
      const to = renamed.get(rowDeviceId({ ...entry, ip: entry.ip }));
      if (to === undefined) {
        return row;
      }
      changed = true;
      const migrated = typeof entry.name === "string" && isDottedQuad(entry.name);
      return { ...entry, id: to, ...(migrated ? {} : { name: to }) };
    });
    if (!changed) {
      return;
    }
    (this.config as unknown as Record<string, unknown>).devices = next;
    await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, { native: { devices: next } });
  }

  /**
   * Everything a stored tree knows about who the device is: the identity the transports learned
   * (`native.identity`), the one in the capability profile, and the discovery record's.
   *
   * @param deviceId the device id
   * @param native the device object's native part
   * @param record its discovery record, if it has one
   * @returns the identity, or undefined
   */
  private storedIdentityOf(
    deviceId: string,
    native: Record<string, unknown>,
    record: DeviceRecord | undefined,
  ): DeviceIdentity | undefined {
    const stored =
      typeof native.identity === "object" && native.identity !== null ? identityFrom(native.identity) : undefined;
    const profile = new DeviceProfileStore(deviceId, native, {
      adapterVersion: this.version ?? "",
      now: () => new Date().toISOString(),
      persist: () => undefined,
    }).identity();
    return mergeIdentity(mergeIdentity(record?.identity, stored), profile);
  }

  /**
   * Decide a device's id at its first contact — for a device the start could not decide (it never
   * told its identity before, or it was switched off during the update). Once per run and device.
   *
   * With model and serial known the id is `serialId` (`wx-030-2b3c`); a device that tells its model
   * but no serial after a whole connect — a YNCA receiver whose XML server does not answer — is
   * known by its model alone (`modelId`, `rx-v473`). When that differs from the current id the
   * journal is written at the device object, and the move runs at the next start of the instance,
   * before any device connects (`migrateDeviceIds`). The adapter never restarts itself for it: a
   * move that fails at the start would otherwise restart the instance on every connect.
   *
   * @param deviceId the device that just connected
   */
  private async checkIdDecision(deviceId: string): Promise<void> {
    if (this.idDecided.has(deviceId) || this.idChecked.has(deviceId) || this.unloading) {
      return;
    }
    try {
      const record = this.deviceRecords.get(deviceId);
      const model = this.rememberedModelOf(deviceId) ?? record?.model;
      if (!record || !model) {
        return; // nothing to decide on yet — the next connect asks again
      }
      this.idChecked.add(deviceId);
      const identity = mergeIdentity(record.identity, this.profiles.get(deviceId)?.identity());
      // Every device id in use — the running ones and every device object, an idle one included.
      const objects = await this.getForeignObjectsAsync(`${this.namespace}.*`, "device");
      const others = new Set(
        [...this.deviceRecords.keys(), ...Object.keys(objects).map(id => stripNamespace(id, this.namespace))].filter(
          id => id !== deviceId,
        ),
      );
      const target = serialId(model, identity, others) ?? modelId(model, others);
      if (target === undefined || target === deviceId) {
        this.idDecided.add(deviceId);
        await this.writeDeviceObject(deviceId, { native: { idScheme: ID_SCHEME } });
        return;
      }
      if (this.deviceRecords.has(target) || (await this.getObjectAsync(target))) {
        this.log.warn(
          `${deviceId}: its device id would be ${target}, which another device holds — it keeps ${deviceId}`,
        );
        return;
      }
      await this.writeDeviceObject(deviceId, { native: { movingTo: target } });
      this.log.info(`${deviceId}: the device told who it is — its objects move to ${target} at the next start`);
    } catch (e) {
      this.log.debug(`${deviceId}: deciding its device id failed (${errorMessage(e)}) — tried again on the next start`);
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
   * @param yncaSubunitCache per-device cache of the YNCA AVAIL probe (skips the probe on reconnects)
   * @param probeMemory per-device memory for constant device answers (skips re-asking on reconnects)
   * @param signal aborted when the device's supervisor is closed while this attempt runs
   * @param pushLiveness whether the device's MusicCast events arrive (held per device)
   * @returns a connection handle, or null when no transport connected
   */
  private attemptDevice(
    device: DeviceRecord,
    pushReceiver: YxcPushReceiver,
    knownDeviceIps: Set<string>,
    yncaSubunitCache: YncaSubunitCache,
    probeMemory: ProbeMemory,
    signal?: AbortSignal,
    pushLiveness?: PushLiveness,
  ): Promise<ConnectionHandle | null> {
    // Whether this attempt may still write. A delete or a move closes the supervisor (which aborts
    // the signal) while its attempt can still be sweeping; what it wrote afterwards survived as an
    // orphan tree, and an attempt finishing during unload raised the protocol flags again (audit
    // 2026-09-24, A3).
    const alive = (): boolean => !signal?.aborted && !this.unloading;
    return attemptDevice(
      device,
      {
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
          if (!alive()) {
            return;
          }
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
          await this.writePresented(id, def);
          if (def.type === "state") {
            this.noteDatapointCreated(id);
            this.touchedThisRun.add(id);
          }
        },
        setStateAck: (id, value) => {
          if (!alive()) {
            return;
          }
          // Same group gate as upsertObject, so a switched-off group seeds no orphan value either.
          if (!isGroupEnabled(id.slice(id.indexOf(".") + 1), this.config as unknown as Record<string, unknown>)) {
            return;
          }
          this.writeState(id, this.volumeAsShown(id, value));
          // A model report also decides the device-class icon on the device node — and, for a
          // device still carrying the ip it was migrated with, its readable name.
          if (id.endsWith(".info.model") && typeof value === "string" && value.length > 0) {
            const reporting = id.slice(0, id.indexOf("."));
            if (this.lastModel.get(reporting) !== value) {
              this.lastModel.set(reporting, value);
              if (this.storedModels.get(reporting) !== value) {
                this.storedModels.set(reporting, value);
                this.persistDeviceNative(reporting, { model: value });
              }
              void this.updateDeviceIcon(reporting, value);
              void this.updateDeviceLabel(reporting, value, LABEL_RANK.model);
              // YNCA reports the model in its sweep, AFTER the connect report — the id is decided
              // now. Only for a connected device: by then every transport of the attempt has told
              // its serial, so a model arriving early can never pass for "no serial".
              if (this.deviceConnected.get(reporting) === true) {
                void this.checkIdDecision(reporting);
              }
            }
          }
        },
        onDeviceName: name => {
          if (alive()) {
            void this.updateDeviceLabel(device.id, name, LABEL_RANK.deviceName);
          }
        },
        onDeclaredAbsent: ids => {
          if (alive()) {
            for (const id of ids) {
              this.declaredAbsent.add(`${device.id}.${id}`);
            }
          }
        },
        timers: {
          schedule: (handler, ms) => (this.unloading ? undefined : this.setTimeout(handler, ms)),
          cancel: handle => this.clearTimeout(handle),
        },
        registerPush: (ip, onPush, deviceId) => pushReceiver.register(ip, onPush, deviceId),
        pushActive: () => pushReceiver.isListening(),
        pushLiveness,
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
        writtenObjects: this.writtenObjectsOf(device.id),
        onTransports: names => {
          if (alive()) {
            this.setTransports(device.id, names);
          }
        },
        knownDeviceIps,
      },
      signal,
    );
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
    if (value === null && state.val !== null) {
      this.log.debug(`${relative}: percent write "${String(state.val)}" is not a number — dropped`);
      return;
    }
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
      this.ssdpListener?.close();
      this.ssdpListener = undefined;
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
   * Auto-discovery at start: with nothing to run yet, scan the network now and return the finds;
   * with remembered devices or table rows, return the remembered ones and leave the search to
   * the background (see discoverAdditionalDevices). XML/pre-2010 receivers do not answer SSDP
   * and never appear here.
   *
   * @param configuredCount how many rows the device table holds
   * @returns the device records to run this session
   */
  private async autoDiscover(configuredCount: number): Promise<DeviceRecord[]> {
    const store = discoveredStoreDeps(this);
    const remembered = await readDiscovered(store);
    // The exclusion list rules here too, not only over fresh finds: the delete action takes the
    // record out of this file, but that write swallows its errors — a device recorded as excluded
    // may still be remembered, and running it from here would undo the delete on the next start.
    const ignored = await readIgnored(ignoredStoreDeps(this));
    const excluded = await readExcluded(excludedStoreDeps(this));
    const known = remembered.filter(device => !isExcluded(ignored, excluded, device));
    if (known.length !== remembered.length) {
      await writeDiscovered(store, known);
    }
    if (known.length > 0 || configuredCount > 0) {
      // Remembered devices — and the table's rows — start NOW: the network search used to gate
      // every restart by its collect window although the devices were already known. It still
      // runs, in the background, to pick up newcomers and moved devices. Behind the running
      // rows on purpose: a find is read against the RUNNING set (a table row's identity, its
      // offline state), and a search that ran before the rows would take a moved row for a
      // stranger and start it a second time.
      // Routine, so debug (see the configured-devices line in onReady): only a device that
      // answers earns an info line, its own "ready".
      this.log.debug(
        known.length > 0
          ? `connecting ${known.length} remembered device(s); the network search runs in the background`
          : "the network search runs in the background, behind the configured devices",
      );
      return known;
    }
    this.log.info("auto-discovery via SSDP (older XML-only devices must be added manually)");
    const merged = await this.runDiscovery();
    // The line above announced the search at info — its result belongs at the same level, or
    // the log reads "still searching" for good (krobi 2026-09-22).
    this.log.info(
      merged.length > 0
        ? `network search finished — found ${merged.length} device(s)`
        : "network search finished — no Yamaha device answered (older XML-only devices must be added by hand)",
    );
    return merged;
  }

  /**
   * Search the network and absorb what it found (`absorbFinds`). Shared by the blocking
   * first-setup path and the background search.
   *
   * @returns the device records the search established
   */
  private async runDiscovery(): Promise<DeviceRecord[]> {
    const found = await this.searchNetwork();
    return this.serializedMerge(() => this.absorbFinds(found));
  }

  /**
   * Search the network — the half of a discovery that may run while a merge is in flight.
   *
   * @returns what answered
   */
  private async searchNetwork(): Promise<DiscoveredDevice[]> {
    // Every search counts against the throttle, whoever asked for it — otherwise the first
    // offline device would fire another one right behind the start-up search.
    this.lastRediscovery = Date.now();
    let found: DiscoveredDevice[] = [];
    try {
      found = await discoverYamaha({
        search: (target, ms) => this.ssdpSearch(target, ms),
        fetch: url => this.fetchUrl(url),
        log: { debug: message => this.log.debug(message), warn: message => this.log.warn(message) },
      });
    } catch (e) {
      this.log.warn(`auto-discovery scan failed, using the remembered devices: ${errorMessage(e)}`);
    }
    return found;
  }

  /**
   * The model the profile remembers for a running device — a seam for the tests.
   *
   * @param deviceId the id-safe device id
   * @returns the model name, or undefined
   */
  private rememberedModelOf(deviceId: string): string | undefined {
    return this.profiles.get(deviceId)?.model() ?? this.storedModels.get(deviceId);
  }

  /**
   * The one migrated device a stranger of this model may be: proven offline, without a learned
   * identity, and the only such one. A migrated row is the single device of the previous adapter — the
   * model is proof enough there. Two of them are none (nothing says which one moved), and a
   * discovered device never qualifies: it carries its identity from its first search on.
   *
   * @param model the model the find advertises
   * @returns the orphan, or undefined
   */
  private orphanOfModel(model: string | undefined): DeviceRecord | undefined {
    if (!model) {
      return undefined;
    }
    const orphans = [...this.deviceRecords.values()].filter(
      record =>
        record.source === "migrated" &&
        !record.identity &&
        // Proven offline: an attempt failed and none succeeded since — a row still on its first
        // attempt is not offline, it is slow.
        this.failedOnce.has(record.id) &&
        this.deviceConnected.get(record.id) === false &&
        this.rememberedModelOf(record.id) === model,
    );
    if (orphans.length !== 1) {
      if (orphans.length > 1) {
        this.log.debug(
          `${orphans.length} migrated ${model} devices are offline without identity — a find cannot be assigned to one of them`,
        );
      }
      return undefined;
    }
    return orphans[0];
  }

  /**
   * Merge what a search (or a single NOTIFY probe) found with the remembered devices, keep the
   * user's decisions in force, persist the result, and hand back what the running set has to
   * be reconciled with. The one path for every find, however it arrived.
   *
   * Against the RUNNING set the finds are read three ways: a find at a table row's own address
   * teaches that row its identity; a find whose identity is a MIGRATED row's, at another
   * address, is that row moved (it follows the device — nobody typed its address); a find whose
   * identity is a MANUAL row's, elsewhere, is said once and left alone (the typed address is
   * what the user wants). A stranger of a model an offline, identity-less migrated row remembers
   * is that row too, when it is the only such row (`orphanOfModel`).
   *
   * @param found what the network answered
   * @returns the records to reconcile: new/remembered discovered devices, plus moved table rows
   */
  private async absorbFinds(found: readonly DiscoveredDevice[]): Promise<DeviceRecord[]> {
    const store = discoveredStoreDeps(this);
    const known = await readDiscovered(store);
    const merged = mergeDiscovered(
      known,
      [...found],
      (dropped, takenId) =>
        this.warnSearchOnce(
          `collision|${dropped}|${takenId}`,
          `discovered device "${dropped}" skipped — its address belongs to device "${takenId}"`,
        ),
      // A new find never takes an id a table row or a running device holds.
      new Set([...parseDevices(this.config.devices).map(device => device.id), ...this.deviceRecords.keys()]),
    );
    const running = [...this.deviceRecords.values()];
    // Whether a record sits at an address — its typed one, or what its typed hostname resolves to.
    const at = (record: DeviceRecord, ip: string): boolean =>
      record.ip === ip || this.resolvedHosts.get(record.id) === ip;
    for (const device of found) {
      const own = running.find(record => record.source !== "discovered" && at(record, device.ip));
      if (own && device.identity) {
        this.learnIdentity(own.id, device.identity);
      }
    }
    // Devices the user deleted from the card list stay out — otherwise the next search simply
    // undoes the delete: by id (the plain list), by identity or by the address they were deleted
    // at (`excluded.json`), and — for a delete that happened while THIS search was running — by
    // the session's `removed` set. So do the ones that live in the device table: a receiver the
    // user gave a fixed address and entered by hand would otherwise come back as a SECOND card,
    // and the store would carry the found address back over the typed one (`mergeDiscovered`
    // updates a known id's address). Both the id and the address are matched — the search reads
    // the name off the device, the user typed their own, so the same receiver can carry two ids.
    const ignored = await readIgnored(ignoredStoreDeps(this));
    const excluded = await readExcluded(excludedStoreDeps(this));
    const manual = parseDevices(this.config.devices);
    const manualIds = new Set(manual.map(device => device.id));
    const manualIps = new Set(manual.flatMap(device => [device.ip, this.resolvedHosts.get(device.id) ?? device.ip]));
    // A device deleted under 2.x is on the plain list by the id 2.x derived from its advertised
    // name — a find gets its id by the 3.0.0 rule now, so that one is checked too.
    const legacyIdAt = new Map(found.map(find => [find.ip, sanitizeId(find.name || find.ip)]));
    const moved: DeviceRecord[] = [];
    const kept = merged.filter(device => {
      const legacyId = legacyIdAt.get(device.ip);
      if (
        this.removed.has(device.id) ||
        isExcluded(ignored, excluded, device) ||
        (legacyId !== undefined && legacyId !== device.id && ignored.includes(legacyId)) ||
        manualIds.has(device.id) ||
        manualIps.has(device.ip)
      ) {
        return false;
      }
      const twin = running.find(
        record => record.source !== "discovered" && sameDevice(record.identity, device.identity),
      );
      if (twin) {
        if (at(twin, device.ip)) {
          return false;
        }
        if (twin.source === "migrated") {
          moved.push({
            ...twin,
            ip: device.ip,
            identity: mergeIdentity(twin.identity, device.identity),
            services: device.services,
          });
          return false;
        }
        if (this.warnedElsewhere.get(twin.id) !== device.ip) {
          this.warnedElsewhere.set(twin.id, device.ip);
          this.log.warn(
            `${twin.id}: the device answers at ${device.ip} now, the device table says ${twin.ip} — it stays at the typed address; edit the card to move it`,
          );
        }
        return false;
      }
      if (!known.some(record => record.id === device.id)) {
        const orphan = this.orphanOfModel(found.find(find => find.ip === device.ip)?.model);
        if (orphan) {
          moved.push({ ...orphan, ip: device.ip, identity: device.identity, services: device.services });
          return false;
        }
      }
      return true;
    });
    // Two finds that both claim ONE migrated row (a mixed identity, or two devices of the orphan's
    // model): moving it to either would rewrite the table — and restart the instance — on every
    // start, alternating. Nothing moves until the finds say which one it is (audit 2026-09-24, A17).
    const claims = new Map<string, number>();
    for (const record of moved) {
      claims.set(record.id, (claims.get(record.id) ?? 0) + 1);
    }
    const ambiguous = [...claims].filter(([, count]) => count > 1).map(([id]) => id);
    for (const id of ambiguous) {
      this.log.debug(`${id}: ${claims.get(id)} devices answer for it — not moved`);
    }
    const unambiguous = moved.filter(record => !ambiguous.includes(record.id));
    // The file only changes when a device appeared, vanished or moved — while a device is
    // offline the search runs every five minutes, and it must not rewrite an identical file each
    // time. Compared on the stored form, before the records are stamped below.
    if (JSON.stringify(kept) !== JSON.stringify(known)) {
      await writeDiscovered(store, kept);
    }
    // Stamped HERE, for both callers: onReady unions the result with the device table and stamps
    // again (harmless), the background search hands its result straight to startDevice — and a
    // record without the stamp is one the rediscovery never searches for after it moved.
    return [...kept.map(device => ({ ...device, source: "discovered" as const })), ...unambiguous];
  }

  /**
   * Warn about a search problem once per key, then only at debug — see `warnedSearch`.
   *
   * @param key what identifies the problem
   * @param message the line
   */
  private warnSearchOnce(key: string, message: string): void {
    if (this.warnedSearch.has(key)) {
      this.log.debug(message);
      return;
    }
    this.warnedSearch.add(key);
    this.log.warn(message);
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
   * Whether the device that owns a datapoint presents its volume in percent.
   *
   * @param id a `<deviceId>.<relativeId>` state or object id
   * @returns true when that device's volume datapoints read 0…100 %
   */
  private percentFor(id: string): boolean {
    return this.volumePercent.get(id.slice(0, id.indexOf("."))) === true;
  }

  /**
   * Turn percent presentation on or off for ONE device, at once.
   *
   * Called from the device manager, which runs inside this process. The datapoint is rebuilt
   * before its value follows — the same order `reshapeVolume` keeps when a receiver changes the
   * scale it displays, and for the same reason: a value written against the old definition is
   * out of range and the js-controller logs it on every refresh.
   *
   * @param deviceId the id-safe device id
   * @param on whether its volume datapoints should read 0…100 %
   */
  public async setVolumePercent(deviceId: string, on: boolean): Promise<void> {
    if (this.volumePercent.get(deviceId) === on) {
      return;
    }
    this.volumePercent.set(deviceId, on);
    await this.writeDeviceObject(deviceId, { native: { volumeAsPercent: on } });
    for (const [id, def] of [...this.volumeDefs]) {
      if (!id.startsWith(`${deviceId}.`)) {
        continue;
      }
      const bounds = this.volumeScales.get(id);
      await this.writePresented(id, def);
      if (!bounds) {
        continue;
      }
      const state = await this.getStateAsync(id);
      if (typeof state?.val === "number") {
        this.writeState(id, on ? toPercent(state.val, bounds) : fromPercent(state.val, bounds));
      }
    }
  }

  /**
   * Write one object definition through the percent presentation — shared by the upsert funnel
   * and the live switch, so both produce exactly the same object.
   *
   * @param id the full object id
   * @param def the definition the coordinator produced
   */
  private async writePresented(id: string, def: ObjectDef): Promise<void> {
    const written = this.presentVolume(id, def);
    if (written.type === "state") {
      await this.clearStaleBounds(id, written.common);
    }
    await this.extendObject(id, { type: written.type, common: written.common, native: {} });
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
      this.volumeDefs.delete(id);
      if (this.percentFor(id)) {
        this.log.debug(`${id}: no declared range — keeping the device's own scale instead of percent`);
      }
      return def;
    }
    this.volumeScales.set(id, bounds);
    this.volumeDefs.set(id, def);
    return this.percentFor(id) ? asPercentObject(def) : def;
  }

  /**
   * A device value on its way into a datapoint, converted when that datapoint is in percent.
   *
   * @param id the full state id
   * @param value the value the transport reported, on the device's own scale
   * @returns the value to store
   */
  private volumeAsShown(id: string, value: boolean | number | string): boolean | number | string {
    const bounds = this.percentFor(id) ? this.volumeScales.get(id) : undefined;
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
    const bounds = this.percentFor(relativeId) ? this.volumeScales.get(relativeId) : undefined;
    if (!bounds) {
      return value;
    }
    // A number written as text ("50" from a VIS input or MQTT) is still a percentage — passed on
    // unconverted it reached a speaker as its raw step 50, 83 % of a 0…60 scale (audit 2026-09-24, D1).
    const percent = writableNumber(value);
    return percent === undefined ? null : fromPercent(percent, bounds);
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
          this.warnSearchOnce(
            `socket|${bindAddr ?? ""}`,
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
        // Collected as bytes and decoded once: a friendlyName ("Küche") split inside a character
        // became "K��che" — and a second id for the same device (audit 2026-09-24, A20).
        const body = new DeviceBody();
        res.on("data", chunk => {
          if (!body.add(chunk)) {
            // A description document is a few KB — whatever streams past the cap is not one.
            res.destroy(new Error(`description too large: ${url}`));
          }
        });
        // A connection dropped mid-body emits on the RESPONSE stream, not the request —
        // without this handler that is an unhandled error event instead of a rejection.
        res.on("error", reject);
        res.on("end", () => resolve(body.text()));
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
