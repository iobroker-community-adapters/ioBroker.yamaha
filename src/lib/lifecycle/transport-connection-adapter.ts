import { channelCommon, type ObjectDef } from "../catalog/types";
import { canonicalIdOf, ID_DRIFT, type Transport } from "../catalog/owner-policy";
import { ZONE_PREFIX } from "../catalog/zones";
import type { TransportCapture } from "../diagnostics/types";
import type { TransportConnection, WriteOutcome } from "./multi-transport-handle";

/**
 * Inverse of the id drifts: canonical template → the transport's own template (for routing writes back).
 * Derived from `ID_DRIFT`, so a new drift cannot be forgotten on the way back (audit 2026-09-29, C46).
 */
const INVERSE_DRIFT: Partial<Record<Transport, Readonly<Record<string, string>>>> = Object.fromEntries(
  Object.entries(ID_DRIFT).map(([transport, drift]) => [
    transport,
    Object.fromEntries(Object.entries(drift ?? {}).map(([own, canonical]) => [canonical, own])),
  ]),
);

/** The controller shape the adapter drives: start, a device-relative user write, the drop handler, an optional liveness check, and close. */
export interface AdaptedController {
  /** Connect, probe, and build the object tree (through the injected deps). */
  start(): Promise<boolean>;
  /**
   * Apply a user write under the controller's own id, relative to the device. A controller that can say
   * what became of it returns the outcome; nothing returned means nothing can be said (no fallback).
   */
  handleWrite(stateId: string, value: unknown): void | WriteOutcome | Promise<WriteOutcome | void>;
  /** Register a drop handler. */
  onDrop(cb: (reason?: Error) => void): void;
  /** Whether what the controller built comes from a switched-on receiver (see TransportConnection). */
  readComplete?(): boolean;
  /** Register the handler called once the controller's read became complete. */
  onReadComplete?(cb: () => void): void;
  /** The firmware version the controller read on this connection. */
  firmware?(): string | undefined;
  /** Ask the device once, now; report a drop if it does not answer (the polled transports). */
  verifyAlive?(): Promise<void>;
  /** Close the connection. */
  close(): void;
}

/**
 * Presents an existing transport controller as a {@link TransportConnection} without changing it.
 * The controller is built with this adapter's intercept deps: its upserts are collected (their ids
 * canonicalized) instead of written, and its state writes are filtered to the ids the object-tree
 * coordinator assigned this transport. A user write is routed back under the controller's own
 * (drift-reversed) id. This keeps the three controllers untouched behind the multi-transport handle.
 */
export class TransportConnectionAdapter implements TransportConnection {
  /** Canonical id → the def last collected for it (a later upsert of the same id replaces it). */
  private readonly collected = new Map<string, ObjectDef>();
  /** Canonical id → the controller's own id it built the datapoint with — a write goes back under it (A16). */
  private readonly ownIds = new Map<string, string>();
  /** The canonical ids this transport owns, as the handle armed them last — undefined until the first arming. */
  private owned: ReadonlySet<string> | undefined;
  private controller: AdaptedController | undefined;
  /** The diagnostics read of this transport's client, set by the builder that owns the client. */
  private reader: (() => Promise<TransportCapture>) | undefined;
  private shapeChanged: (() => void) | undefined;
  /**
   * The collection changed since the handle last took it ({@link buildObjects}). The handle is told once per
   * such change — a refresh that republishes 1000 objects is one learn, not 1000 (review 2026-10-05, F1) — and
   * a change that landed while it was not listening yet is told the moment it registers (A8).
   */
  private unseen = false;
  /**
   * The last value the controller reported per canonical id, owned or not — the one store of values this adapter
   * keeps (review 2026-10-05, F: a buffer and a wait list stood beside it for the same job). An id the handle
   * hands this transport for the first time gets its value from here at once: the controller will not repeat a
   * value that did not change (audit 2026-09-24, C21).
   */
  private readonly latest = new Map<string, boolean | number | string | null>();
  /**
   * A zone folder this transport names differently from the tree (`zone2` → `zoneB`): MusicCast serves a
   * Zone B as its zone2 (YXC Basic Rev 1.10 §4.2), YNCA and the tree call it Zone B (audit 2026-09-29, C29).
   */
  private zoneAlias: { from: string; to: string } | undefined;

  /**
   * @param transport the transport this adapts
   * @param deviceId the id-safe device id (object-tree path segment)
   * @param setStateAck the real ack-write, called only for the states this transport owns
   */
  public constructor(
    public readonly transport: Transport,
    private readonly deviceId: string,
    private readonly setStateAck: (id: string, value: boolean | number | string | null) => void,
  ) {}

  /**
   * The upsertObject the controller is built with — collects its objects (canonicalized), not writing.
   *
   * @param _fullId the controller's full object id (unused; the canonical id is derived from the def)
   * @param def the object definition the controller built
   * @returns a resolved promise (the controller's upsert dep is async)
   */
  public readonly interceptUpsert = (_fullId: string, def: ObjectDef): Promise<void> => {
    const id = this.canonical(def.id);
    this.ownIds.set(id, this.relative(def.id));
    // The renamed zone folder itself takes the name and explanation of its tree id.
    const renamedFolder = this.zoneAlias !== undefined && id === `multiroom.${this.zoneAlias.to}` && def.id !== id;
    const object: ObjectDef = {
      ...def,
      id,
      ...(renamedFolder ? { common: { ...def.common, ...channelCommon(this.zoneAlias!.to) } } : {}),
    };
    // Only a REAL change counts: a controller may re-upsert the same definition freely (a refresh republishes
    // everything), and a signal per push would re-fingerprint the whole tree.
    const previous = this.collected.get(object.id);
    if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(object)) {
      return Promise.resolve();
    }
    this.collected.set(object.id, object);
    // A controller that learns something mid-session (a function answered by a background refresh or a push, an
    // XML status field delivered for the first time, a dropdown grown by an observed value) tells the handle, which
    // learns what is new — once, until the handle takes the collection again.
    if (!this.unseen) {
      this.unseen = true;
      this.shapeChanged?.();
    }
    return Promise.resolve();
  };

  /**
   * The setStateAck the controller is built with — written at once for an id this transport owns, kept as the
   * id's last value for every other one: before the first arming, for a datapoint the handle has not learned yet,
   * and for one another transport owns.
   *
   * @param fullId the controller's full state id
   * @param value the state value the controller wrote
   */
  public readonly interceptSetStateAck = (fullId: string, value: boolean | number | string | null): void => {
    const canonicalId = this.canonical(this.relative(fullId));
    this.latest.set(canonicalId, value);
    if (this.owned?.has(canonicalId)) {
      this.setStateAck(`${this.deviceId}.${canonicalId}`, value);
    }
  };

  /**
   * Bind the built controller (constructed with the intercept deps above).
   *
   * @param controller the controller to drive
   */
  public bind(controller: AdaptedController): void {
    this.controller = controller;
  }

  /**
   * Give this transport its diagnostics read. Set by the builder that holds the client, so the read
   * goes through the same client and command gate as everything else on this connection.
   *
   * @param reader reads the device verbatim, changing nothing
   */
  public readWith(reader: () => Promise<TransportCapture>): void {
    this.reader = reader;
  }

  /**
   * Read the device for a diagnostics report.
   *
   * @returns the capture, or undefined when this transport has no read
   */
  public async capture(): Promise<TransportCapture | undefined> {
    return this.reader?.();
  }

  /** Start the controller (connect + probe + collect objects). Call before {@link buildObjects}. */
  public async connect(): Promise<boolean> {
    return (await this.controller?.start()) ?? false;
  }

  /**
   * The objects the controller built, canonicalized, in first-seen order. Valid after {@link connect}. This is the
   * handle's snapshot: a change after it is told again (see {@link onShapeChanged}).
   *
   * @returns the collected definitions
   */
  public buildObjects(): readonly ObjectDef[] {
    this.unseen = false;
    return [...this.collected.values()];
  }

  /**
   * Register the handle's learn callback (2.7.0): called once when the collection changed since the handle's last
   * snapshot ({@link buildObjects}). A change that landed between that snapshot and this registration — during the
   * handle's first learn, a list grown by a push, an XML field seen for the first time — is told at once: it was
   * lost before, with its value, until some later unrelated change (review 2026-10-05, A8).
   *
   * @param cb invoked when the collection changed
   */
  public onShapeChanged(cb: () => void): void {
    this.shapeChanged = cb;
    if (this.unseen) {
      cb();
    }
  }

  /**
   * Arm the owned filter. Every id this arming hands the transport for the first time gets the last value the
   * controller reported for it — the first arming (the values of the connect), a datapoint learned mid-session,
   * an id a re-coordination handed over (C21).
   *
   * @param owned the canonical ids this transport owns
   */
  public seedOwned(owned: ReadonlySet<string>): void {
    const previous = this.owned;
    this.owned = owned;
    for (const [id, value] of this.latest) {
      if (owned.has(id) && !previous?.has(id)) {
        this.setStateAck(`${this.deviceId}.${id}`, value);
      }
    }
  }

  /**
   * Route a user write to the controller under its own id: EXACTLY the id it built the datapoint with. Derived back
   * from the canonical id, every `multiroom.zoneB.*` id became `multiroom.zone2.*` — also one the controller had
   * built under `zoneB` itself (`multiroom.zoneB.volumeSync`), which it then did not find: the RX-V481's Zone B
   * volume sync was never sent (review 2026-10-05, A16). The derivation stays for an id the controller never built.
   *
   * @param canonicalId the canonical state id the user wrote
   * @param value the value written
   * @returns what the controller made of it — `unclear` when it cannot say
   */
  public async handleWrite(canonicalId: string, value: unknown): Promise<WriteOutcome> {
    const controllerId = this.ownIds.get(canonicalId) ?? this.derivedOwnId(canonicalId);
    const outcome = await this.controller?.handleWrite(controllerId, value);
    return outcome ?? (this.controller ? "unclear" : "unavailable");
  }

  /**
   * The controller's id for a canonical id it never built: the zone folder named back, the id drift reversed.
   *
   * @param canonicalId the canonical id
   * @returns the controller's id
   */
  private derivedOwnId(canonicalId: string): string {
    const own = this.unalias(canonicalId);
    const zone = ZONE_PREFIX.exec(own)?.[0] ?? "";
    const template = own.slice(zone.length);
    return zone + (INVERSE_DRIFT[this.transport]?.[template] ?? template);
  }

  /** @returns whether the controller's read comes from a switched-on receiver (true when it cannot tell) */
  public readComplete(): boolean {
    return this.controller?.readComplete?.() ?? true;
  }

  /**
   * Forward the handle's read-complete handler to the controller.
   *
   * @param cb called once the controller's read became complete
   */
  public onReadComplete(cb: () => void): void {
    this.controller?.onReadComplete?.(cb);
  }

  /** @returns the firmware version the controller read on this connection, if any */
  public firmware(): string | undefined {
    return this.controller?.firmware?.();
  }

  /**
   * Register a drop handler; forwarded to the controller.
   *
   * @param cb called when the transport drops
   */
  public onDrop(cb: (reason?: Error) => void): void {
    this.controller?.onDrop(cb);
  }

  /** Forward the handle's liveness question to a controller that can answer it. */
  public async verifyAlive(): Promise<void> {
    await this.controller?.verifyAlive?.();
  }

  /** Close the controller (synchronous — safe from onUnload). */
  public close(): void {
    this.controller?.close();
  }

  private relative(fullId: string): string {
    const prefix = `${this.deviceId}.`;
    return fullId.startsWith(prefix) ? fullId.slice(prefix.length) : fullId;
  }

  /**
   * Name one of this transport's zone folders as the tree does (`zone2` → `zoneB`). Called by the
   * controller before it builds its objects.
   *
   * @param from the transport's zone segment
   * @param to the tree's zone segment
   */
  public aliasZone(from: string, to: string): void {
    this.zoneAlias = { from, to };
  }

  /**
   * The tree id of one of the controller's ids — drift resolved, zone folder renamed.
   *
   * @param id the controller's (device-relative or full) id
   * @returns the canonical id
   */
  private canonical(id: string): string {
    const canonical = canonicalIdOf(this.transport, this.relative(id));
    const alias = this.zoneAlias;
    if (alias === undefined) {
      return canonical;
    }
    const from = `multiroom.${alias.from}`;
    return canonical === from || canonical.startsWith(`${from}.`)
      ? `multiroom.${alias.to}${canonical.slice(from.length)}`
      : canonical;
  }

  private unalias(id: string): string {
    const alias = this.zoneAlias;
    if (alias === undefined) {
      return id;
    }
    const to = `multiroom.${alias.to}`;
    return id === to || id.startsWith(`${to}.`) ? `multiroom.${alias.from}${id.slice(to.length)}` : id;
  }
}
