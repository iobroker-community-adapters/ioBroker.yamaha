import type { YncaCapabilities } from "./ynca/capability";
import type { ObjectDef } from "./catalog/types";
import type { ConnectionHandle, ControllerLog } from "./controller";
import {
  YNCA_CATALOG,
  availGets,
  funcToEntry,
  idToEntry,
  sweepGets,
  yncaCommand,
  yncaObjectsFor,
  yncaStateUpdate,
  type YncaEntry,
} from "./ynca/catalog";
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

/**
 * Functions whose VALUE cannot change while the device runs: the 23 assignable input names
 * and the 12 scene names. They cost 35 of the ~187 paced reads of a targeted sweep (3.5 s
 * at the specification's mandatory 100 ms spacing) and answer the same thing every time, so
 * a reconnect reuses what the first connect learned. Deliberately per adapter RUN, not
 * persisted: renaming an input at the receiver shows up after the next adapter restart
 * rather than needing anyone to invalidate a stored file.
 */
const STATIC_FUNC = /^(INPNAME|SCENE\d+NAME$)/;

/** Memory key for the remembered static values. */
const STATIC_KEY = "yncaStaticValues";

/**
 * The functions whose presence proves a subunit really serves menus — the fields a real
 * `LISTINFO=?` answer is made of (RX-A810 reference log). See {@link YncaDeviceController.probeBrowseSubunits}.
 */
const LIST_PROOF = /^(LISTLAYER|LISTLAYERNAME|CURRLINE|MAXLINE|LINE[1-8](TXT|ATRIB))$/;

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
    const capabilities = await this.sweepDevice(catalog);
    const objects = yncaObjectsFor(capabilities, catalog);
    if (objects.length === 0) {
      this.deps.log.warn(`${this.deviceId}: no capabilities reported — creating no objects`);
      return false;
    }
    // Parents before children (channels before their states) — created in order.
    for (const object of objects) {
      await this.deps.upsertObject(`${this.deviceId}.${object.id}`, object);
    }
    // Seed the states with the values read during the init sweep — otherwise they
    // stay empty until the device pushes a change of its own.
    for (const [subunit, funcs] of Object.entries(capabilities.subunits)) {
      for (const [func, value] of Object.entries(funcs)) {
        const update = yncaStateUpdate({ subunit, func, value }, FUNC_MAP);
        if (update) {
          this.deps.setStateAck(`${this.deviceId}.${update.id}`, update.value);
        }
      }
    }
    await this.setupBrowse(capabilities);
    this.deps.client.onMessage(message => {
      // The browse driver sees every line first: list lines (LINE1TXT…, LISTINFO
      // bursts, auto-feedback) are not catalogued and would otherwise be dropped.
      this.browseDriver?.handleMessage(message);
      const update = yncaStateUpdate(message, FUNC_MAP);
      if (update) {
        this.deps.setStateAck(`${this.deviceId}.${update.id}`, update.value);
      }
    });
    // Start the keepalive only now the sweep is done, so its 30 s poll never collides
    // with the paced init sweep.
    this.deps.client.startKeepalive();
    // The adapter logs one combined "ready" line across all transports; this per-transport line
    // stays at debug for diagnostics.
    this.deps.log.debug(`${this.deviceId}: ${capabilities.model || "device"} ready (YNCA)`);
    return true;
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
   * @returns the assembled capabilities
   */
  private async sweepDevice(catalog: readonly YncaEntry[]): Promise<YncaCapabilities> {
    const cached = this.deps.subunitCache?.get();
    if (cached) {
      // Check the device's IDENTITY first (two reads, ~0.2 s) instead of sweeping and
      // finding out afterwards: the old order cost a full targeted sweep, then the probe,
      // then a second sweep (~40 s) whenever the cache was stale — slower than having no
      // cache at all.
      const identity = await this.deps.client.readCapabilities([
        { subunit: "SYS", func: "MODELNAME" },
        { subunit: "SYS", func: "VERSION" },
      ]);
      const firmware = identity.subunits.SYS?.VERSION ?? "";
      if (identity.model === cached.model && firmware === cached.firmware) {
        return await this.targetedSweep(catalog, new Set(cached.subunits));
      }
      // The device behind this IP changed (swap or firmware update) — re-probe.
      this.deps.log.debug(`${this.deviceId}: cached subunit set is stale (model/firmware changed), re-probing`);
      this.deps.subunitCache?.clear();
    }
    const probe = await this.deps.client.readCapabilities(AVAIL_PROBE);
    const present = new Set(Object.keys(probe.subunits));
    if (present.size === 0) {
      // Device ignores AVAIL — sweep blind so no function is lost.
      return await this.deps.client.readCapabilities(sweepGets(catalog));
    }
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
    const gets = sweepGets(catalog).filter(get => get.subunit === "SYS" || present.has(get.subunit));
    const remembered = this.deps.probeMemory?.remembered<Record<string, Record<string, string>>>(STATIC_KEY);
    // Second connect onwards: skip those reads and put the remembered answers back in, so
    // the objects are built exactly as if the device had answered them again.
    const capabilities = await this.deps.client.readCapabilities(
      remembered ? gets.filter(get => !STATIC_FUNC.test(get.func)) : gets,
    );
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
    if (stateId.startsWith("player.browse.")) {
      this.browseEngine?.handleWrite(stateId, value);
      return;
    }
    const triple = yncaCommand(stateId, value, ID_MAP);
    if (triple) {
      this.deps.client.send(triple.subunit, triple.func, triple.value);
    }
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
    const present = await this.probeBrowseSubunits(capabilities);
    if (present.size === 0) {
      // Leaving the states uncreated is what hands browsing to another transport: the owner
      // policy ranks by modernity (yxc > ynca > xml), so an unproven YNCA claim would beat a
      // PROVEN xml one and the user would get an empty menu on a device that can browse over
      // XML — exactly issue #613's RX-V473.
      this.deps.log.debug(`${this.deviceId}: no YNCA source answers LISTINFO — leaving menus to another transport`);
      return;
    }
    const driver = new YncaBrowseDriver(this.deps.client, present, delay);
    this.browseEngine = await createBrowseSurface(driver, this.deviceId, {
      upsertObject: this.deps.upsertObject,
      emit: (id, value) => this.deps.setStateAck(`${this.deviceId}.${id}`, value),
      log: this.deps.log,
      delay,
    });
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
   * @returns the subunits that answered with list data
   */
  private async probeBrowseSubunits(capabilities: YncaCapabilities): Promise<ReadonlySet<string>> {
    const candidates = YNCA_BROWSE_SOURCES.filter(source => source.subunit in capabilities.subunits);
    if (candidates.length === 0) {
      return new Set();
    }
    // A receiver in standby answers @RESTRICTED for its media subunits, which is
    // indistinguishable from "cannot browse" and would strip the menus off a device that
    // serves them perfectly once it is on. Nobody browses a sleeping receiver, so keep the
    // claim and let the next connect — with the device awake — do the real probe.
    if (capabilities.subunits.MAIN?.PWR !== "On") {
      return new Set(candidates.map(source => source.subunit));
    }
    const answer = await this.deps.client.readCapabilities(
      candidates.map(source => ({ subunit: source.subunit, func: "LISTINFO" })),
    );
    // Only a real list answer counts. Both refusals — `@UNDEFINED` (function unknown) and
    // `@RESTRICTED` (source not usable right now) — carry no subunit, so they cannot be
    // attributed to one request; it is the ABSENCE of an answer that excludes a subunit.
    return new Set(
      candidates
        .map(source => source.subunit)
        .filter(subunit => Object.keys(answer.subunits[subunit] ?? {}).some(func => LIST_PROOF.test(func))),
    );
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
