import type { YncaCapabilities } from "./capability";
import { yncaGenerationEvidence, YNCA_ZONES } from "./catalog";
import type { YncaClientLike } from "./client-like";
import type { YncaMessage } from "./protocol";
import type { ControllerDepsBase } from "../controller";
import { splitZone } from "../catalog/zones";
import { errText } from "../err-text";
import type { BrowseEngine } from "../browse/browse-engine";
import { createBrowseSurface } from "../browse/surface";
import { remoteObjectDefs } from "../browse/objects";
import { wireFor, type CursorValue, type MenuValue, type WireTable } from "../browse/types";
import {
  YNCA_BROWSE_SOURCES,
  YncaBrowseDriver,
  yncaZonePadWires,
  type YncaPadDialect,
} from "../browse/ynca-browse-driver";
import { MEMORY_KEY } from "../lifecycle/memory-keys";

/**
 * The menus of a YNCA receiver — the browse surface (`player.browse.*`), the on-screen pad of the main zone and of
 * zones 2 and 3 — and the PROOFS they rest on: which sources serve a list, which key dialect the pad speaks, which
 * zones have a pad. A proof is remembered per device once given and caught up when a receiver that stood by at
 * connect is switched on (forum 85413). Taken out of the controller (review 2026-10-05, D), behaviour unchanged.
 */

/**
 * Memory key for the pad dialect a PROBE proved: `{ dialect, proven: true }` (`zone` = the 2015 generation's
 * CURSOR/MENU). A bare string is what 2.12.0 learned from a single refused key press — it counts as unknown and is
 * probed again (audit 2026-09-24, B3).
 */
const PAD_DIALECT_KEY = MEMORY_KEY.yncaPadDialect;

/** Per zone, whether its pad answered the bracketed probe (`{ zone2: true, zone3: false }`, B9). */
const ZONE_PAD_KEY = MEMORY_KEY.yncaZonePads;

/**
 * Memory key for the menu sources a LISTINFO answer proved: `{ subunits, proven: true }`. Remembered like every other
 * ability of the device (the XML menu probe, the pad dialect): what a receiver can browse does not change when it
 * stands by, and it stands by most of the time — asked only at connect, the proof was missing on most starts and XML
 * took the menus over (forum 85413, 2026-10-02). Only a proof is remembered: a source that answered nothing is asked
 * again.
 */
const BROWSE_PROOF_KEY = MEMORY_KEY.yncaBrowseSources;

/**
 * When a proof still missing at connect is asked for after the receiver reports `PWR=On` — waits between the
 * attempts (5, 15 and 30 s after the line). How long a network module needs after power-on is not measured; a list
 * line the device sends on its own proves a source at once anyway, and every later power-on tries again.
 */
const POWER_ON_PROOF_WAITS_MS = [5_000, 10_000, 15_000];

/**
 * How long after `PWR=On` the last menu-proof attempt is made (5 + 10 + 15 s) — when the controller asks for the
 * functions a standby read could not get.
 */
export const POWER_ON_SETTLED_MS = POWER_ON_PROOF_WAITS_MS.reduce((sum, wait) => sum + wait, 0);

/**
 * The functions whose presence proves a subunit really serves menus — the fields a real `LISTINFO=?` answer is made
 * of (RX-A810 reference log). See {@link YncaMenus.probeBrowseSubunits}.
 */
const LIST_PROOF = /^(LISTLAYER|LISTLAYERNAME|CURRLINE|MAXLINE|LINE[1-8](TXT|ATRIB))$/;

/**
 * A remembered pad dialect, if a probe proved it.
 *
 * @param remembered what the memory holds under {@link PAD_DIALECT_KEY}
 * @returns the proven dialect, or undefined
 */
function provenPadDialect(remembered: unknown): YncaPadDialect | undefined {
  const entry = remembered as { dialect?: unknown; proven?: unknown } | undefined;
  return entry?.proven === true && (entry.dialect === "list" || entry.dialect === "zone" || entry.dialect === "none")
    ? entry.dialect
    : undefined;
}

/**
 * The menu sources a remembered proof names (API boundary — the persisted memory is untrusted).
 *
 * @param remembered what the memory holds under {@link BROWSE_PROOF_KEY}
 * @returns the proven source subunits, empty without a proof
 */
function provenBrowseSources(remembered: unknown): string[] {
  const entry = remembered as { subunits?: unknown; proven?: unknown } | undefined;
  if (entry?.proven !== true || !Array.isArray(entry.subunits)) {
    return [];
  }
  // Only strings; a name this device does not carry is dropped against its candidates (probeBrowseSubunits).
  return entry.subunits.filter((subunit): subunit is string => typeof subunit === "string");
}

/** What the menus are built with: the controller's own deps. */
export interface YncaMenusDeps extends ControllerDepsBase {
  /** The device's YNCA client — the driver sends through it, the proofs read through it. */
  client: Pick<YncaClientLike, "readCapabilities" | "probeKnown" | "send" | "get">;
  /** Whether a datapoint group is enabled (the menus belong to `player.*`). Absent = all enabled. */
  isEntryEnabled?(id: string): boolean;
}

/** The menus of one YNCA receiver and the proofs they rest on (see the module comment). */
export class YncaMenus {
  private browseDriver: YncaBrowseDriver | undefined;
  private browseEngine: BrowseEngine | undefined;
  /** The zones whose pad the probe proved, with the generation's key words (B9). */
  private readonly zonePads = new Map<
    string,
    { subunit: string; cursor: WireTable<CursorValue>; menu: WireTable<MenuValue> }
  >();
  /** Whether a refused pad key already triggered its one re-probe of the dialect this session. */
  private padReprobed = false;
  /** The live capabilities the menus and the pads were set up from (generation evidence, zones). */
  private browseShape: YncaCapabilities = { model: "", subunits: {} };
  /** The menu sources the surface was built for. */
  private browsePresent: ReadonlySet<string> = new Set();
  /** The menu sources claimed WITHOUT a proof (standby at connect, nothing remembered) — empty once proven. */
  private unprovenBrowse: ReadonlySet<string> = new Set();
  /** The zones whose pad probe came back unclear (a receiver in standby) — asked again once it is on. */
  private readonly unclearZonePads = new Set<string>();
  /** The catch-up of missing proofs (power-on, a list line) — one at a time, in order. */
  private catchUp: Promise<void> = Promise.resolve();
  /** Whether a power-on catch-up is queued or running, so a second `PWR=On` adds none. */
  private powerOnCatchUp = false;
  /** Set by {@link close} — a catch-up still queued or waiting ends there. */
  private closed = false;

  /**
   * @param deviceId the id-safe device id (object-tree path segment)
   * @param deps the client and adapter callbacks
   */
  public constructor(
    private readonly deviceId: string,
    private readonly deps: YncaMenusDeps,
  ) {}

  /**
   * Set the menus up from what the device answered at connect: the browse surface where a source proves its list,
   * and the pads of zones 2 and 3.
   *
   * @param live the capability report with the decisive values read live
   */
  public async setup(live: YncaCapabilities): Promise<void> {
    this.browseShape = live;
    await this.setupBrowse(live);
    await this.setupZonePads(live);
  }

  /**
   * One line the device sent: to the browse driver first — list lines (LINE1TXT…, LISTINFO bursts, auto-feedback)
   * are not catalogued and would otherwise be dropped — and then as a possible proof.
   *
   * @param message the decoded line
   */
  public handleMessage(message: YncaMessage): void {
    this.browseDriver?.handleMessage(message);
    this.noticeProofs(message);
  }

  /**
   * A user write to a menu datapoint — the remote pad, a zone's pad or the browse surface.
   *
   * @param stateId the state id relative to the device
   * @param value the written value
   * @returns true when the id was a menu datapoint (handled here)
   */
  public handleWrite(stateId: string, value: unknown): boolean {
    if (stateId.startsWith("remote.")) {
      this.browseEngine?.handleRemoteWrite(stateId, value);
      return true;
    }
    const zoned = splitZone(stateId);
    if (zoned.zone !== "main" && (zoned.name === "remote.cursor" || zoned.name === "remote.menu")) {
      this.handleZonePadWrite(zoned.zone, zoned.name === "remote.cursor" ? "cursor" : "menu", value);
      return true;
    }
    if (stateId.startsWith("player.browse.")) {
      this.browseEngine?.handleWrite(stateId, value);
      return true;
    }
    return false;
  }

  /**
   * The device refused a user command: a pad key it does not know (`@UNDEFINED`) may mean the dialect is wrong —
   * asked again, once per session, by the probe (never learned from the refusal itself: a refusal alone is no proof).
   *
   * @param command the refused line
   * @param verdict the device's verdict
   */
  public onRefused(command: string, verdict: "restricted" | "undefined"): void {
    const padKey = /^@MAIN:(LISTCURSOR|LISTMENU|CURSOR|MENU)=(.+)$/.exec(command);
    if (verdict === "undefined" && padKey && !this.padReprobed) {
      this.padReprobed = true;
      void this.reprobePad(padKey[1], padKey[2]);
    }
  }

  /** Close the surface — a catch-up still queued or waiting ends there. */
  public close(): void {
    this.closed = true;
    this.browseEngine?.close();
    this.browseDriver?.close();
  }

  /**
   * Create the browsing surface (#613) when the device reports a browsable media subunit: the official YNCA list
   * vocabulary (LISTINFO/LISTSEL/LISTPAGE/LISTCURSOR) drives an 8-line window under `player.browse.*`. Skipped when
   * the playback group is switched off.
   *
   * @param capabilities the device's swept capabilities
   */
  private async setupBrowse(capabilities: YncaCapabilities): Promise<void> {
    if (this.deps.isEntryEnabled?.("player.browse.source") === false) {
      return;
    }
    const { subunits: present, proven } = await this.probeBrowseSubunits(capabilities);
    if (present.size === 0) {
      // Leaving the states uncreated is what hands browsing to another transport: the owner policy ranks by
      // modernity (yxc > ynca > xml), so an unproven YNCA claim would beat a PROVEN xml one and the user would get an
      // empty menu on a device that can browse over XML — exactly issue #613's RX-V473.
      this.deps.log.debug(`${this.deviceId}: no YNCA source answers LISTINFO — leaving menus to another transport`);
      return;
    }
    this.unprovenBrowse = proven ? new Set() : present;
    await this.buildBrowse(present, proven);
  }

  /**
   * Build the menu surface for the given sources — at connect, and again when a proof missing at connect arrives
   * later in the session. Its objects then come without the `unproven` mark, the transport adapter reports the
   * changed definitions, and the handle learns the proof: YNCA takes the menus over from the transport that held them
   * meanwhile, once and for good (forum 85413).
   *
   * @param present the menu sources to offer
   * @param proven whether a LISTINFO answer proved them (now or remembered)
   */
  private async buildBrowse(present: ReadonlySet<string>, proven: boolean): Promise<void> {
    const gate = this.deps.gate;
    const delay = (ms: number): Promise<void> => gate.delay(ms);
    this.browseEngine?.close();
    this.browseDriver?.close();
    this.browseEngine = undefined;
    this.browseDriver = undefined;
    const driver = new YncaBrowseDriver(
      this.deps.client,
      present,
      delay,
      await this.padDialect(proven),
      yncaGenerationEvidence(this.browseShape.subunits),
    );
    const engine = await createBrowseSurface(
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
    this.browsePresent = present;
    if (engine) {
      this.browseEngine = engine;
      this.browseDriver = driver;
    }
  }

  /**
   * A line the device sent may settle a proof still missing from the connect: a list field of a source claimed
   * without proof IS that proof (the receiver sends its menu lines on its own — the predecessor adapter never asked
   * for them and showed them all the same), and `MAIN:PWR=On` is the moment to ask for every proof a standby connect
   * could not get.
   *
   * @param message the decoded line
   */
  private noticeProofs(message: YncaMessage): void {
    // No closed-check here: every step re-checks when it runs (adoptBrowseProof, catchUpAfterPowerOn).
    if (this.unprovenBrowse.has(message.subunit) && LIST_PROOF.test(message.func)) {
      // A burst of lines queues one step per line; every one after the first finds the proof taken.
      this.queueCatchUp(() => this.adoptBrowseProof(new Set([message.subunit])));
      return;
    }
    if (message.subunit === "MAIN" && message.func === "PWR" && message.value === "On" && this.proofsMissing()) {
      if (!this.powerOnCatchUp) {
        this.powerOnCatchUp = true;
        this.queueCatchUp(async () => {
          try {
            await this.catchUpAfterPowerOn();
          } finally {
            this.powerOnCatchUp = false;
          }
        });
      }
    }
  }

  /**
   * Run one catch-up step after the ones already queued. Never rejects: a failure lands in the debug log, and the
   * next power-on tries again.
   *
   * @param step the step
   */
  private queueCatchUp(step: () => Promise<void>): void {
    this.catchUp = this.catchUp.then(async () => {
      try {
        await step();
      } catch (e) {
        this.deps.log.debug(`${this.deviceId}: catching up a missing proof failed (${errText(e)})`);
      }
    });
  }

  /** @returns whether the connection is closed (the menus' own close, or the gate's) */
  private ended(): boolean {
    return this.closed || this.deps.gate.closed;
  }

  /** @returns whether a proof the connect could not get is still missing */
  private proofsMissing(): boolean {
    return this.unprovenBrowse.size > 0 || this.unclearZonePads.size > 0 || this.padDialectMissing();
  }

  /** @returns whether the menus are proven but the pad dialect was not proven yet (a standby connect) */
  private padDialectMissing(): boolean {
    return (
      this.browseDriver !== undefined &&
      this.unprovenBrowse.size === 0 &&
      yncaGenerationEvidence(this.browseShape.subunits).pad &&
      provenPadDialect(this.deps.probeMemory.remembered(PAD_DIALECT_KEY)) === undefined
    );
  }

  /**
   * The receiver was switched on: ask for what the standby connect could not prove — the menu sources, the pad
   * dialect, the zone pads. Up to three times ({@link POWER_ON_PROOF_WAITS_MS}), ending early once nothing is
   * missing.
   */
  private async catchUpAfterPowerOn(): Promise<void> {
    for (const wait of POWER_ON_PROOF_WAITS_MS) {
      await this.deps.gate.delay(wait);
      if (this.ended()) {
        return;
      }
      if (this.unprovenBrowse.size > 0) {
        const fresh = await this.proveBrowseSources([...this.unprovenBrowse]);
        if (fresh.size > 0) {
          await this.adoptBrowseProof(fresh);
        }
      }
      const driver = this.browseDriver;
      if (driver && this.padDialectMissing()) {
        // Proven now, the dialect is remembered (padDialect). LIST and ZONE offer the same keys, so the driver just
        // switches; NONE offers no pad at all — that surface is built once more without it.
        const dialect = await this.padDialect(true);
        if (dialect === "none" && driver.padDialect !== "none") {
          await this.buildBrowse(this.browsePresent, true);
        } else if (dialect !== driver.padDialect) {
          driver.usePadDialect(dialect);
        }
      }
      if (this.unclearZonePads.size > 0) {
        await this.setupZonePads(this.browseShape, new Set(this.unclearZonePads));
      }
      if (!this.proofsMissing()) {
        return;
      }
    }
  }

  /**
   * Take a proof that arrived after the connect: remember it, and rebuild the surface for the proven sources (plus
   * the ones remembered) — no longer marked unproven.
   *
   * @param proven the sources just proven
   */
  private async adoptBrowseProof(proven: ReadonlySet<string>): Promise<void> {
    if (this.unprovenBrowse.size === 0 || this.ended()) {
      return;
    }
    const sources = this.rememberBrowseProof(proven);
    this.unprovenBrowse = new Set();
    this.deps.log.debug(`${this.deviceId}: menus proven over YNCA (${[...sources].join(", ")}) — taking them over`);
    await this.buildBrowse(sources, true);
  }

  /**
   * Ask the candidate sources for their list (`LISTINFO=?`) and keep the ones that answer with list fields. Both
   * refusals — `@UNDEFINED` (function unknown) and `@RESTRICTED` (not usable right now) — carry no subunit, so they
   * cannot be attributed to one request; it is the ABSENCE of an answer that excludes a source.
   *
   * @param candidates the source subunits to ask
   * @returns the sources that answered with list data
   */
  private async proveBrowseSources(candidates: readonly string[]): Promise<Set<string>> {
    const answer = await this.deps.client.readCapabilities(candidates.map(subunit => ({ subunit, func: "LISTINFO" })));
    return new Set(
      candidates.filter(subunit => Object.keys(answer.subunits[subunit] ?? {}).some(func => LIST_PROOF.test(func))),
    );
  }

  /**
   * Remember proven menu sources together with the ones already remembered — a source proven once stays proven; a
   * refusal later (standby, a network module not ready yet) takes nothing away.
   *
   * @param proven the sources just proven
   * @returns every proven source (remembered and new)
   */
  private rememberBrowseProof(proven: ReadonlySet<string>): Set<string> {
    const remembered = provenBrowseSources(this.deps.probeMemory.remembered(BROWSE_PROOF_KEY));
    const all = new Set([...remembered, ...proven]);
    if (all.size > 0 && all.size !== remembered.length) {
      this.deps.probeMemory.set(BROWSE_PROOF_KEY, { subunits: [...all], proven: true });
    }
    return all;
  }

  /**
   * The on-screen pad of zones 2 and 3 where the device has one (`@ZONE2:LISTCURSOR`/`LISTMENU`, the 2011/2012
   * Aventage lists — B9). Write-only keys, so the proof is a bracketed probe: silence is "known", `@UNDEFINED`
   * "unknown"; an unclear answer (a zone in standby) decides nothing and is asked again once the receiver reports
   * `PWR=On` (noticeProofs). A definite verdict is remembered per device.
   *
   * @param capabilities what the device answered (its subunits and generation)
   * @param only the zones to set up — the unclear ones of the connect, when caught up later
   */
  private async setupZonePads(capabilities: YncaCapabilities, only?: ReadonlySet<string>): Promise<void> {
    if (!only) {
      this.zonePads.clear();
      this.unclearZonePads.clear();
    }
    const generation = yncaGenerationEvidence(capabilities.subunits);
    if (!generation.pad) {
      return;
    }
    const stored = this.deps.probeMemory.remembered<unknown>(ZONE_PAD_KEY);
    const remembered: Record<string, boolean> =
      typeof stored === "object" && stored !== null ? { ...(stored as Record<string, boolean>) } : {};
    let learned = false;
    for (const zone of YNCA_ZONES) {
      if (zone.key === "main" || capabilities.subunits[zone.subunit] === undefined || (only && !only.has(zone.key))) {
        continue;
      }
      let has = typeof remembered[zone.key] === "boolean" ? remembered[zone.key] : undefined;
      if (has === undefined) {
        try {
          const verdict = (await this.deps.client.probeKnown(zone.subunit, ["LISTCURSOR"])).LISTCURSOR;
          if (verdict === "known" || verdict === "undefined") {
            has = verdict === "known";
            remembered[zone.key] = has;
            learned = true;
          }
        } catch (e) {
          this.deps.log.debug(`${this.deviceId}: probing the ${zone.key} pad failed (${errText(e)})`);
        }
      }
      if (has === undefined) {
        this.unclearZonePads.add(zone.key);
        continue;
      }
      this.unclearZonePads.delete(zone.key);
      if (!has) {
        continue;
      }
      const wires = yncaZonePadWires(generation);
      for (const def of remoteObjectDefs(Object.keys(wires.cursor), Object.keys(wires.menu), zone.prefix)) {
        await this.deps.upsertObject(`${this.deviceId}.${def.id}`, def);
      }
      this.zonePads.set(zone.key, { subunit: zone.subunit, ...wires });
    }
    if (learned) {
      this.deps.probeMemory.set(ZONE_PAD_KEY, remembered);
    }
  }

  /**
   * A key press on a zone's pad → `@ZONEn:LISTCURSOR` / `LISTMENU` in the generation's word.
   *
   * @param zoneKey the zone (`zone2`, `zone3`)
   * @param pad which pad the key belongs to
   * @param value the written key word
   */
  private handleZonePadWrite(zoneKey: string, pad: "cursor" | "menu", value: unknown): void {
    const zone = this.zonePads.get(zoneKey);
    const word = typeof value === "string" ? value : "";
    const wire = zone ? wireFor<CursorValue | MenuValue>(pad === "cursor" ? zone.cursor : zone.menu, word) : undefined;
    if (!zone || wire === undefined) {
      this.deps.log.debug(`${this.deviceId}: ${zoneKey} ${pad} key "${word}" is none this zone has — not sent`);
      return;
    }
    void this.deps.client.send(zone.subunit, pad === "cursor" ? "LISTCURSOR" : "LISTMENU", wire);
  }

  /**
   * The pad dialect: a proven memory, else a bracketed probe of `@MAIN:LISTCURSOR` and `@MAIN:CURSOR` — only on a
   * device that is on and proved its menus, else `list` unremembered.
   *
   * @param proven whether the device proved its menus in this start (it is on)
   * @returns the dialect to drive the pad with
   */
  private async padDialect(proven: boolean): Promise<YncaPadDialect> {
    const remembered = provenPadDialect(this.deps.probeMemory.remembered(PAD_DIALECT_KEY));
    if (remembered) {
      return remembered;
    }
    if (!proven) {
      return "list";
    }
    const verdicts = await this.deps.client.probeKnown("MAIN", ["LISTCURSOR", "CURSOR"]);
    // Both unknown to the device: it has no pad, and none is offered (audit 2026-09-29, B5).
    const dialect: YncaPadDialect | undefined =
      verdicts.LISTCURSOR === "known"
        ? "list"
        : verdicts.LISTCURSOR === "undefined" && verdicts.CURSOR === "known"
          ? "zone"
          : verdicts.LISTCURSOR === "undefined" && verdicts.CURSOR === "undefined"
            ? "none"
            : undefined;
    if (!dialect) {
      return "list";
    }
    this.deps.probeMemory.set(PAD_DIALECT_KEY, { dialect, proven: true });
    return dialect;
  }

  /**
   * A pad key came back `@UNDEFINED`: probe the dialect again and, when it turns out to be the other one, switch,
   * remember and send the key once more in it.
   *
   * @param func the refused function
   * @param wire the refused wire value
   */
  private async reprobePad(func: string, wire: string): Promise<void> {
    const driver = this.browseDriver;
    if (!driver) {
      return;
    }
    try {
      const before = driver.padDialect;
      const known = this.deps.probeMemory.remembered(PAD_DIALECT_KEY);
      this.deps.probeMemory.drop(key => key === PAD_DIALECT_KEY);
      const after = await this.padDialect(true);
      // An unclear answer proves nothing: the dialect proven before stays remembered.
      if (known !== undefined && this.deps.probeMemory.remembered(PAD_DIALECT_KEY) === undefined) {
        this.deps.probeMemory.set(PAD_DIALECT_KEY, known);
      }
      if (after !== before) {
        driver.usePadDialect(after);
        this.deps.log.info(
          `${this.deviceId}: the pad speaks the ${after === "zone" ? "CURSOR/MENU" : "LIST"} dialect — switched`,
        );
        driver.resend(func, wire);
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: probing the pad dialect failed (${errText(e)})`);
    }
  }

  /**
   * Which browsable subunits actually SERVE menus, proven by asking them.
   *
   * Carrying the subunit is NOT proof: the RX-A810 reference log answers `@SERVER:LISTINFO=?` with `@UNDEFINED` while
   * NETRADIO/PC/USB on the very same device return a full window. The XML driver has always probed (`List_Info` →
   * `<Menu_Status>`); YNCA claimed the states on presence alone and, ranking higher, silently displaced the transport
   * that could deliver.
   *
   * A proof is remembered per device ({@link BROWSE_PROOF_KEY}) and stands from then on — in standby too, which is
   * where a receiver spends most of its time (forum 85413).
   *
   * @param capabilities the device's swept capabilities
   * @returns the subunits that proved their menus, and whether that is a PROOF
   */
  private async probeBrowseSubunits(
    capabilities: YncaCapabilities,
  ): Promise<{ subunits: ReadonlySet<string>; proven: boolean }> {
    const candidates = YNCA_BROWSE_SOURCES.filter(source => source.subunit in capabilities.subunits).map(
      source => source.subunit,
    );
    if (candidates.length === 0) {
      return { subunits: new Set(), proven: true };
    }
    const remembered = new Set(
      provenBrowseSources(this.deps.probeMemory.remembered(BROWSE_PROOF_KEY)).filter(subunit =>
        candidates.includes(subunit),
      ),
    );
    // A receiver in standby answers @RESTRICTED for its media subunits, which is indistinguishable from "cannot
    // browse" — it is not asked. A remembered proof stands.
    if (capabilities.subunits.MAIN?.PWR !== "On") {
      if (remembered.size > 0) {
        return { subunits: remembered, proven: true };
      }
      // Nothing proven yet: claimed, but NOT proven — the coordinator hands the surface to a transport that could
      // prove it (XML probes at any power state) until the receiver is switched on and the proof is caught up
      // (noticeProofs). Claimed as proven, a receiver in standby at adapter start displaced the driver that works on
      // the 2012 generation (#613 through the standby door, audit 2026-09-06).
      return { subunits: new Set(candidates), proven: false };
    }
    // Only a real list answer counts; together with the remembered proof, which a refusal now (a network module not
    // ready yet) does not take away.
    return { subunits: this.rememberBrowseProof(await this.proveBrowseSources(candidates)), proven: true };
  }
}
