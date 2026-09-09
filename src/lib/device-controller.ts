import { mergeYncaSubunits, type YncaCapabilities } from "./ynca/capability";
import { formatWireNumber } from "./catalog/value-coerce";
import { playTimeTwin } from "./catalog/play-time";
import type { ObjectDef } from "./catalog/types";
import { tName } from "./i18n";
import type { ConnectionHandle, ControllerLog } from "./controller";
import {
  SOURCE_INPUTS,
  YNCA_CATALOG,
  availGets,
  bundleGets,
  deviceInputStates,
  enumStatesFor,
  funcToEntry,
  idToEntry,
  presentYncaEntries,
  sweepGets,
  yncaCommand,
  yncaObjectsFor,
  yncaStateUpdate,
  type InputEvidence,
  type YncaEntry,
} from "./ynca/catalog";
import type { StatesResolver } from "./catalog/build-objects";
import type { YncaSubunitCache } from "./ynca/subunit-cache";
import type { CommandGate } from "./lifecycle/command-gate";
import type { ProbeMemory } from "./lifecycle/probe-memory";
import type { BrowseEngine } from "./browse/browse-engine";
import { createBrowseSurface } from "./browse/surface";
import { YNCA_BROWSE_SOURCES, YncaBrowseDriver } from "./browse/ynca-browse-driver";

// The YNCA catalog and its lookup maps are static — built once for all devices.
// SYS:MODELNAME is part of the catalog (info.model), so the sweep already covers it.
// The AVAIL probe always covers the FULL catalog (not the group-filtered one), so the
// cached subunit set reflects the device, never the current group configuration.
const FUNC_MAP = funcToEntry(YNCA_CATALOG);
const ID_MAP = idToEntry(YNCA_CATALOG);
const AVAIL_PROBE = availGets(YNCA_CATALOG);
/** The subunits the AVAIL probe asks — the set a silent subunit is judged absent against. */
const PROBED_SUBUNITS: ReadonlySet<string> = new Set(AVAIL_PROBE.map(get => get.subunit));

/**
 * Functions whose VALUE cannot change while the device runs: the 29 assignable input names
 * and the 12 scene names. They cost 41 paced reads of a targeted sweep (4.1 s at the
 * specification's mandatory 100 ms spacing) and answer the same thing every time, so
 * a reconnect reuses what the first connect learned.
 *
 * They live in the PERSISTED probe memory (the device object's `native.probeCache`), so the
 * saving survives a restart too — the freshness guard is the device identity, and a renamed
 * input heals through the background refresh, which re-reads them. (This used to be
 * documented as "per adapter run, not persisted"; that stopped being true with the
 * fast-restart rework and the comment was left behind.)
 */
const STATIC_FUNC = /^(INPNAME|SCENE\d+NAME$)/;

/** The zones whose player/input surface the controller routes (v2.0.0 player unification). */
const YNCA_ZONES: Array<{ key: string; subunit: string; prefix: string }> = [
  { key: "main", subunit: "MAIN", prefix: "" },
  { key: "zone2", subunit: "ZONE2", prefix: "multiroom.zone2." },
  { key: "zone3", subunit: "ZONE3", prefix: "multiroom.zone3." },
  { key: "zone4", subunit: "ZONE4", prefix: "multiroom.zone4." },
];

/**
 * The normalised form an INP value is looked up by: uppercase, alphanumerics only
 * ("NET RADIO" → NETRADIO, "iPod (USB)" → IPODUSB, "SIRIUS InternetRadio" → SIRIUSINTERNETRADIO).
 *
 * @param input the wire value
 * @returns the lookup key
 */
function normalizeInput(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * INP value → the player subunit it selects. Derived from the catalog's source table — ONE
 * list serves the dropdown, the presence proof and the player routing; inputs that are no
 * media player (HDMI, AV, TUNER, …) map to nothing. The hand-written table this replaces
 * routed "SiriusXM" and "SIRIUS InternetRadio" to the SIRIUS subunit (ynca-python: each has
 * its own) and carried a key (`SIRIUSIR`) no wire value ever normalised to.
 */
const INPUT_SUBUNITS: Record<string, string> = Object.fromEntries(
  SOURCE_INPUTS.filter(source => source.value !== "TUNER" && source.subunits.length > 0).map(source => [
    normalizeInput(source.value),
    source.subunits[0],
  ]),
);

/**
 * The player subunit an input selection feeds, or undefined when the input is no
 * media player.
 *
 * @param input the zone's INP value (e.g. "NET RADIO", "iPod (USB)")
 * @returns the subunit (e.g. NETRADIO), or undefined
 */
function playerSubunitForInput(input: string | undefined): string | undefined {
  if (typeof input !== "string" || input.length === 0) {
    return undefined;
  }
  return INPUT_SUBUNITS[normalizeInput(input)];
}

/**
 * A state of the flat per-zone player block: exactly one segment below `player.`.
 * ONLY these are zone-routed — multi-segment `player.*` ids (bluetooth pairing
 * status, airplay volume interlock, per-source presets) are device-global and go
 * straight to their state (2.0.0 review finding: the broad `player.` prefix check
 * silently dropped BT/AirPlay status while no zone listened to that source).
 */
const FLAT_PLAYER_ID = /^player\.[^.]+$/;

/**
 * What a zone's player block is reset to when the zone leaves its playing source
 * (clear-on-switch): metadata empty, playback Stop. Filtered to the states the
 * device actually has before emitting.
 */
const YNCA_PLAYER_CLEAR: Array<{ id: string; value: number | string | boolean }> = [
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
  { id: "player.shuffle", value: false },
];

/** Memory key for the remembered static values. */
const STATIC_KEY = "yncaStaticValues";

/** Memory key for the persisted capability shape (the fast-restart layer). */
const CAPS_KEY = "yncaCapabilities";

/**
 * Memory key for the enum values this device ever reported: subunit → function → values, in
 * the order first seen. YNCA declares no value lists, so a device's own spelling is learned
 * by observation and offered on the dropdown from then on (see `enumStatesFor`).
 */
const OBSERVED_KEY = "yncaObserved";

/**
 * The ceiling per function of the observed store. A real enum has a dozen values at most;
 * the cap only keeps a misbehaving device from growing the device object without bound.
 */
const MAX_OBSERVED_VALUES = 64;

/** The observed-values store, as persisted. */
type ObservedValues = Record<string, Record<string, string[]>>;

/**
 * Whether a remembered value carries the observed-values shape (API boundary — the
 * persisted probe memory is untrusted storage).
 *
 * @param value the remembered value
 * @returns true when usable
 */
function isObservedValues(value: unknown): value is ObservedValues {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(
    funcs =>
      typeof funcs === "object" &&
      funcs !== null &&
      !Array.isArray(funcs) &&
      Object.values(funcs).every(list => Array.isArray(list) && list.every(item => typeof item === "string")),
  );
}

/**
 * A remembered string→T record, or undefined when the memory holds something else.
 *
 * @param value the remembered value
 * @param type the expected value type of every field
 * @returns the record, or undefined
 */
function recordOf<T>(value: unknown, type: "boolean" | "string"): Record<string, T> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.values(value).every(item => typeof item === type) ? (value as Record<string, T>) : undefined;
}

/**
 * The XML `System>Config` declaration as input evidence, when the XML transport remembered
 * one for this device (the probe memory is shared by the three transports): the source
 * flags prove a source absent, the input names add an input. Absent or malformed → nothing.
 *
 * @param remembered the remembered `xmlConfig` value
 * @returns the XML half of the input evidence
 */
function xmlInputEvidence(remembered: unknown): Pick<InputEvidence, "xmlFeatures" | "xmlInputNames"> {
  const config = remembered as { features?: unknown; inputNames?: unknown } | null | undefined;
  if (typeof config !== "object" || config === null) {
    return {};
  }
  const xmlFeatures = recordOf<boolean>(config.features, "boolean");
  const xmlInputNames = recordOf<string>(config.inputNames, "string");
  return { ...(xmlFeatures ? { xmlFeatures } : {}), ...(xmlInputNames ? { xmlInputNames } : {}) };
}

/** The persisted capability shape, keyed by the device identity that validated it. */
interface CachedCapabilities {
  /** SYS MODELNAME at capture time — freshness key half 1. */
  model: string;
  /** SYS VERSION at capture time — freshness key half 2. */
  firmware: string;
  /** The captured subunit→function map (values are last-known, used for SHAPE only). */
  subunits: Record<string, Record<string, string>>;
}

/**
 * Whether a remembered value carries the cached-capabilities shape (API boundary —
 * the persisted probe memory is untrusted storage).
 *
 * @param value the remembered value
 * @returns true when usable
 */
function isCachedCapabilities(value: unknown): value is CachedCapabilities {
  const candidate = value as Partial<CachedCapabilities> | null;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof candidate.model === "string" &&
    typeof candidate.firmware === "string" &&
    typeof candidate.subunits === "object" &&
    candidate.subunits !== null
  );
}

/**
 * The functions whose presence proves a subunit really serves menus — the fields a real
 * `LISTINFO=?` answer is made of (RX-A810 reference log). See {@link YncaDeviceController.probeBrowseSubunits}.
 */
const LIST_PROOF = /^(LISTLAYER|LISTLAYERNAME|CURRLINE|MAXLINE|LINE[1-8](TXT|ATRIB))$/;

/**
 * The scenes a device declares, read from its `SCENExNAME` answers on MAIN. Used both by
 * the init and by the background refresh, so a scene renamed at the receiver reaches the
 * running session instead of waiting for the next start.
 *
 * @param subunits the swept subunit→function map
 * @param subunit the zone subunit whose scenes to read (MAIN, ZONE2 …)
 * @returns the declared scenes, lowest number first
 */
function sceneTitlesOf(
  subunits: Record<string, Record<string, string>>,
  subunit = "MAIN",
): Array<{ num: number; title: string }> {
  const answers = subunits[subunit] ?? {};
  const scenes: Array<{ num: number; title: string }> = [];
  // MAIN declares up to twelve scenes, a zone four (official lists).
  for (let n = 1; n <= (subunit === "MAIN" ? 12 : 4); n++) {
    const title = answers[`SCENE${n}NAME`];
    if (typeof title === "string" && title.length > 0) {
      scenes.push({ num: n, title });
    }
  }
  return scenes;
}

/** The subset of the YNCA client the controller uses (so tests can inject a fake). */
export interface YncaClientLike {
  /** Open the connection. */
  connect(): Promise<void>;
  /** Run the init sweep and return the device's capabilities. */
  readCapabilities(gets: Array<{ subunit: string; func: string }>): Promise<YncaCapabilities>;
  /** Send a PUT command. */
  send(subunit: string, func: string, value: string): void;
  /** Send a GET request (the browse driver reads LISTINFO with it). */
  get(subunit: string, func: string): void;
  /** Register a handler for pushed messages. */
  onMessage(handler: (message: { subunit: string; func: string; value: string }) => void): void;
  /** Register the socket-drop handler the supervisor reconnects on. */
  onDrop(handler: (reason?: Error) => void): void;
  /** Register the refusal handler for user commands the device rejects (optional in older tests). */
  onRefusal?(handler: (command: string, verdict: "restricted" | "undefined") => void): void;
  /** Start the keepalive poll — called after the init sweep, not on connect. */
  startKeepalive(): void;
  /** Close the connection synchronously. */
  close(): void;
}

export type { ControllerLog };

/** The adapter callbacks the controller drives — narrow, so no adapter mock is needed in tests. */
export interface ControllerDeps {
  /** The YNCA client for this device. */
  client: YncaClientLike;
  /** Create or update an object in the device tree. */
  upsertObject(id: string, def: ObjectDef): Promise<void>;
  /** Write a state value with ack (device-originated). */
  setStateAck(id: string, value: boolean | number | string): void;
  /** Adapter log. */
  log: ControllerLog;
  /**
   * Whether a catalog entry's datapoint group is enabled. A disabled group's entries
   * are dropped BEFORE the sweep, so their GETs are never sent (previously only the
   * object/state writes were gated and the answers thrown away). Absent = all enabled.
   */
  isEntryEnabled?(id: string): boolean;
  /**
   * Per-device cache of the AVAIL probe result, held across reconnects and restarts.
   * With a valid cache the probe phase is skipped and the targeted sweep runs directly;
   * a model/firmware mismatch after the sweep invalidates it and re-probes.
   */
  subunitCache?: YncaSubunitCache;
  /**
   * The device's command gate: every line this controller puts on the wire is already
   * paced through it, and its signal is the connection's shutdown flag (a closed gate
   * ends pending waits and stops state writes). Absent in older tests → no browsing.
   */
  gate?: CommandGate;
  /** Per-device memory for answers that stay constant while the device runs (see ProbeMemory). */
  probeMemory?: ProbeMemory;
}

/**
 * Drives one YNCA device: connect, init sweep, build the object tree, and route
 * commands both ways. Create-only — orphan cleanup and legacy migration are
 * separate, gated steps.
 */
export class YncaDeviceController implements ConnectionHandle {
  private browseDriver: YncaBrowseDriver | undefined;
  private browseEngine: BrowseEngine | undefined;
  /**
   * Write map filtered to the entries THIS device reported — claim-with-proof for
   * writes: a command is only sent with a wire function the device answered in the
   * sweep. Until the sweep ran, the unfiltered static map answers.
   */
  private writeMap: Map<string, YncaEntry> | undefined;
  /** The device's scene titles (SCENExNAME), for the recall dropdown, the list state and title writes. */
  private sceneTitles: Array<{ num: number; title: string }> = [];
  /** The zones' own scene titles (ZONEn SCENE1–4NAME), keyed by zone (`zone2` …). */
  private readonly zoneSceneTitles = new Map<string, Array<{ num: number; title: string }>>();
  /** The tuner's current band (AM/FM/DAB), for the band-dependent frequency/preset writes. */
  private tunerBand = "";
  /** Whether the device carries the DAB subunit (its FM half shares the flat tuner ids). */
  private hasDab = false;
  /** Whether the device carries the HD Radio subunit (US models; its AM/FM half shares the flat tuner ids). */
  private hasHdRadio = false;
  /** The entries THIS device reported — the per-subunit lookup behind the player routing. */
  private presentEntries: YncaEntry[] = [];
  /** Each zone's currently selected input (INP), for the player routing (v2.0.0). */
  private readonly zoneInputs = new Map<string, string>();
  /** The zones that got a player block (main plus every present ZONEn, when sources exist). */
  private playerZones: string[] = [];
  /**
   * The subunits the AVAIL probe asked THIS device — the set a silent source is judged absent
   * against. Empty when the device ignored the probe (blind sweep) or when the remembered
   * snapshot came from another firmware: silence then proves nothing and no source is dropped.
   */
  private probedSubunits: ReadonlySet<string> = new Set();
  /** The subunits that answered the AVAIL probe (or were remembered as answering, same identity). */
  private presentSubunits = new Set<string>();
  /** The enum values this device ever reported (see OBSERVED_KEY), persisted on every addition. */
  private observed: ObservedValues = {};

  /**
   * @param deviceId the id-safe device id (object-tree path segment)
   * @param deps the client and adapter callbacks
   */
  public constructor(
    private readonly deviceId: string,
    private readonly deps: ControllerDeps,
  ) {}

  /**
   * Connect, sweep the device from the catalog, and create its object tree; wire
   * up push updates. The catalog is the single source: it drives the sweep, the
   * device→state read-back and (in handleStateChange) the state→wire encode.
   *
   * @returns true if the device reported capabilities and its tree was created
   */
  public async start(): Promise<boolean> {
    await this.deps.client.connect();
    // Group-filtered catalog: disabled groups are excluded from the sweep AND the objects.
    const catalog = this.deps.isEntryEnabled
      ? YNCA_CATALOG.filter(entry => this.deps.isEntryEnabled!(entry.id))
      : YNCA_CATALOG;
    const resolved = await this.resolveCapabilities(catalog);
    const { capabilities, fromCache } = resolved;
    const present = presentYncaEntries(capabilities, catalog);
    this.writeMap = idToEntry(present);
    this.presentEntries = present;
    // On the fast path `capabilities` carries the values of the LAST run — the persisted
    // layer is a SHAPE, its values are leftovers. Everything that DECIDES something
    // (which menus may be claimed, which wire function a band-routed write takes, which
    // source a zone's player buttons act on) is therefore re-read live before use.
    const live = fromCache ? await this.readDecisiveValues(capabilities) : capabilities;
    // Seed each zone's input from the sweep — the player routing needs to know what
    // every zone is listening to before the first INP push arrives.
    for (const zone of YNCA_ZONES) {
      const input = live.subunits[zone.subunit]?.INP;
      if (typeof input === "string") {
        this.zoneInputs.set(zone.key, input);
      }
    }
    // Every enum value the sweep (or the remembered shape) carries is an observation.
    this.recordObservedAll(capabilities);
    this.recordObservedAll(live);
    const evidence = this.inputEvidence(capabilities);
    const objects = yncaObjectsFor(capabilities, catalog, this.statesResolver(live, evidence));
    if (objects.length === 0) {
      this.deps.log.warn(`${this.deviceId}: no capabilities reported — creating no objects`);
      return false;
    }
    // A user command the device rejects must leave a trace: @RESTRICTED (not allowed /
    // not possible right now) and @UNDEFINED (unknown on this model) were silently
    // dropped before — the class of invisible failures behind #615.
    this.deps.client.onRefusal?.((command, verdict) =>
      this.deps.log.warn(`${this.deviceId}: device refused "${command}" (@${verdict.toUpperCase()})`),
    );
    // The scene titles ride the sweep as SCENExNAME answers; they become the recall
    // dropdown's labels and the one scene.list state (v2.0.0 — no per-name datapoints).
    this.sceneTitles = sceneTitlesOf(capabilities.subunits);
    // A zone's four scenes (official lists, ZONE2–4) get the same treatment under the zone.
    this.zoneSceneTitles.clear();
    for (const zone of YNCA_ZONES) {
      const titles = zone.key === "main" ? [] : sceneTitlesOf(capabilities.subunits, zone.subunit);
      if (titles.length > 0) {
        this.zoneSceneTitles.set(zone.key, titles);
      }
    }
    // Parents before children (channels before their states) — created in order.
    for (const object of objects) {
      const titles = this.sceneTitlesFor(object.id);
      if (titles !== undefined && titles.length > 0) {
        object.common.states = Object.fromEntries(titles.map(scene => [scene.num, scene.title]));
      }
      await this.deps.upsertObject(`${this.deviceId}.${object.id}`, object);
    }
    for (const zone of YNCA_ZONES) {
      const titles = zone.key === "main" ? this.sceneTitles : this.zoneSceneTitles.get(zone.key);
      if (titles === undefined || titles.length === 0) {
        continue;
      }
      await this.deps.upsertObject(`${this.deviceId}.${zone.prefix}scene.list`, {
        id: `${zone.prefix}scene.list`,
        type: "state",
        common: {
          name: tName("scenesNumberTitle"),
          desc: tName("descScenesNumberTitle"),
          type: "string",
          role: "json",
          read: true,
          write: false,
        },
      });
      this.deps.setStateAck(`${this.deviceId}.${zone.prefix}scene.list`, JSON.stringify(titles));
    }
    await this.setupZonePlayers(capabilities, objects);
    // Seed the states with the values read during the init sweep. On the fast path the
    // cached values are last-run leftovers — the states already hold exactly those, and
    // the background refresh streams the fresh ones in — so nothing is seeded there.
    if (!fromCache) {
      for (const [subunit, funcs] of Object.entries(capabilities.subunits)) {
        for (const [func, value] of Object.entries(funcs)) {
          const update = yncaStateUpdate({ subunit, func, value }, FUNC_MAP);
          if (update) {
            if (FLAT_PLAYER_ID.test(update.id)) {
              // Player-block values feed only the zones LISTENING to their source
              // (v2.0.0) — an idle source's leftover metadata must not seed the block.
              this.routePlayerUpdate(subunit, update.id, update.value);
            } else {
              this.deps.setStateAck(`${this.deviceId}.${update.id}`, update.value);
            }
          }
        }
      }
    }
    // The band decides which wire function a tuner.frequency/preset write goes to
    // (v2.0.0 unification) — read live above, kept fresh from the live pushes. Whether
    // the device HAS a DAB subunit is shape, so that half may come from the memory.
    this.hasDab = capabilities.subunits.DAB !== undefined;
    this.hasHdRadio = capabilities.subunits.HDRADIO !== undefined;
    this.tunerBand = (
      live.subunits.HDRADIO?.BAND ??
      live.subunits.DAB?.BAND ??
      live.subunits.TUN?.BAND ??
      ""
    ).toUpperCase();
    await this.setupBrowse(live);
    this.deps.client.onMessage(message => {
      // The browse driver sees every line first: list lines (LINE1TXT…, LISTINFO
      // bursts, auto-feedback) are not catalogued and would otherwise be dropped.
      this.browseDriver?.handleMessage(message);
      // A value never seen before joins the observed store now and the dropdown on the next
      // start (the tree is coordinated once per connect); the state gets the value at once.
      this.recordObserved(message.subunit, message.func, message.value);
      if (message.func === "BAND" && ["TUN", "DAB", "HDRADIO"].includes(message.subunit)) {
        this.tunerBand = message.value.toUpperCase();
      }
      if (message.func === "INP") {
        const zone = YNCA_ZONES.find(z => z.subunit === message.subunit);
        if (zone) {
          this.handleInputSwitch(zone.key, message.value);
        }
      }
      const update = yncaStateUpdate(message, FUNC_MAP);
      if (update) {
        if (FLAT_PLAYER_ID.test(update.id)) {
          this.routePlayerUpdate(message.subunit, update.id, update.value);
        } else {
          this.deps.setStateAck(`${this.deviceId}.${update.id}`, update.value);
        }
      }
    });
    // Start the keepalive only now the (fast-path) init is done; on the slow path the
    // sweep already ran, on the fast path the background refresh paces itself through
    // the same gate, so the 30 s poll cannot break the spacing either way.
    this.deps.client.startKeepalive();
    if (fromCache) {
      // The whole point of the persisted capability layer: the tree stood in ~1 s from
      // the remembered shape (validated by the LIVE identity answer above), and the
      // 15–20 s question round now runs behind the ready line as a pure value refresh —
      // its answers stream into the states through the live handler just registered.
      void this.refreshInBackground(catalog);
    }
    // The adapter logs one combined "ready" line across all transports; this per-transport line
    // stays at debug for diagnostics.
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
  private async resolveCapabilities(
    catalog: readonly YncaEntry[],
  ): Promise<{ capabilities: YncaCapabilities; fromCache: boolean }> {
    const identity = await this.deps.client.readCapabilities([
      { subunit: "SYS", func: "MODELNAME" },
      { subunit: "SYS", func: "VERSION" },
    ]);
    const model = identity.model;
    const firmware = identity.subunits.SYS?.VERSION ?? "";
    const remembered = this.deps.probeMemory?.remembered(CAPS_KEY);
    if (model && isCachedCapabilities(remembered) && remembered.model === model && remembered.firmware === firmware) {
      // The remembered subunit snapshot is proof for narrowing ONLY from the same identity: a
      // snapshot of another firmware says nothing about which sources this device has now.
      const cached = this.deps.subunitCache?.get();
      if (cached && cached.model === model && cached.firmware === firmware) {
        this.probedSubunits = PROBED_SUBUNITS;
        this.presentSubunits = new Set(cached.subunits);
      }
      this.loadObserved();
      return { capabilities: { model, subunits: remembered.subunits }, fromCache: true };
    }
    if (remembered !== undefined) {
      // A different (or updated) device behind this address: its remembered YNCA
      // answers are void — the observed values too. The other transports guard their own portions.
      this.deps.probeMemory?.drop(key => key === CAPS_KEY || key === STATIC_KEY || key === OBSERVED_KEY);
    }
    this.loadObserved();
    const capabilities = await this.sweepDevice(catalog, model, firmware);
    if (capabilities.model) {
      this.deps.probeMemory?.set(CAPS_KEY, {
        model: capabilities.model,
        firmware: capabilities.subunits.SYS?.VERSION ?? firmware,
        subunits: capabilities.subunits,
      } satisfies CachedCapabilities);
    } else {
      // No model, no identity — and without an identity nothing can ever invalidate what was
      // remembered. The statics (input and scene names) are written by the sweep regardless,
      // so leaving them behind froze those names for good on a device that does not answer
      // SYS:MODELNAME. The two keys live and die together.
      this.deps.probeMemory?.drop(key => key === STATIC_KEY);
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
  private async readDecisiveValues(remembered: YncaCapabilities): Promise<YncaCapabilities> {
    const gets: Array<{ subunit: string; func: string }> = [];
    if (remembered.subunits.MAIN !== undefined) {
      gets.push({ subunit: "MAIN", func: "PWR" });
    }
    for (const zone of YNCA_ZONES) {
      if (remembered.subunits[zone.subunit] !== undefined) {
        gets.push({ subunit: zone.subunit, func: "INP" });
      }
    }
    for (const subunit of ["TUN", "DAB", "HDRADIO"]) {
      if (remembered.subunits[subunit] !== undefined) {
        gets.push({ subunit, func: "BAND" });
      }
    }
    if (gets.length === 0) {
      return remembered;
    }
    const fresh = await this.deps.client.readCapabilities(gets);
    return { model: remembered.model, subunits: mergeYncaSubunits(remembered.subunits, fresh.subunits) };
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
  private async refreshInBackground(catalog: readonly YncaEntry[]): Promise<void> {
    try {
      const cached = this.deps.subunitCache?.get();
      const gets = sweepGets(catalog).filter(
        get => get.subunit === "SYS" || !cached || cached.subunits.includes(get.subunit),
      );
      const fresh = await this.deps.client.readCapabilities(gets);
      if (!fresh.model) {
        // The refresh ran into a drop — the supervisor handles the reconnect.
        return;
      }
      const statics: Record<string, Record<string, string>> = {};
      for (const [subunit, funcs] of Object.entries(fresh.subunits)) {
        for (const [func, value] of Object.entries(funcs)) {
          if (STATIC_FUNC.test(func)) {
            (statics[subunit] ??= {})[func] = value;
          }
        }
      }
      this.deps.probeMemory?.set(STATIC_KEY, statics);
      // UNION with the remembered shape (same identity — the fast path proved it):
      // a refresh while the device stands by answers many functions @RESTRICTED and
      // must not strip abilities it proved while awake; a lean standby FIRST capture
      // heals on the next awake refresh instead of staying lean forever (datapoint
      // review finding, 2.0.2).
      const remembered = this.deps.probeMemory?.remembered(CAPS_KEY);
      const subunits = isCachedCapabilities(remembered)
        ? mergeYncaSubunits(remembered.subunits, fresh.subunits)
        : fresh.subunits;
      this.deps.probeMemory?.set(CAPS_KEY, {
        model: fresh.model,
        firmware: fresh.subunits.SYS?.VERSION ?? "",
        subunits,
      } satisfies CachedCapabilities);
      // The write map follows the union too — a standby refresh must not shrink the
      // proven write surface until the next restart either.
      this.presentEntries = presentYncaEntries({ model: fresh.model, subunits }, catalog);
      this.writeMap = idToEntry(this.presentEntries);
      // Scene titles are not datapoints any more (v2.0.0), so nothing else carries them
      // into the running session: on the fast path they came from the memory, and a scene
      // renamed at the receiver stayed invisible until the NEXT start — including for a
      // write by title, which resolved against the old list and was dropped. The refresh
      // reads SCENExNAME anyway, so the list and the lookup follow it here.
      // (The recall dropdown's LABELS cannot follow live: the unified tree is coordinated
      // once per connection, so a later object write would not be materialised. They come
      // with the next start, out of the layer just persisted.)
      const titles = sceneTitlesOf(subunits);
      if (JSON.stringify(titles) !== JSON.stringify(this.sceneTitles)) {
        this.sceneTitles = titles;
        if (titles.length > 0) {
          this.deps.setStateAck(`${this.deviceId}.scene.list`, JSON.stringify(titles));
        }
      }
      for (const zone of YNCA_ZONES) {
        if (zone.key === "main") {
          continue;
        }
        const zoneTitles = sceneTitlesOf(subunits, zone.subunit);
        if (JSON.stringify(zoneTitles) !== JSON.stringify(this.zoneSceneTitles.get(zone.key) ?? [])) {
          this.zoneSceneTitles.set(zone.key, zoneTitles);
          if (zoneTitles.length > 0) {
            this.deps.setStateAck(`${this.deviceId}.${zone.prefix}scene.list`, JSON.stringify(zoneTitles));
          }
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
  private async sweepDevice(catalog: readonly YncaEntry[], model: string, firmware: string): Promise<YncaCapabilities> {
    const cached = this.deps.subunitCache?.get();
    if (cached) {
      // The device's IDENTITY was already read by resolveCapabilities (two reads,
      // ~0.2 s) — checking it BEFORE sweeping is what keeps a stale cache from costing
      // a full targeted sweep, then the probe, then a second sweep (~40 s).
      if (model === cached.model && firmware === cached.firmware) {
        this.probedSubunits = PROBED_SUBUNITS;
        this.presentSubunits = new Set(cached.subunits);
        return await this.targetedSweep(catalog, new Set(cached.subunits));
      }
      // The device behind this IP changed (swap or firmware update) — re-probe.
      this.deps.log.debug(`${this.deviceId}: cached subunit set is stale (model/firmware changed), re-probing`);
      this.deps.subunitCache?.clear();
    }
    const probe = await this.deps.client.readCapabilities(AVAIL_PROBE);
    const present = new Set(Object.keys(probe.subunits));
    if (present.size === 0) {
      // Device ignores AVAIL — sweep blind so no function is lost. And silence is no proof:
      // `probedSubunits` stays empty, so no source is judged absent (advisor round 2026-09-09).
      return await this.deps.client.readCapabilities(sweepGets(catalog));
    }
    this.probedSubunits = PROBED_SUBUNITS;
    this.presentSubunits = present;
    const capabilities = await this.targetedSweep(catalog, present);
    if (capabilities.model) {
      this.deps.subunitCache?.set({
        subunits: [...present],
        model: capabilities.model,
        firmware: capabilities.subunits.SYS?.VERSION ?? "",
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
  private async targetedSweep(catalog: readonly YncaEntry[], present: ReadonlySet<string>): Promise<YncaCapabilities> {
    // The bundles of every present subunit first (BASIC: one GET answers 15–25 functions at
    // once, the official lists; ynca-python reads it the same way — and SCENENAME, SIGINFO,
    // RDSINFO, METAINFO likewise). Every function a bundle answered is proof and is not asked
    // again individually; a function it lacks is still asked — a bundle is additive, never a
    // filter (the RX-V1067 leaves functions out of BASIC that it does answer on their own,
    // ynca-python: "Not in BASIC on RX-V1067"). A subunit without the bundle answers nothing
    // (`@UNDEFINED` carries no subunit) and loses nothing.
    const basic = await this.readBundles(present);
    const answered = new Set(
      Object.entries(basic.subunits).flatMap(([subunit, funcs]) =>
        Object.keys(funcs).map(func => `${subunit}:${func}`),
      ),
    );
    const gets = sweepGets(catalog).filter(
      get => (get.subunit === "SYS" || present.has(get.subunit)) && !answered.has(`${get.subunit}:${get.func}`),
    );
    const remembered = this.deps.probeMemory?.remembered<Record<string, Record<string, string>>>(STATIC_KEY);
    // Second connect onwards: skip those reads and put the remembered answers back in, so
    // the objects are built exactly as if the device had answered them again.
    const swept = await this.deps.client.readCapabilities(
      remembered ? gets.filter(get => !STATIC_FUNC.test(get.func)) : gets,
    );
    const capabilities: YncaCapabilities = {
      model: swept.model || basic.model,
      subunits: mergeYncaSubunits(basic.subunits, swept.subunits),
    };
    if (remembered) {
      for (const [subunit, funcs] of Object.entries(remembered)) {
        capabilities.subunits[subunit] = { ...funcs, ...capabilities.subunits[subunit] };
      }
      return capabilities;
    }
    const statics: Record<string, Record<string, string>> = {};
    for (const [subunit, funcs] of Object.entries(capabilities.subunits)) {
      for (const [func, value] of Object.entries(funcs)) {
        if (STATIC_FUNC.test(func)) {
          (statics[subunit] ??= {})[func] = value;
        }
      }
    }
    this.deps.probeMemory?.set(STATIC_KEY, statics);
    return capabilities;
  }

  /**
   * Read every bundle of the present subunits (BASIC and SCENENAME per zone, SIGINFO/RDSINFO on
   * the tuner, METAINFO per player — see `bundleGets`) in ONE paced request list; the answers
   * are ordinary `@SUBUNIT:FUNC=value` lines the collector absorbs. Nothing to ask (no subunit
   * present, e.g. a blind sweep) → an empty report without a wire round trip.
   *
   * @param present the subunits that answered the AVAIL probe
   * @returns the bundled answers
   */
  private async readBundles(present: ReadonlySet<string>): Promise<YncaCapabilities> {
    const gets = bundleGets(present);
    if (gets.length === 0) {
      return { model: "", subunits: {} };
    }
    return await this.deps.client.readCapabilities(gets);
  }

  /**
   * The scene titles a recall datapoint's dropdown shows: the main zone's for `scene.recall`,
   * a zone's own for `multiroom.zoneN.scene.recall`, undefined for any other id.
   *
   * @param stateId the state id relative to the device
   * @returns the titles, or undefined when the id is no scene recall
   */
  private sceneTitlesFor(stateId: string): Array<{ num: number; title: string }> | undefined {
    const match = /^(?:multiroom\.(zone[234])\.)?scene\.recall$/.exec(stateId);
    if (!match) {
      return undefined;
    }
    return match[1] ? (this.zoneSceneTitles.get(match[1]) ?? []) : this.sceneTitles;
  }

  /**
   * Load the observed-values store from the memory (after the identity guard ran, so a
   * dropped store is not read back).
   */
  private loadObserved(): void {
    const remembered = this.deps.probeMemory?.remembered(OBSERVED_KEY);
    this.observed = isObservedValues(remembered) ? remembered : {};
  }

  /**
   * Record every enum value a capability report carries.
   *
   * @param capabilities the report (a sweep, the remembered shape, the decisive reads)
   */
  private recordObservedAll(capabilities: YncaCapabilities): void {
    for (const [subunit, funcs] of Object.entries(capabilities.subunits)) {
      for (const [func, value] of Object.entries(funcs)) {
        this.recordObserved(subunit, func, value);
      }
    }
  }

  /**
   * Add a value the device reported for an enum function to the observed store, persisting
   * on every addition. Non-enum functions and empty values are not observations.
   *
   * @param subunit the reporting subunit
   * @param func the function
   * @param value the wire value
   */
  private recordObserved(subunit: string, func: string, value: string): void {
    const entry = FUNC_MAP.get(`${subunit}:${func}`);
    if (!entry || entry.spec.kind !== "enum" || value.length === 0) {
      return;
    }
    const list = ((this.observed[subunit] ??= {})[func] ??= []);
    if (list.includes(value) || list.length >= MAX_OBSERVED_VALUES) {
      return;
    }
    list.push(value);
    this.deps.probeMemory?.set(OBSERVED_KEY, this.observed);
  }

  /**
   * What this connect learned about the device's inputs: the probe's verdicts (present /
   * asked), every subunit that answered anything, and the XML declaration when remembered.
   *
   * @param capabilities the capability report of this connect
   * @returns the evidence the per-zone input lists are derived from
   */
  private inputEvidence(capabilities: YncaCapabilities): InputEvidence {
    const present = new Set([...this.presentSubunits, ...Object.keys(capabilities.subunits)]);
    return {
      present,
      probed: this.probedSubunits,
      ...xmlInputEvidence(this.deps.probeMemory?.remembered("xmlConfig")),
    };
  }

  /**
   * The per-entry resolver of the selectable values on THIS device: the input list of each
   * zone derived from the evidence, the trigger zone list from the zones the device has, and
   * every other enum from the generation's candidates plus what this device reported.
   *
   * @param live the capability report with the decisive values read live
   * @param evidence the input evidence of this connect
   * @returns the resolver handed to the object builder
   */
  private statesResolver(live: YncaCapabilities, evidence: InputEvidence): StatesResolver {
    return entry => {
      if (entry.spec.kind !== "enum") {
        return undefined;
      }
      const yncaEntry = entry as YncaEntry;
      const readFunc = yncaEntry.readFunc ?? yncaEntry.func;
      const current = live.subunits[yncaEntry.subunit]?.[readFunc];
      if (yncaEntry.func === "INP") {
        const zone = YNCA_ZONES.find(z => z.subunit === yncaEntry.subunit);
        if (zone) {
          return { states: deviceInputStates(evidence, zone.key, current), origin: "derived" };
        }
      }
      if (/^TRIG\dZONE$/.test(yncaEntry.func)) {
        const zones = YNCA_ZONES.filter(zone => zone.key !== "main" && evidence.present.has(zone.subunit)).map(
          zone => `Zone${zone.key.slice(4)}`,
        );
        const values = ["Main Zone", ...zones, "All"];
        if (current && !values.includes(current)) {
          values.push(current);
        }
        return { states: Object.fromEntries(values.map(value => [value, value])), origin: "derived" };
      }
      const observed = this.observed[yncaEntry.subunit]?.[readFunc] ?? [];
      return { states: enumStatesFor(yncaEntry, observed, current), origin: "candidates" };
    };
  }

  /**
   * Handle a state change: a user write (ack false) becomes a YNCA command; an
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
    if (stateId.startsWith("remote.")) {
      this.browseEngine?.handleRemoteWrite(stateId, value);
      return;
    }
    if (stateId.startsWith("player.browse.")) {
      this.browseEngine?.handleWrite(stateId, value);
      return;
    }
    // A scene TITLE is as valid a recall write as its number ("Movie Viewing" → 1) — on the
    // main zone and on a zone with scenes of its own.
    const sceneTitles = this.sceneTitlesFor(stateId);
    if (sceneTitles !== undefined && typeof value === "string" && !/^\d+$/.test(value.trim())) {
      const needle = value.trim().toLowerCase();
      const match = sceneTitles.find(scene => scene.title.toLowerCase() === needle);
      if (match === undefined) {
        // A dead button has to leave a trace — this was the one write path in the adapter
        // that dropped a user action without a word (#615's lesson, applied to itself).
        this.deps.log.debug(
          `${this.deviceId}: scene "${value}" is not one this device declares — write dropped ` +
            `(known: ${sceneTitles.map(scene => scene.title).join(", ") || "none yet"})`,
        );
        return;
      }
      value = match.num;
    }
    // The unified player writes go to the subunit the ZONE is listening to (v2.0.0) —
    // routed here, BEFORE the generic path.
    const playerWrite = /^(?:multiroom\.(zone[234])\.)?player\.(playback|repeat|shuffle|next|prev)$/.exec(stateId);
    if (playerWrite) {
      this.handlePlayerWrite(playerWrite[1] ?? "main", `player.${playerWrite[2]}`, value);
      return;
    }
    // The unified tuner writes are band-dependent (v2.0.0) and routed here, BEFORE the
    // generic path — one state, the right wire function for the active band.
    if (this.handleTunerWrite(stateId, value)) {
      return;
    }
    const triple = yncaCommand(stateId, value, this.writeMap ?? ID_MAP);
    if (!triple) {
      // The one write path that still dropped a user action without a word. Every special
      // route above (scene, player, tuner, sendProven) says why it did nothing; this is the
      // generic one, and it carries the majority of the writes — power, volume, input, sound
      // programme. `yncaCommand` returns nothing when this device never reported the function
      // or when the entry is read-only, and both are worth a line (audit 2026-09-06).
      this.deps.log.debug(
        `${this.deviceId}: ${stateId} is not writable on this device — write dropped ` +
          `(not reported in the sweep, or a read-only function)`,
      );
      return;
    }
    this.deps.client.send(triple.subunit, triple.func, triple.value);
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
  private async setupZonePlayers(capabilities: YncaCapabilities, objects: ObjectDef[]): Promise<void> {
    const playerObjects = objects.filter(
      object => object.id === "player" || (object.type === "state" && FLAT_PLAYER_ID.test(object.id)),
    );
    if (!playerObjects.some(object => object.type === "state")) {
      this.playerZones = [];
      return;
    }
    const sourceDef = (id: string): ObjectDef => ({
      id,
      type: "state",
      common: {
        name: tName("playingSource"),
        desc: tName("descPlayingSource"),
        type: "string",
        role: "text",
        read: true,
        write: false,
      },
    });
    await this.deps.upsertObject(`${this.deviceId}.player.source`, sourceDef("player.source"));
    this.playerZones = ["main"];
    for (const zone of YNCA_ZONES) {
      if (zone.key === "main" || capabilities.subunits[zone.subunit] === undefined) {
        continue;
      }
      this.playerZones.push(zone.key);
      for (const object of playerObjects) {
        const id = `${zone.prefix}${object.id}`;
        await this.deps.upsertObject(`${this.deviceId}.${id}`, { ...object, id });
      }
      await this.deps.upsertObject(
        `${this.deviceId}.${zone.prefix}player.source`,
        sourceDef(`${zone.prefix}player.source`),
      );
    }
    // Seed the block's resting shape: a device already playing at adapter start must
    // not show an empty source until its first input switch, and a zone NOT playing a
    // media source must show cleared values, not valueless states (2.0.0 review + live
    // deployment check). Zones ON a source get their values from the routed sweep.
    const presentFlat = new Set(
      this.presentEntries.filter(entry => FLAT_PLAYER_ID.test(entry.id)).map(entry => entry.id),
    );
    for (const zone of YNCA_ZONES) {
      if (!this.playerZones.includes(zone.key)) {
        continue;
      }
      const input = this.zoneInputs.get(zone.key);
      const playing = playerSubunitForInput(input) !== undefined;
      this.deps.setStateAck(
        `${this.deviceId}.${zone.prefix}player.source`,
        playing && input !== undefined ? input : "",
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
  private routePlayerUpdate(subunit: string, id: string, value: boolean | number | string): void {
    // A playback time is published in both forms, from this one value: the seconds fill
    // the media-player slot, the readable text is what a visualisation shows.
    const twin = playTimeTwin(id, value);
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
  private handleInputSwitch(zoneKey: string, input: string): void {
    const before = playerSubunitForInput(this.zoneInputs.get(zoneKey));
    this.zoneInputs.set(zoneKey, input);
    const after = playerSubunitForInput(input);
    if (before === after || !this.playerZones.includes(zoneKey)) {
      return;
    }
    const zone = YNCA_ZONES.find(z => z.key === zoneKey);
    if (!zone) {
      return;
    }
    const presentFlat = new Set(
      this.presentEntries.filter(entry => FLAT_PLAYER_ID.test(entry.id)).map(entry => entry.id),
    );
    for (const clear of YNCA_PLAYER_CLEAR) {
      if (presentFlat.has(clear.id)) {
        this.deps.setStateAck(`${this.deviceId}.${zone.prefix}${clear.id}`, clear.value);
      }
    }
    this.deps.setStateAck(`${this.deviceId}.${zone.prefix}player.source`, after === undefined ? "" : input);
    if (after !== undefined) {
      // Fresh reads for the newly selected source, streamed back through the live handler.
      const funcs = new Set<string>();
      for (const entry of this.presentEntries) {
        if (entry.subunit === after && FLAT_PLAYER_ID.test(entry.id) && !entry.writeOnly) {
          funcs.add(entry.readFunc ?? entry.func);
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
  private handlePlayerWrite(zoneKey: string, flatId: string, value: unknown): void {
    const subunit = playerSubunitForInput(this.zoneInputs.get(zoneKey));
    if (subunit === undefined) {
      this.deps.log.debug(`${this.deviceId}: ${flatId} ignored — ${zoneKey} is not playing a media source`);
      return;
    }
    const entry = this.presentEntries.find(e => e.id === flatId && e.subunit === subunit);
    if (entry === undefined) {
      this.deps.log.debug(`${this.deviceId}: ${flatId} ignored — ${subunit} did not report it`);
      return;
    }
    const triple = yncaCommand(flatId, value, new Map([[flatId, entry]]));
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
  private handleTunerWrite(stateId: string, value: unknown): boolean {
    if (stateId === "tuner.frequency") {
      const khz = Number(value);
      if (!Number.isFinite(khz)) {
        return true;
      }
      if (this.hasDab) {
        if (this.tunerBand === "FM") {
          this.sendProven("DAB", "FMFREQ", formatWireNumber(khz / 1000, 2));
        } else {
          this.deps.log.debug(`${this.deviceId}: DAB tunes by service — frequency write ignored`);
        }
        return true;
      }
      // The HD Radio subunit carries the AM/FM tuner of the US models — with TUN beside it or
      // (four of the seven official lists) alone.
      const amFm = this.hasHdRadio ? "HDRADIO" : "TUN";
      if (this.tunerBand === "AM") {
        this.sendProven(amFm, "AMFREQ", String(Math.round(khz)));
      } else {
        this.sendProven(amFm, "FMFREQ", formatWireNumber(khz / 1000, 2));
      }
      return true;
    }
    if (stateId === "tuner.band") {
      // Two subunits feed this one dropdown: AM lives only on TUN, DAB only on DAB, and FM on
      // both — on a device that has DAB its FM half lives there too (that is where its FM
      // frequency and presets are). Routing by the written VALUE keeps a dual-subunit device
      // honest instead of sending every band to whichever entry happened to be mapped last.
      const band = typeof value === "string" ? value : "";
      const subunit = this.hasHdRadio
        ? "HDRADIO"
        : band === "AM"
          ? "TUN"
          : band === "DAB" || this.hasDab
            ? "DAB"
            : "TUN";
      const entry = this.presentEntries.find(
        candidate => candidate.id === "tuner.band" && candidate.subunit === subunit,
      );
      const triple = entry ? yncaCommand(stateId, value, new Map([[stateId, entry]])) : undefined;
      if (triple) {
        this.sendProven(triple.subunit, triple.func, triple.value);
      } else {
        this.deps.log.debug(`${this.deviceId}: band "${band}" is not available on this device — write dropped`);
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
    if (stateId === "tuner.preset" && this.hasHdRadio) {
      const slot = Math.round(Number(value));
      if (Number.isFinite(slot) && slot >= 1) {
        this.sendProven("HDRADIO", "PRESET", String(slot));
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
  private sendProven(subunit: string, func: string, wire: string): void {
    if (!this.presentEntries.some(entry => entry.subunit === subunit && entry.func === func)) {
      this.deps.log.debug(`${this.deviceId}: ${subunit}:${func} not reported by this device — write dropped`);
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
  private async setupBrowse(capabilities: YncaCapabilities): Promise<void> {
    const gate = this.deps.gate;
    if (!gate || this.deps.isEntryEnabled?.("player.browse.source") === false) {
      return;
    }
    const delay = (ms: number): Promise<void> => gate.delay(ms);
    const { subunits: present, proven } = await this.probeBrowseSubunits(capabilities);
    if (present.size === 0) {
      // Leaving the states uncreated is what hands browsing to another transport: the owner
      // policy ranks by modernity (yxc > ynca > xml), so an unproven YNCA claim would beat a
      // PROVEN xml one and the user would get an empty menu on a device that can browse over
      // XML — exactly issue #613's RX-V473.
      this.deps.log.debug(`${this.deviceId}: no YNCA source answers LISTINFO — leaving menus to another transport`);
      return;
    }
    const driver = new YncaBrowseDriver(this.deps.client, present, delay);
    this.browseEngine = await createBrowseSurface(
      driver,
      this.deviceId,
      {
        upsertObject: this.deps.upsertObject,
        emit: (id, value) => this.deps.setStateAck(`${this.deviceId}.${id}`, value),
        log: this.deps.log,
        delay,
      },
      !proven,
    );
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
   * @returns the subunits that answered with list data, and whether that answer is a PROOF
   */
  private async probeBrowseSubunits(
    capabilities: YncaCapabilities,
  ): Promise<{ subunits: ReadonlySet<string>; proven: boolean }> {
    const candidates = YNCA_BROWSE_SOURCES.filter(source => source.subunit in capabilities.subunits);
    if (candidates.length === 0) {
      return { subunits: new Set(), proven: true };
    }
    // A receiver in standby answers @RESTRICTED for its media subunits, which is
    // indistinguishable from "cannot browse" and would strip the menus off a device that
    // serves them perfectly once it is on. Nobody browses a sleeping receiver, so keep the
    // claim and let the next connect — with the device awake — do the real probe.
    if (capabilities.subunits.MAIN?.PWR !== "On") {
      // Claimed, but NOT proven: the coordinator hands the surface to a transport that could
      // prove it (XML probes at any power state). Without that, a receiver that was in standby
      // at adapter start — the normal case — displaced the driver that actually works on the
      // 2012 generation, for the whole run (#613 through the standby door, audit 2026-09-06).
      return { subunits: new Set(candidates.map(source => source.subunit)), proven: false };
    }
    const answer = await this.deps.client.readCapabilities(
      candidates.map(source => ({ subunit: source.subunit, func: "LISTINFO" })),
    );
    // Only a real list answer counts. Both refusals — `@UNDEFINED` (function unknown) and
    // `@RESTRICTED` (source not usable right now) — carry no subunit, so they cannot be
    // attributed to one request; it is the ABSENCE of an answer that excludes a subunit.
    return {
      subunits: new Set(
        candidates
          .map(source => source.subunit)
          .filter(subunit => Object.keys(answer.subunits[subunit] ?? {}).some(func => LIST_PROOF.test(func))),
      ),
      proven: true,
    };
  }

  /**
   * Register the supervisor's drop handler — delegated to the client's socket drop,
   * which is YNCA's genuine connection-lost signal.
   *
   * @param cb invoked once when the connection drops, with the reason if known
   */
  public onDrop(cb: (reason?: Error) => void): void {
    this.deps.client.onDrop(cb);
  }

  /** Close the client. Synchronous — safe to call from onUnload. */
  public close(): void {
    this.browseEngine?.close();
    this.browseDriver?.close();
    this.deps.client.close();
  }
}
