import { mergeYncaSubunits, type YncaCapabilities } from "./capability";
import {
  availGets,
  bundleGets,
  planSweep,
  SYS_FUNCTION_FAMILIES,
  sweepGets,
  YNCA_CATALOG,
  YNCA_ZONES,
  type InputEvidence,
  type YncaEntry,
} from "./catalog";
import type { YncaClientLike } from "./client-like";
import type { YncaSubunitCache } from "./subunit-cache";
import type { ControllerLog } from "../controller";
import type { ProbeMemory } from "../lifecycle/probe-memory";
import { MEMORY_KEY } from "../lifecycle/memory-keys";

/**
 * Reading and keeping the capability SHAPE of a YNCA receiver — which subunits it has, which functions they answer,
 * with which values — and every rule about what of it is kept and what is let go, in one place (review 2026-10-05,
 * D: the rules stood spread over the controller, and A1, A25 and A39 sat exactly between them).
 *
 * What a start reads and remembers:
 * - the identity (model + firmware) — the key every remembered answer is valid for;
 * - the AVAIL snapshot (`YncaSubunitCache`): which subunits answered `AVAIL=?`, and which were asked;
 * - the shape (`yncaCapabilities`): the subunit → function → value map the object tree is built from, with whether it
 *   was read from a switched-on receiver;
 * - the names the user gives in the receiver (`yncaStaticValues`): input and scene names.
 */

/** Memory key for the remembered names (input and scene names). */
const STATIC_KEY = MEMORY_KEY.yncaStaticValues;

/** Memory key for the persisted capability shape (the fast-restart layer). */
const CAPS_KEY = MEMORY_KEY.yncaCapabilities;

/**
 * The memory keys that hold what the receiver answered over YNCA — all of them valid for one identity only: a
 * different receiver (or firmware) behind the address voids every one.
 */
const YNCA_KEYS: ReadonlySet<string> = new Set([
  CAPS_KEY,
  STATIC_KEY,
  MEMORY_KEY.yncaObserved,
  MEMORY_KEY.yncaPadDialect,
  MEMORY_KEY.yncaZonePads,
  MEMORY_KEY.yncaBrowseSources,
]);

/**
 * The functions whose answers are names the user gives in the receiver: the assignable input names and the scene
 * names (12 on the main zone, SCENE1–4NAME on each of zones 2–4).
 */
export const NAME_FUNC = /^(INPNAME|SCENE\d+NAME$)/;

/** The AVAIL probe over the FULL catalog (not the group-filtered one): the snapshot reflects the device, never a setting. */
const AVAIL_PROBE = availGets(YNCA_CATALOG);

/** The subunits the AVAIL probe asks — the set a silent subunit is judged absent against. */
const PROBED_SUBUNITS: ReadonlySet<string> = new Set(AVAIL_PROBE.map(get => get.subunit));

/** The persisted capability shape, keyed by the device identity that validated it. */
interface CachedCapabilities {
  /** SYS MODELNAME at capture time — freshness key half 1. */
  model: string;
  /** SYS VERSION at capture time — freshness key half 2. */
  firmware: string;
  /**
   * The captured subunit→function map (values are last-known, used for SHAPE only). A sweep whose
   * closing marker went unanswered may lack functions; the background refresh of every later start
   * unions its answers into this shape and never takes one away, so a short first sweep heals.
   */
  subunits: Record<string, Record<string, string>>;
  /**
   * Whether this shape was read with the receiver switched on — a receiver in standby answers many functions
   * `@RESTRICTED`, so a shape read then lacks what it has. Missing (an older profile) counts as not yet.
   */
  awake?: boolean;
}

/**
 * Whether a remembered value carries the cached-capabilities shape (API boundary — the persisted probe memory is
 * untrusted storage).
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
 * The XML `System>Config` declaration as input evidence, when the XML transport remembered one for this device (the
 * probe memory is shared by the three transports): the source flags prove a source absent, the input names add an
 * input. Absent or malformed → nothing.
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

/** What the shape reader is built with. */
export interface YncaShapeReaderDeps {
  /** The device's YNCA client — the reader only reads. */
  client: Pick<YncaClientLike, "readCapabilities">;
  /** The device's memory (shared by the three transports; the reader keeps the YNCA keys). */
  probeMemory: ProbeMemory;
  /** The device's AVAIL snapshot, held across reconnects and restarts. */
  subunitCache: YncaSubunitCache;
  /** Adapter log. */
  log: ControllerLog;
}

/** Reads a YNCA receiver's capability shape and keeps it by its rules (see the module comment). */
export class YncaShapeReader {
  /**
   * The subunits the AVAIL probe asked THIS device — the set a silent source is judged absent against. Empty when
   * the device ignored the probe (blind sweep) or when the remembered snapshot came from another firmware: silence
   * then proves nothing and no source is dropped.
   */
  private probedSubunits: ReadonlySet<string> = new Set();
  /** The subunits that answered the AVAIL probe (or were remembered as answering, same identity). */
  private presentSubunits = new Set<string>();
  /** The firmware (`SYS:VERSION`) read on this connection. */
  private firmwareRead: string | undefined;
  /** Whether the shape the objects are built from was read with the receiver switched on. */
  private awakeRead = false;

  /**
   * @param deviceId the id-safe device id (for the log)
   * @param deps the client, the memory and the snapshot
   */
  public constructor(
    private readonly deviceId: string,
    private readonly deps: YncaShapeReaderDeps,
  ) {}

  /** @returns the firmware (`SYS:VERSION`) read on this connection, if any */
  public get firmware(): string | undefined {
    return this.firmwareRead;
  }

  /** @returns whether the shape was read with the receiver switched on */
  public get awake(): boolean {
    return this.awakeRead;
  }

  /**
   * The device's capabilities — from the persisted fast-restart layer when the LIVE identity (model + firmware,
   * three paced reads with the wake-up read, ~0.3 s) matches what the layer was captured from, else from the full
   * two-pass sweep. The identity read doubles as the liveness proof the ready line rests on: a cached shape alone
   * must never present a dead device as connected (the v1.5.0 honesty rule).
   *
   * @param catalog the (group-filtered) catalog
   * @returns the capabilities and whether they came from the persisted layer
   */
  public async resolve(catalog: readonly YncaEntry[]): Promise<{ capabilities: YncaCapabilities; fromCache: boolean }> {
    // The first command after the receiver's power-save state can be lost (ynca-python `protocol.py` sends two
    // keepalives on connect for that reason): a leading wake-up read, so the identity is not read as "" and every
    // remembered YNCA answer dropped for it (audit 2026-09-24, B1).
    const identity = await this.deps.client.readCapabilities([
      { subunit: "SYS", func: "MODELNAME" },
      { subunit: "SYS", func: "MODELNAME" },
      { subunit: "SYS", func: "VERSION" },
    ]);
    const model = identity.model;
    const firmware = identity.subunits.SYS?.VERSION ?? "";
    this.firmwareRead = firmware || undefined;
    const remembered = this.deps.probeMemory.remembered(CAPS_KEY);
    if (model && isCachedCapabilities(remembered) && remembered.model === model && remembered.firmware === firmware) {
      // The remembered subunit snapshot is proof for narrowing ONLY from the same identity: a snapshot of another
      // firmware says nothing about which sources this device has now.
      const cached = this.deps.subunitCache.get();
      if (cached && cached.model === model && cached.firmware === firmware) {
        // Only what the snapshot ASKED is judged: a subunit the catalog gained later was never probed and must not
        // read as absent (audit 2026-09-24, B11).
        this.probedSubunits = new Set(cached.probed ?? []);
        this.presentSubunits = new Set(cached.subunits);
      }
      this.awakeRead = remembered.awake === true;
      return { capabilities: { model, subunits: remembered.subunits }, fromCache: true };
    }
    if (remembered !== undefined && model) {
      // A different (or updated) device behind this address: its remembered YNCA answers are void — the observed
      // values, the pad verdicts and the menu proof too. The other transports guard their own portions. An EMPTY
      // model is no identity at all (a lost first command), not another device.
      this.deps.probeMemory.drop(key => YNCA_KEYS.has(key));
    }
    const capabilities = await this.sweepDevice(catalog, model, firmware);
    if (capabilities.model) {
      const captured = capabilities.subunits.SYS?.VERSION ?? firmware;
      // The same receiver read again (the identity read lost its first answer, so the fast path did not run): what it
      // proved before stays — a sweep in standby answers many functions @RESTRICTED.
      const same =
        isCachedCapabilities(remembered) && remembered.model === capabilities.model && remembered.firmware === captured;
      const subunits = same ? mergeYncaSubunits(remembered.subunits, capabilities.subunits) : capabilities.subunits;
      const awake = (same && remembered.awake === true) || capabilities.subunits.MAIN?.PWR === "On";
      this.deps.probeMemory.set(CAPS_KEY, {
        model: capabilities.model,
        firmware: captured,
        subunits,
        awake,
      } satisfies CachedCapabilities);
      this.awakeRead = awake;
      return { capabilities: { model: capabilities.model, subunits }, fromCache: false };
    }
    // No model, no identity — and without an identity nothing can ever invalidate what was remembered. The names are
    // written by the sweep regardless, so leaving them behind froze them for good on a device that does not answer
    // SYS:MODELNAME. The two keys live and die together.
    this.deps.probeMemory.drop(key => key === STATIC_KEY);
    return { capabilities, fromCache: false };
  }

  /**
   * Re-read the handful of values the START makes DECISIONS from, and lay them over the remembered shape (fresh
   * wins).
   *
   * The persisted capability layer is a shape whose values are the last run's leftovers — the type says so ("used
   * for SHAPE only"). Three decisions used them anyway, and a receiver stands in standby most of the time, so the
   * memory usually says `PWR=Standby`:
   * - the menu claim skips its proof while the device is not on, so a stale "Standby" made YNCA claim
   *   `player.browse.*` UNPROVEN and displace the XML driver that does probe — issue #613, brought back in through
   *   the cache;
   * - a `tuner.frequency` write is routed by the band, so a stale band sends AMFREQ where FMFREQ belongs (a wrong
   *   command on the wire, not just a stale reading);
   * - the player's transport buttons are routed by the zone's input, so a stale input sends play/pause to the source
   *   the zone listened to LAST time.
   *
   * Eight reads at most (~0.8 s through the gate), once per connect. A drop during them fails the connect — which is
   * honest: the device is gone.
   *
   * @param remembered the capability shape from the persisted layer
   * @returns the remembered shape with the live answers laid over it
   */
  public async readDecisive(remembered: YncaCapabilities): Promise<YncaCapabilities> {
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
   * Re-ask every catalogued function of the present subunits and grow the remembered shape by the answers — the
   * fast path's value refresh, and the read that completes a standby read-in once the receiver is on. Completion
   * refreshes the persisted layers (capabilities, names); the union never takes an ability away.
   *
   * @param catalog the (group-filtered) catalog
   * @returns the grown shape, or undefined when the refresh ran into a drop
   */
  public async refresh(catalog: readonly YncaEntry[]): Promise<YncaCapabilities | undefined> {
    const cached = this.deps.subunitCache.get();
    const gets = sweepGets(catalog).filter(
      get => get.subunit === "SYS" || !cached || cached.subunits.includes(get.subunit),
    );
    // The same plan as the targeted sweep: the union with the remembered shape below keeps every function a fuller
    // sweep ever answered, so a skipped GET shrinks nothing here.
    const fresh = await this.sweepInPasses(planSweep(gets, this.inputEvidence({ model: "", subunits: {} })));
    if (!fresh.model) {
      // The refresh ran into a drop — the supervisor handles the reconnect.
      return undefined;
    }
    const statics: Record<string, Record<string, string>> = {};
    for (const [subunit, funcs] of Object.entries(fresh.subunits)) {
      for (const [func, value] of Object.entries(funcs)) {
        if (NAME_FUNC.test(func)) {
          (statics[subunit] ??= {})[func] = value;
        }
      }
    }
    // The names a refresh did not get back this time stay remembered (a standby refresh answers less).
    const rememberedStatics = this.deps.probeMemory.remembered<Record<string, Record<string, string>>>(STATIC_KEY);
    for (const [subunit, funcs] of Object.entries(rememberedStatics ?? {})) {
      statics[subunit] = { ...funcs, ...statics[subunit] };
    }
    this.deps.probeMemory.set(STATIC_KEY, statics);
    // UNION with the remembered shape (same identity — the fast path proved it): a refresh while the device stands by
    // answers many functions @RESTRICTED and must not strip abilities it proved while awake; a lean standby FIRST
    // capture heals on the next awake refresh instead of staying lean forever (datapoint review finding, 2.0.2).
    const remembered = this.deps.probeMemory.remembered(CAPS_KEY);
    const subunits = isCachedCapabilities(remembered)
      ? mergeYncaSubunits(remembered.subunits, fresh.subunits)
      : fresh.subunits;
    const awake = (isCachedCapabilities(remembered) && remembered.awake === true) || fresh.subunits.MAIN?.PWR === "On";
    this.deps.probeMemory.set(CAPS_KEY, {
      model: fresh.model,
      firmware: fresh.subunits.SYS?.VERSION ?? "",
      subunits,
      awake,
    } satisfies CachedCapabilities);
    this.awakeRead = this.awakeRead || awake;
    return { model: fresh.model, subunits };
  }

  /**
   * What this connect learned about the device's inputs: the probe's verdicts (present / asked), every subunit that
   * answered anything, and the XML declaration when remembered.
   *
   * @param capabilities the capability report of this connect
   * @returns the evidence the per-zone input lists are derived from
   */
  public inputEvidence(capabilities: YncaCapabilities): InputEvidence {
    const present = new Set([...this.presentSubunits, ...Object.keys(capabilities.subunits)]);
    return {
      present,
      probed: this.probedSubunits,
      ...xmlInputEvidence(this.deps.probeMemory.remembered(MEMORY_KEY.xmlConfig)),
    };
  }

  /**
   * Read the device's capabilities with the two-pass sweep. Pass 1 probes each catalogued subunit with `AVAIL=?`
   * (~2 s); pass 2 sweeps only the subunits that answered, plus SYS (which never answers AVAIL) — on a typical
   * receiver that saves a third or more of the ~39 s blind sweep. A cached probe result (per device, surviving
   * reconnects and restarts) skips pass 1 except for the subunits the snapshot never asked; a device whose model or
   * firmware no longer matches the cache re-probes. A device that answers no AVAIL at all falls back to the full
   * blind sweep, so an unknown firmware loses speed, never features.
   *
   * @param catalog the (group-filtered) catalog whose functions to sweep
   * @param model the live-read SYS model name (from resolve)
   * @param firmware the live-read SYS firmware version
   * @returns the assembled capabilities
   */
  private async sweepDevice(catalog: readonly YncaEntry[], model: string, firmware: string): Promise<YncaCapabilities> {
    const cached = this.deps.subunitCache.get();
    // An empty model is no identity (a lost first command, B1): the cache is neither used nor cleared — a fresh probe
    // runs and its result replaces it.
    if (cached && model) {
      // The device's IDENTITY was already read (three reads, ~0.3 s) — checking it BEFORE sweeping is what keeps a
      // stale cache from costing a full targeted sweep, then the probe, then a second sweep (~40 s).
      if (model === cached.model && firmware === cached.firmware) {
        // A subunit the catalog gained after the snapshot was never asked — asked now, and only those; a snapshot
        // from before the list was kept is asked in full once (B11).
        const asked = new Set(cached.probed ?? []);
        const unasked = AVAIL_PROBE.filter(get => !asked.has(get.subunit));
        const present = new Set(cached.subunits);
        if (unasked.length > 0) {
          const extra = await this.deps.client.readCapabilities(unasked);
          for (const subunit of Object.keys(extra.subunits)) {
            present.add(subunit);
          }
          this.deps.subunitCache.set({ subunits: [...present], probed: [...PROBED_SUBUNITS], model, firmware });
        }
        this.probedSubunits = PROBED_SUBUNITS;
        this.presentSubunits = present;
        return await this.targetedSweep(catalog, present);
      }
      // The device behind this IP changed (swap or firmware update) — re-probe.
      this.deps.log.debug(`${this.deviceId}: cached subunit set is stale (model/firmware changed), re-probing`);
      this.deps.subunitCache.clear();
    }
    const probe = await this.deps.client.readCapabilities(AVAIL_PROBE);
    const present = new Set(Object.keys(probe.subunits));
    if (present.size === 0) {
      // Device ignores AVAIL — sweep blind so no function is lost. And silence is no proof: `probedSubunits` stays
      // empty, so no source is judged absent (advisor round 2026-09-09).
      return await this.deps.client.readCapabilities(sweepGets(catalog));
    }
    this.probedSubunits = PROBED_SUBUNITS;
    this.presentSubunits = present;
    const capabilities = await this.targetedSweep(catalog, present);
    if (capabilities.model) {
      const captured = capabilities.subunits.SYS?.VERSION ?? "";
      // The same receiver probed again: a subunit it answered before stays — never replaced by a smaller probe.
      const same = cached !== undefined && cached.model === capabilities.model && cached.firmware === captured;
      this.deps.subunitCache.set({
        subunits: same ? [...new Set([...cached.subunits, ...present])] : [...present],
        probed: [...PROBED_SUBUNITS],
        model: capabilities.model,
        firmware: captured,
      });
    }
    return capabilities;
  }

  /**
   * Sweep only the present subunits' functions (SYS always included — it answers no AVAIL but carries
   * model/firmware/master power).
   *
   * @param catalog the (group-filtered) catalog whose functions to sweep
   * @param present the subunits that answered the AVAIL probe
   * @returns the assembled capabilities
   */
  private async targetedSweep(catalog: readonly YncaEntry[], present: ReadonlySet<string>): Promise<YncaCapabilities> {
    // The bundles of every present subunit first (BASIC: one GET answers 15–25 functions at once, the official lists;
    // ynca-python reads it the same way — and SCENENAME, SIGINFO, RDSINFO, METAINFO likewise). Every function a bundle
    // answered is proof and is not asked again individually; a function it lacks is still asked — a bundle is
    // additive, never a filter (the RX-V1067 leaves functions out of BASIC that it does answer on their own,
    // ynca-python: "Not in BASIC on RX-V1067"). A subunit without the bundle answers nothing (`@UNDEFINED` carries no
    // subunit) and loses nothing.
    const basic = await this.readBundles(present);
    const answered = new Set(
      Object.entries(basic.subunits).flatMap(([subunit, funcs]) =>
        Object.keys(funcs).map(func => `${subunit}:${func}`),
      ),
    );
    const gets = sweepGets(catalog).filter(
      get => (get.subunit === "SYS" || present.has(get.subunit)) && !answered.has(`${get.subunit}:${get.func}`),
    );
    const remembered = this.deps.probeMemory.remembered<Record<string, Record<string, string>>>(STATIC_KEY);
    // The zone table, the absent sources and the SYS families decide what is worth sending (2.7.0, `planSweep`); a
    // function a bundle answered is proof already, whatever the table says. Second connect onwards the statics are
    // skipped too and the remembered answers put back in, so the objects are built exactly as if the device had
    // answered them again.
    const plan = planSweep(
      remembered ? gets.filter(get => !NAME_FUNC.test(get.func)) : gets,
      this.inputEvidence(basic),
    );
    const swept = await this.sweepInPasses(plan);
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
        if (NAME_FUNC.test(func)) {
          (statics[subunit] ??= {})[func] = value;
        }
      }
    }
    this.deps.probeMemory.set(STATIC_KEY, statics);
    return capabilities;
  }

  /**
   * Send a planned sweep: the first pass, then — only for the SYS families whose head answered in it — the family
   * members (`planSweep`, `SYS_FUNCTION_FAMILIES`). One GET on the head decides up to 43 GETs of a family a device has
   * as a whole or not at all.
   *
   * @param plan the planned GET lists
   * @returns the merged answers of both passes
   */
  private async sweepInPasses(plan: ReturnType<typeof planSweep>): Promise<YncaCapabilities> {
    const first = await this.deps.client.readCapabilities(plan.first);
    const answeredHeads = SYS_FUNCTION_FAMILIES.filter(family => first.subunits.SYS?.[family.head] !== undefined);
    const second = plan.families.filter(get => answeredHeads.some(family => get.func.startsWith(family.prefix)));
    if (second.length === 0) {
      return first;
    }
    const members = await this.deps.client.readCapabilities(second);
    return { model: first.model || members.model, subunits: mergeYncaSubunits(first.subunits, members.subunits) };
  }

  /**
   * Read every bundle of the present subunits (BASIC and SCENENAME per zone, SIGINFO/RDSINFO on the tuner, METAINFO
   * per player — see `bundleGets`) in ONE paced request list; the answers are ordinary `@SUBUNIT:FUNC=value` lines
   * the collector absorbs. Nothing to ask (no subunit present, e.g. a blind sweep) → an empty report without a wire
   * round trip.
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
}
