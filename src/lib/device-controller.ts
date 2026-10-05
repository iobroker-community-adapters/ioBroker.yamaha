import { splitZone } from "./catalog/zones";
import type { YncaCapabilities } from "./ynca/capability";
import { formatWireNumber, selfMap, writableNumber } from "./catalog/value-coerce";
import { playTimeTwin } from "./catalog/play-time";
import type { ObjectDef } from "./catalog/types";
import { tName } from "./i18n";
import { errText } from "./err-text";
import type { ControllerDepsBase } from "./controller";
import {
  SOURCE_INPUTS,
  YNCA_CATALOG,
  deviceInputStates,
  enumStatesFor,
  funcToEntry,
  idToEntry,
  presentYncaEntries,
  snapTunerFrequency,
  writeProblem,
  yncaCommand,
  yncaObjectsFor,
  yncaStateUpdate,
  YNCA_ZONES,
  type InputEvidence,
  type YncaEntry,
} from "./ynca/catalog";
import type { StatesResolver } from "./catalog/build-objects";
import type { YncaSubunitCache } from "./ynca/subunit-cache";
import type { YncaClientLike } from "./ynca/client-like";
import { YncaShapeReader } from "./ynca/shape-reader";
import { POWER_ON_SETTLED_MS, YncaMenus } from "./ynca/menus";
import type { YncaMessage } from "./ynca/protocol";
import type { WriteOutcome } from "./lifecycle/multi-transport-handle";
import { sceneListSurface, sceneNumber, yncaSceneTitles } from "./catalog/scene-titles";
import { MEMORY_KEY } from "./lifecycle/memory-keys";
import { PLAYER_CLEAR } from "./catalog/player-block";

// The YNCA catalog and its lookup maps are static — built once for all devices.
// SYS:MODELNAME is part of the catalog (info.model), so the sweep already covers it.
const FUNC_MAP = funcToEntry(YNCA_CATALOG);

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

/** Unknown lines logged per connection before they are only counted (see the onUnknownLine handler). */
const UNKNOWN_LINES_LOGGED = 3;

/**
 * Memory key for the enum values this device ever reported: subunit → function → values, in
 * the order first seen. YNCA declares no value lists, so a device's own spelling is learned
 * by observation and offered on the dropdown from then on (see `enumStatesFor`).
 */
const OBSERVED_KEY = MEMORY_KEY.yncaObserved;

/**
 * The ceiling per function of the observed store. A real enum has a dozen values at most;
 * the cap only keeps a misbehaving device from growing the device object without bound.
 */
export const MAX_OBSERVED_VALUES = 64;

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
 * The scenes a device declares, read from its `SCENExNAME` answers. Used both by the init and by
 * the background refresh, so a scene renamed at the receiver reaches the running session instead
 * of waiting for the next start.
 *
 * @param subunits the swept subunit→function map
 * @param subunit the zone subunit whose scenes to read (MAIN, ZONE2 …)
 * @returns the declared scenes, lowest number first
 */
function sceneTitlesOf(
  subunits: Record<string, Record<string, string>>,
  subunit = "MAIN",
): Array<{ num: number; title: string }> {
  return yncaSceneTitles(subunits[subunit], subunit);
}

/** The adapter callbacks the controller drives — narrow, so no adapter mock is needed in tests. */
export interface ControllerDeps extends ControllerDepsBase {
  /** The YNCA client for this device. */
  client: YncaClientLike;
  /**
   * Whether a catalog entry's datapoint group is enabled. A disabled group's entries
   * are dropped BEFORE the sweep, so their GETs are never sent (previously only the
   * object/state writes were gated and the answers thrown away). Absent = all enabled.
   */
  isEntryEnabled?(id: string): boolean;
  /**
   * Per-device cache of the AVAIL probe result, held across reconnects and restarts.
   * With a valid cache (same model and firmware, read live BEFORE any sweep) only the subunits
   * the snapshot never asked are probed and the targeted sweep runs directly; a model/firmware
   * mismatch clears the cache and re-probes.
   */
  subunitCache: YncaSubunitCache;
}

/**
 * Drives one YNCA device: connect, init sweep, build the object tree, and route
 * commands both ways. Create-only — orphan cleanup and legacy migration are
 * separate, gated steps.
 */
export class YncaDeviceController {
  /** The menus (browse surface, pads) and the proofs they rest on. */
  private readonly menus: YncaMenus;
  /**
   * Write map filtered to the entries THIS device reported — claim-with-proof for
   * writes: a command is only sent with a wire function the device answered in the
   * sweep. Empty until then: the adapter routes writes only through a connected handle,
   * which exists after start(), so nothing can arrive earlier (the unfiltered static map
   * that used to stand in was a dead fallback — audit 2026-09-15).
   */
  private writeMap: Map<string, YncaEntry> = new Map();
  /** The device's scene titles (SCENExNAME), for the recall dropdown, the list state and title writes. */
  private sceneTitles: Array<{ num: number; title: string }> = [];
  /** The zones' own scene titles (ZONEn SCENE1–4NAME), keyed by zone (`zone2` …). */
  private readonly zoneSceneTitles = new Map<string, Array<{ num: number; title: string }>>();
  /** The value the device last reported per state id — what a refused write is put back to (B4). */
  private readonly reported = new Map<string, boolean | number | string | null>();
  /** The tuner's current band (AM/FM/DAB), for the band-dependent frequency/preset writes. */
  private tunerBand = "";

  /** The tuner grid the device declares (`@SYS:FREQSTEP`), when it declares one — see snapTunerFrequency. */
  private freqStep: string | undefined;
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
  /** Reads the capability shape and keeps it by its rules (identity, AVAIL snapshot, names). */
  private readonly reader: YncaShapeReader;
  /** The enum values this device ever reported (see OBSERVED_KEY), persisted on every addition. */
  private observed: ObservedValues = {};
  /** The (group-filtered) catalog of this connection, for rebuilding objects mid-session. */
  private catalog: readonly YncaEntry[] = [];
  /** The capability shape the current object tree was built from — grown by pushes and refreshes. */
  private shape: YncaCapabilities = { model: "", subunits: {} };
  /** Object id → the definition last upserted, so a republish writes only what really changed. */
  private readonly published = new Map<string, string>();
  /** Set by {@link close} — a read still queued or waiting ends there. */
  private closed = false;
  /** Whether the read of a switched-on receiver is queued or running, so a second `PWR=On` adds none. */
  private awakeReadQueued = false;
  /** Called once the shape becomes one of a switched-on receiver (see {@link readComplete}). */
  private readonly readCompleteListeners: Array<() => void> = [];

  /**
   * @param deviceId the id-safe device id (object-tree path segment)
   * @param deps the client and adapter callbacks
   */
  public constructor(
    private readonly deviceId: string,
    private readonly deps: ControllerDeps,
  ) {
    this.reader = new YncaShapeReader(deviceId, {
      client: deps.client,
      probeMemory: deps.probeMemory,
      subunitCache: deps.subunitCache,
      log: deps.log,
    });
    this.menus = new YncaMenus(deviceId, deps);
  }

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
    this.catalog = catalog;
    const { capabilities, fromCache } = await this.reader.resolve(catalog);
    // After the identity guard ran: a store it dropped is not read back.
    this.loadObserved();
    // Registered now, not after the ~250 awaited upserts and the menu probe: a change the device
    // pushes meanwhile (a volume turned at the unit) used to be lost; it waits and is played back
    // in order once the tree stands (audit 2026-09-24, B12).
    const early: YncaMessage[] = [];
    let liveReady = false;
    this.deps.client.onMessage(message => {
      if (liveReady) {
        this.handleLiveMessage(message);
      } else {
        early.push(message);
      }
    });
    const present = presentYncaEntries(capabilities, catalog);
    this.writeMap = idToEntry(present);
    this.presentEntries = present;
    // On the fast path `capabilities` carries the values of the LAST run — the persisted
    // layer is a SHAPE, its values are leftovers. Everything that DECIDES something
    // (which menus may be claimed, which wire function a band-routed write takes, which
    // source a zone's player buttons act on) is therefore re-read live before use.
    const live = fromCache ? await this.reader.readDecisive(capabilities) : capabilities;
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
    const evidence = this.reader.inputEvidence(capabilities);
    this.shape = { model: capabilities.model, subunits: capabilities.subunits };
    const objects = yncaObjectsFor(capabilities, catalog, this.statesResolver(live, evidence));
    if (objects.length === 0) {
      this.deps.log.warn(`${this.deviceId}: no capabilities reported — creating no objects`);
      return false;
    }
    // A user command the device rejects must leave a trace: @RESTRICTED (not allowed /
    // not possible right now) and @UNDEFINED (unknown on this model) were silently
    // dropped before — the class of invisible failures behind #615.
    this.deps.client.onRefusal((command, verdict) => {
      this.deps.log.warn(`${this.deviceId}: device refused "${command}" (@${verdict.toUpperCase()})`);
      this.restoreRefused(command);
      // A pad key the device does not know: the dialect may be wrong — the menus ask again.
      this.menus.onRefused(command, verdict);
    });
    let unknownLines = 0;
    this.deps.client.onUnknownLine(line => {
      unknownLines++;
      if (unknownLines <= UNKNOWN_LINES_LOGGED) {
        this.deps.log.debug(`${this.deviceId}: unrecognised line from the device: ${line}`);
      } else if (unknownLines % 100 === 0) {
        this.deps.log.debug(`${this.deviceId}: ${unknownLines} unrecognised lines from the device so far`);
      }
    });
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
      await this.upsertTracked(object);
    }
    for (const zone of YNCA_ZONES) {
      const titles = zone.key === "main" ? this.sceneTitles : this.zoneSceneTitles.get(zone.key);
      if (titles === undefined || titles.length === 0) {
        continue;
      }
      await this.publishSceneList(`${zone.prefix}scene`, titles);
    }
    await this.setupZonePlayers(capabilities, objects);
    // Seed the states with the values read during the init sweep. On the fast path the
    // cached values are last-run leftovers — the states already hold exactly those, and
    // the background refresh streams the fresh ones in — so nothing is seeded there.
    if (!fromCache) {
      for (const [subunit, funcs] of Object.entries(capabilities.subunits)) {
        for (const [func, value] of Object.entries(funcs)) {
          this.writeDerived(subunit, func, value);
          this.applyLine({ subunit, func, value });
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
    this.freqStep = live.subunits.SYS?.FREQSTEP;
    liveReady = true;
    for (const message of early.splice(0)) {
      this.handleLiveMessage(message);
    }
    await this.menus.setup(live);
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
   * The fast path's second half: re-ask every catalogued function of the present
   * subunits — the answers stream into the states through the live message handler,
   * so current values arrive within the usual sweep time WITHOUT having gated the
   * ready line. Completion refreshes the persisted layers (capabilities, statics)
   * and the write map; a SHAPE change (a function newly answered) is persisted AND published —
   * the objects are rebuilt from the grown shape and the handle adds what is new to the tree, so the
   * datapoint appears in this session instead of one start later.
   *
   * @param catalog the (group-filtered) catalog
   */
  private async refreshInBackground(catalog: readonly YncaEntry[]): Promise<void> {
    try {
      const wasAwake = this.reader.awake;
      const shape = await this.reader.refresh(catalog);
      if (!shape) {
        return;
      }
      // The write map follows the union too — a standby refresh must not shrink the
      // proven write surface until the next restart either.
      this.presentEntries = presentYncaEntries(shape, catalog);
      this.writeMap = idToEntry(this.presentEntries);
      // A function the refresh answered for the first time becomes an object in THIS session
      // (2.7.0): the shape the tree is built from grows, the objects are republished, and the
      // handle adds them. Purely additive — the union above never drops a proven ability.
      this.shape = { model: shape.model || this.shape.model, subunits: shape.subunits };
      await this.republishObjects();
      // Scene titles are not datapoints any more (v2.0.0), so nothing else carries them
      // into the running session: on the fast path they came from the memory, and a scene
      // renamed at the receiver stayed invisible until the NEXT start — including for a
      // write by title, which resolved against the old list and was dropped. The refresh
      // reads SCENExNAME anyway, so the list and the lookup follow it here.
      // (The recall dropdown's LABELS follow through the republish below, which rebuilds every
      // object from the grown shape — the scene titles among them.)
      const titles = sceneTitlesOf(shape.subunits);
      if (JSON.stringify(titles) !== JSON.stringify(this.sceneTitles)) {
        this.sceneTitles = titles;
        if (titles.length > 0) {
          await this.publishSceneList("scene", titles);
        }
      }
      for (const zone of YNCA_ZONES) {
        if (zone.key === "main") {
          continue;
        }
        const zoneTitles = sceneTitlesOf(shape.subunits, zone.subunit);
        if (JSON.stringify(zoneTitles) !== JSON.stringify(this.zoneSceneTitles.get(zone.key) ?? [])) {
          this.zoneSceneTitles.set(zone.key, zoneTitles);
          if (zoneTitles.length > 0) {
            await this.publishSceneList(`${zone.prefix}scene`, zoneTitles);
          }
        }
      }
      if (!wasAwake && this.reader.awake) {
        for (const listener of this.readCompleteListeners) {
          listener();
        }
      }
      this.deps.log.debug(`${this.deviceId}: background value refresh done (YNCA)`);
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: background value refresh failed: ${errText(e)}`);
    }
  }

  /**
   * Put a scene channel's list and its per-scene titles in the tree (D8, `sceneListSurface`).
   *
   * @param channel the scene channel id (`scene`, `multiroom.zone2.scene`)
   * @param scenes the declared scenes
   */
  private async publishSceneList(channel: string, scenes: Array<{ num: number; title: string }>): Promise<void> {
    const surface = sceneListSurface(channel, scenes);
    for (const object of surface.objects) {
      await this.deps.upsertObject(`${this.deviceId}.${object.id}`, object);
    }
    for (const { id, value } of surface.values) {
      this.deps.setStateAck(`${this.deviceId}.${id}`, value);
    }
  }

  /**
   * The scene titles a recall datapoint's dropdown shows: the main zone's for `scene.recall`,
   * a zone's own for `multiroom.zoneN.scene.recall`, undefined for any other id.
   *
   * @param stateId the state id relative to the device
   * @returns the titles, or undefined when the id is no scene recall
   */
  private sceneTitlesFor(stateId: string): Array<{ num: number; title: string }> | undefined {
    const { zone, name } = splitZone(stateId);
    if (name !== "scene.recall") {
      return undefined;
    }
    return zone === "main" ? this.sceneTitles : (this.zoneSceneTitles.get(zone) ?? []);
  }

  /**
   * Load the observed-values store from the memory (after the identity guard ran, so a
   * dropped store is not read back).
   */
  private loadObserved(): void {
    const remembered = this.deps.probeMemory.remembered(OBSERVED_KEY);
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
    this.deps.probeMemory.set(OBSERVED_KEY, this.observed);
    // The dropdown follows within the SESSION (2.7.0): the object is rebuilt with the grown list
    // and re-upserted; the handle adds what is new. Before, an observed value reached the dropdown
    // one start later.
    void this.republishObjects();
  }

  /**
   * Rebuild this transport's objects from the shape it knows now and upsert them. Idempotent by
   * construction: the transport adapter keeps the last definition per id, so an unchanged object
   * is neither written nor signalled — only a real change reaches the handle.
   * Silent before the tree stood (no shape yet) and while nothing is present.
   */
  private async republishObjects(): Promise<void> {
    if (this.presentEntries.length === 0 || Object.keys(this.shape.subunits).length === 0) {
      return;
    }
    try {
      const objects = yncaObjectsFor(
        this.shape,
        this.catalog,
        this.statesResolver(this.shape, this.reader.inputEvidence(this.shape)),
      );
      for (const object of objects) {
        const titles = this.sceneTitlesFor(object.id);
        if (titles !== undefined && titles.length > 0) {
          object.common.states = Object.fromEntries(titles.map(scene => [scene.num, scene.title]));
        }
        await this.upsertTracked(object);
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: could not republish the object tree: ${errText(e)}`);
    }
  }

  /**
   * Upsert an object and remember its definition, so the next republish writes only what really
   * changed. A device answering a new value republishes the whole tree; without this every one of
   * ~250 definitions would be handed on, and the handle would learn again for each of them.
   *
   * @param object the object definition to write
   */
  private async upsertTracked(object: ObjectDef): Promise<void> {
    const fingerprint = JSON.stringify(object);
    if (this.published.get(object.id) === fingerprint) {
      return;
    }
    this.published.set(object.id, fingerprint);
    await this.deps.upsertObject(`${this.deviceId}.${object.id}`, object);
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
          return { states: deviceInputStates(evidence, zone.key, current), reported: current };
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
        return { states: selfMap(values), reported: current };
      }
      const observed = this.observed[yncaEntry.subunit]?.[readFunc] ?? [];
      return { states: enumStatesFor(yncaEntry, observed, current), reported: current };
    };
  }

  /**
   * A user write to one of this controller's states, under the controller's own id relative to the
   * device — it becomes a YNCA command. The multi-transport handle has already dropped acked
   * echoes and routed only the owner's ids here (audit 2026-09-29, A32: each controller re-checked
   * both, a path production never took).
   *
   * @param stateId the state id relative to the device
   * @param value the written value
   */
  public handleWrite(stateId: string, value: unknown): Promise<WriteOutcome> | WriteOutcome | void {
    if (this.menus.handleWrite(stateId, value)) {
      return;
    }
    const zoned = splitZone(stateId);
    // A scene TITLE is as valid a recall write as its number ("Movie Viewing" → 1) — on the
    // main zone and on a zone with scenes of its own.
    const sceneTitles = this.sceneTitlesFor(stateId);
    if (sceneTitles !== undefined) {
      const num = sceneNumber(value, sceneTitles);
      if (num === undefined) {
        // A dead button has to leave a trace — this was the one write path in the adapter
        // that dropped a user action without a word (#615's lesson, applied to itself).
        this.deps.log.debug(
          `${this.deviceId}: scene "${String(value)}" is not one this device declares — write dropped ` +
            `(known: ${sceneTitles.map(scene => scene.title).join(", ") || "none yet"})`,
        );
        return;
      }
      value = num;
    }
    // The unified player writes go to the subunit the ZONE is listening to (v2.0.0) —
    // routed here, BEFORE the generic path.
    if (/^player\.(playback|repeat|shuffle|next|prev)$/.test(zoned.name)) {
      this.handlePlayerWrite(zoned.zone, zoned.name, value);
      return;
    }
    // The unified tuner writes are band-dependent (v2.0.0) and routed here, BEFORE the
    // generic path — one state, the right wire function for the active band.
    if (this.handleTunerWrite(stateId, value)) {
      return;
    }
    const target = this.writeMap.get(stateId);
    const problem = target ? writeProblem(target, value) : undefined;
    if (problem) {
      this.deps.log.debug(`${this.deviceId}: ${stateId} not written — ${problem}`);
      return "unavailable";
    }
    const triple = yncaCommand(stateId, value, this.writeMap);
    if (!triple) {
      // The one write path that still dropped a user action without a word. The special
      // routes above (scene, player, tuner, sendProven) handle their own ids; this is the
      // generic one, and it carries the majority of the writes — power, volume, input, sound
      // programme. `yncaCommand` returns nothing when this device never reported the function
      // or when the entry is read-only, and both are worth a line (audit 2026-09-06).
      this.deps.log.debug(
        `${this.deviceId}: ${stateId} is not writable on this device — write dropped ` +
          `(not reported in the sweep, or a read-only function)`,
      );
      return "unavailable";
    }
    const sent = this.deps.client.send(triple.subunit, triple.func, triple.value, triple.charset);
    this.readBack(target);
    return Promise.resolve(sent).then(verdict =>
      verdict === "ok"
        ? "sent"
        : verdict === "restricted" || verdict === "undefined"
          ? "refused"
          : verdict === "skipped"
            ? "unavailable"
            : "unclear",
    );
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
        for (const clear of PLAYER_CLEAR) {
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
   * @param none true when the device reported no value (the twin then reads "")
   */
  private routePlayerUpdate(subunit: string, id: string, value: boolean | number | string | null, none = false): void {
    // A playback time is published in both forms, from this one value: the seconds fill
    // the media-player slot, the readable text is what a visualisation shows.
    const twin = playTimeTwin(id, none ? Number.NaN : value);
    for (const zone of YNCA_ZONES) {
      if (!this.playerZones.includes(zone.key)) {
        continue;
      }
      if (playerSubunitForInput(this.zoneInputs.get(zone.key)) === subunit) {
        // Per zone, like the datapoint: what a refused source write is put back to (audit 2026-09-29, B10).
        this.reported.set(`${zone.prefix}${id}`, value);
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
    for (const clear of PLAYER_CLEAR) {
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
    const problem = writeProblem(entry, value);
    if (problem) {
      this.deps.log.debug(`${this.deviceId}: ${flatId} not written — ${problem}`);
      return;
    }
    const triple = yncaCommand(flatId, value, new Map([[flatId, entry]]));
    if (triple) {
      void this.deps.client.send(triple.subunit, triple.func, triple.value, triple.charset);
      this.readBack(entry);
    }
  }

  /**
   * Route the band-dependent tuner writes (v2.0.0 unification): ONE frequency state
   * in kHz and ONE preset state, sent to the wire function of the ACTIVE band —
   * AM/FM on the classic TUN subunit (HDRADIO on the US models), FM/DAB on the DAB subunit (whose FM half
   * shares the flat ids). A DAB frequency write is dropped: DAB tunes by service,
   * the device has no frequency command there.
   *
   * @param stateId the state id relative to the device
   * @param value the written value
   * @returns true when the id was a band-routed tuner write (handled here)
   */
  private handleTunerWrite(stateId: string, value: unknown): boolean {
    if (stateId === "tuner.frequency") {
      const written = writableNumber(value);
      if (written === undefined) {
        return true;
      }
      const khz = snapTunerFrequency(written, this.tunerBand === "AM" ? "AM" : "FM", this.freqStep);
      if (this.hasDab) {
        if (this.tunerBand === "FM") {
          this.sendProven("DAB", "FMFREQ", formatWireNumber(khz / 1000, 2));
        } else {
          this.deps.log.debug(`${this.deviceId}: DAB tunes by service — frequency write ignored`);
        }
        return true;
      }
      // The HD Radio subunit carries the AM/FM tuner of the US models — with TUN beside it or
      // (six of the seven official lists) alone.
      const amFm = this.hasHdRadio ? "HDRADIO" : "TUN";
      if (this.tunerBand === "AM") {
        this.sendProven(amFm, "AMFREQ", String(Math.round(khz)));
      } else {
        this.sendProven(amFm, "FMFREQ", formatWireNumber(khz / 1000, 2));
      }
      return true;
    }
    if (stateId === "tuner.band") {
      // Up to three subunits feed this one dropdown: on an HD Radio model every band goes to
      // HDRADIO; otherwise AM lives only on TUN, DAB only on DAB, and FM on both — on a device that has DAB its FM half lives there too (that is where its FM
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
      const slot = Math.round(writableNumber(value) ?? Number.NaN);
      if (Number.isFinite(slot) && slot >= 1) {
        this.sendProven("DAB", this.tunerBand === "DAB" ? "DABPRESET" : "FMPRESET", String(slot));
      }
      return true;
    }
    if (stateId === "tuner.preset" && this.hasHdRadio) {
      const slot = Math.round(writableNumber(value) ?? Number.NaN);
      if (Number.isFinite(slot) && slot >= 1) {
        this.sendProven("HDRADIO", "PRESET", String(slot));
      }
      return true;
    }
    if (stateId === "tuner.presetSave" || stateId === "tuner.presetUp" || stateId === "tuner.presetDown") {
      // The preset keys follow the preset itself: HD Radio's bank replaces TUN's, DAB stores its DAB and
      // FM stations (`@DAB:MEM`) and has no step keys — before, whichever entry was mapped last took the
      // write (audit 2026-09-29, B9).
      const subunit = this.hasHdRadio ? "HDRADIO" : this.hasDab && stateId === "tuner.presetSave" ? "DAB" : "TUN";
      const entry = this.presentEntries.find(candidate => candidate.id === stateId && candidate.subunit === subunit);
      const triple = entry ? yncaCommand(stateId, value, new Map([[stateId, entry]])) : undefined;
      if (triple) {
        this.sendProven(triple.subunit, triple.func, triple.value);
      } else {
        this.deps.log.debug(`${this.deviceId}: ${stateId} is not available on ${subunit} — write dropped`);
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
    void this.deps.client.send(subunit, func, wire);
    // The receiver answers a PUT only when the value changed — a frequency snapped onto the station
    // already playing, or the band already set, stood unacknowledged for good (audit 2026-09-29, B10).
    this.readBack(
      this.presentEntries.find(entry => !entry.derived && entry.subunit === subunit && entry.func === func),
    );
  }

  /**
   * The receiver was switched on while the shape the tree is built from comes from a standby read: ask every
   * function again once it is up (the same union refresh the fast path runs), so what standby refused is
   * added and the read becomes complete. Once per session at a time; the next power-on tries again.
   */
  private queueAwakeRead(): void {
    if (this.awakeReadQueued) {
      return;
    }
    this.awakeReadQueued = true;
    // Beside the proof catch-up, not behind it: both wait for the receiver to come up, and every command of
    // the refresh goes through the gate at background priority anyway. Never rejects (the refresh catches).
    void (async () => {
      try {
        // When the menus' last proof attempt is made — the receiver has had time to come up.
        await this.deps.gate.delay(POWER_ON_SETTLED_MS);
        if (!this.ended() && !this.reader.awake) {
          await this.refreshInBackground(this.catalog);
        }
      } catch (e) {
        this.deps.log.debug(`${this.deviceId}: reading the switched-on receiver failed (${errText(e)})`);
      } finally {
        this.awakeReadQueued = false;
      }
    })();
  }

  /** @returns whether the shape the objects are built from was read with the receiver switched on */
  public readComplete(): boolean {
    return this.reader.awake;
  }

  /**
   * Register the handler called once the shape becomes one of a switched-on receiver.
   *
   * @param cb the handler
   */
  public onReadComplete(cb: () => void): void {
    this.readCompleteListeners.push(cb);
  }

  /** @returns the firmware (`SYS:VERSION`) read on this connection, if any */
  public firmware(): string | undefined {
    return this.reader.firmware;
  }

  /** @returns whether the connection is closed (the controller's own close, or its gate) */
  private ended(): boolean {
    return this.closed || this.deps.gate.closed;
  }

  /**
   * One line the device sent while connected: to the browse driver, the observed store, the band
   * and input trackers, and — catalogued — into its state.
   *
   * @param message the decoded line
   */
  private handleLiveMessage(message: YncaMessage): void {
    // The menus see every line first: list lines (LINE1TXT…, LISTINFO bursts, auto-feedback) are not
    // catalogued and would otherwise be dropped, and a line may settle a proof missing since the connect.
    this.menus.handleMessage(message);
    if (message.subunit === "MAIN" && message.func === "PWR" && message.value === "On" && !this.reader.awake) {
      // Switched on while the shape comes from a standby read: what standby refused is asked again.
      this.queueAwakeRead();
    }
    // A value never seen before joins the observed store, and since 2.7.0 its dropdown too —
    // the object is rebuilt and the handle adds it within the session (before, the dropdown
    // followed one start later). The state gets the value at once either way.
    this.recordObserved(message.subunit, message.func, message.value);
    if (message.func === "BAND" && ["TUN", "DAB", "HDRADIO"].includes(message.subunit)) {
      this.tunerBand = message.value.toUpperCase();
    }
    if (message.subunit === "SYS" && message.func === "FREQSTEP") {
      this.freqStep = message.value;
    }
    if (message.func === "INP") {
      const zone = YNCA_ZONES.find(z => z.subunit === message.subunit);
      if (zone) {
        this.handleInputSwitch(zone.key, message.value);
      }
    }
    this.writeDerived(message.subunit, message.func, message.value);
    this.applyLine(message);
  }

  /**
   * Put one answered line on its datapoint — the sweep's answers and the live lines alike. An EMPTY
   * value of a read-only number is "no value" (`ELAPSEDTIME=`, `TOTALTIME=` when nothing plays,
   * `DABBITRATE=` between stations — CX-A5100, RX-V4A and RX-V6A protocols): it reads 0 and a playback
   * time's text reads "", like a source switch clears them. Before, the number decoder took nothing
   * and the previous track's time or station's bit rate stood (audit 2026-09-29, B12).
   *
   * @param message the line
   */
  private applyLine(message: YncaMessage): void {
    const entry = FUNC_MAP.get(`${message.subunit}:${message.func}`);
    const none = entry !== undefined && !entry.write && entry.spec.kind === "number" && message.value.trim() === "";
    const update = none ? { id: entry.id, value: 0 } : yncaStateUpdate(message, FUNC_MAP);
    if (!update) {
      return;
    }
    if (FLAT_PLAYER_ID.test(update.id)) {
      // Player-block values feed only the zones LISTENING to their source (v2.0.0) — an idle
      // source's leftover metadata must not seed the block.
      this.routePlayerUpdate(message.subunit, update.id, update.value, none);
    } else {
      this.reported.set(update.id, update.value);
      this.deps.setStateAck(`${this.deviceId}.${update.id}`, update.value);
    }
  }

  /**
   * The values THIS device derives from a line (see `YncaEntry.derive`): only the derived entries it
   * kept, so a device that reports the value itself is never overwritten by the derivation.
   *
   * @param subunit the line's subunit
   * @param func the line's function
   * @param wire the line's raw value
   */
  private writeDerived(subunit: string, func: string, wire: string): void {
    for (const entry of this.presentEntries) {
      if (entry.derive && entry.subunit === subunit && entry.func === func) {
        const value = entry.derive(wire);
        this.reported.set(entry.id, value);
        this.deps.setStateAck(`${this.deviceId}.${entry.id}`, value);
      }
    }
  }

  /**
   * After a user write of a READABLE function, ask the device for its value: the receiver answers
   * a PUT only when the value changed, and not at all in standby — the written value stood
   * unacknowledged for good (audit 2026-09-24, B4; the fleet rule: a value with a writable twin is
   * mirrored). Asked at user priority, so it does not wait behind a background refresh.
   *
   * @param entry the entry that was written
   */
  private readBack(entry: YncaEntry | undefined): void {
    if (!entry || entry.writeOnly || entry.spec.kind === "button") {
      return;
    }
    this.deps.client.get(entry.subunit, entry.readFunc ?? entry.func, "user");
  }

  /**
   * A refused PUT: put the device's last reported value back on the datapoint, acknowledged — the
   * written one is what the device refused (audit 2026-09-24, B4).
   *
   * @param command the refused line (`@SUBUNIT:FUNC=value`)
   */
  private restoreRefused(command: string): void {
    const parsed = /^@([A-Z0-9]+):([A-Z0-9]+)=/.exec(command);
    const entry = parsed
      ? this.presentEntries.find(e => !e.derived && e.subunit === parsed[1] && e.func === parsed[2])
      : undefined;
    if (!entry) {
      return;
    }
    // A source write names no zone: every zone listening to that source shows it, and each is put back
    // to the value it showed (audit 2026-09-29, B10).
    const ids = FLAT_PLAYER_ID.test(entry.id)
      ? YNCA_ZONES.filter(
          zone =>
            this.playerZones.includes(zone.key) &&
            playerSubunitForInput(this.zoneInputs.get(zone.key)) === entry.subunit,
        ).map(zone => `${zone.prefix}${entry.id}`)
      : [entry.id];
    for (const id of ids) {
      const value = this.reported.get(id);
      if (value !== undefined) {
        this.deps.setStateAck(`${this.deviceId}.${id}`, value);
      }
    }
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
    this.closed = true;
    this.menus.close();
    this.deps.client.close();
  }
}
