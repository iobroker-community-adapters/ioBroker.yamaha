import type { ObjectDef } from "../catalog/types";
import { canonicalIdOf, ZONE_PREFIX, type Transport } from "../catalog/owner-policy";
import type { TransportConnection } from "./multi-transport-handle";

/** Inverse of the id drifts: canonical template → the transport's own template (for routing writes back). */
const INVERSE_DRIFT: Partial<Record<Transport, Readonly<Record<string, string>>>> = {
  yxc: { "sound.subwooferTrim": "subwooferVolume", "multiroom.party": "multiroom.partyEnable" },
  xml: { "hdmi.out1": "hdmiOut1", "hdmi.out2": "hdmiOut2" },
};

/** The controller shape the adapter drives — a {@link import("../controller").ConnectionHandle} plus its async start. */
export interface AdaptedController {
  /** Connect, probe, and build the object tree (through the injected deps). */
  start(): Promise<boolean>;
  /** Apply a state change under the controller's own id. */
  handleStateChange(fullStateId: string, ack: boolean, value: unknown): void;
  /** Register a drop handler. */
  onDrop(cb: (reason?: Error) => void): void;
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
  private readonly buffered: Array<{ canonicalId: string; value: boolean | number | string }> = [];
  private owned: ReadonlySet<string> | undefined;
  private controller: AdaptedController | undefined;
  private shapeChanged: (() => void) | undefined;
  /** Ids upserted since the last {@link seedOwned} — their values wait for the re-coordination. */
  private readonly awaitingOwnership = new Set<string>();

  /**
   * @param transport the transport this adapts
   * @param deviceId the id-safe device id (object-tree path segment)
   * @param setStateAck the real ack-write, called only for the states this transport owns
   */
  public constructor(
    public readonly transport: Transport,
    private readonly deviceId: string,
    private readonly setStateAck: (id: string, value: boolean | number | string) => void,
  ) {}

  /**
   * The upsertObject the controller is built with — collects its objects (canonicalized), not writing.
   *
   * @param _fullId the controller's full object id (unused; the canonical id is derived from the def)
   * @param def the object definition the controller built
   * @returns a resolved promise (the controller's upsert dep is async)
   */
  public readonly interceptUpsert = (_fullId: string, def: ObjectDef): Promise<void> => {
    const object: ObjectDef = { ...def, id: this.canonical(def.id) };
    const previous = this.collected.get(object.id);
    this.collected.set(object.id, object);
    // While the handle has not coordinated yet (the connect's own upserts), the collection is
    // simply filled — it coordinates once afterwards. Later, a controller that learns something
    // mid-session (a function answered by a background refresh or a push, an XML status field
    // delivered for the first time, a dropdown grown by an observed value) signals the handle,
    // which re-coordinates the live set. Only a REAL change signals: a controller may re-upsert
    // the same definition freely, and a signal per push would re-fingerprint the whole tree.
    if (this.owned && JSON.stringify(previous) !== JSON.stringify(object)) {
      this.awaitingOwnership.add(object.id);
      this.shapeChanged?.();
    }
    return Promise.resolve();
  };

  /**
   * The setStateAck the controller is built with — owned-filtered live; buffered until owned is known.
   *
   * @param fullId the controller's full state id
   * @param value the state value the controller wrote
   */
  public readonly interceptSetStateAck = (fullId: string, value: boolean | number | string): void => {
    const canonicalId = this.canonical(this.relative(fullId));
    if (this.owned?.has(canonicalId)) {
      this.setStateAck(`${this.deviceId}.${canonicalId}`, value);
      return;
    }
    // Before the first ownership arming, and for an object this transport created SINCE that
    // arming (it is owned only after the handle re-coordinated), the value waits. An id the
    // adapter never built is another transport's business and is dropped as before.
    if (!this.owned || this.awaitingOwnership.has(canonicalId)) {
      this.buffered.push({ canonicalId, value });
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

  /** Start the controller (connect + probe + collect objects). Call before {@link buildObjects}. */
  public async connect(): Promise<boolean> {
    return (await this.controller?.start()) ?? false;
  }

  /** The objects the controller built, canonicalized, in first-seen order. Valid after {@link connect}. */
  public buildObjects(): readonly ObjectDef[] {
    return [...this.collected.values()];
  }

  /**
   * Register the handle's re-coordination callback (2.7.0). Called when an upsert after the
   * first coordination really changed the shape — never during connect.
   *
   * @param cb invoked on every shape change
   */
  public onShapeChanged(cb: () => void): void {
    this.shapeChanged = cb;
  }

  /**
   * Arm the owned filter and flush the buffered seeds for the owned ids.
   *
   * @param owned the canonical ids this transport owns
   */
  public seedOwned(owned: ReadonlySet<string>): void {
    this.owned = owned;
    // Values that waited for this arming: delivered when the id landed here, dropped when it
    // did not (another transport owns it). Either way the wait ends — the buffer stays bounded.
    for (const seed of this.buffered.splice(0)) {
      if (owned.has(seed.canonicalId)) {
        this.setStateAck(`${this.deviceId}.${seed.canonicalId}`, seed.value);
      }
    }
    this.awaitingOwnership.clear();
  }

  /**
   * Route a user write to the controller under its own (drift-reversed, zone-kept) id.
   *
   * @param canonicalId the canonical state id the user wrote
   * @param ack whether the write is acked
   * @param value the value written
   */
  public handleWrite(canonicalId: string, ack: boolean, value: unknown): void {
    const zone = ZONE_PREFIX.exec(canonicalId)?.[0] ?? "";
    const template = canonicalId.slice(zone.length);
    const controllerId = zone + (INVERSE_DRIFT[this.transport]?.[template] ?? template);
    this.controller?.handleStateChange(`${this.deviceId}.${controllerId}`, ack, value);
  }

  /**
   * Register a drop handler; forwarded to the controller.
   *
   * @param cb called when the transport drops
   */
  public onDrop(cb: (reason?: Error) => void): void {
    this.controller?.onDrop(cb);
  }

  /** Close the controller (synchronous — safe from onUnload). */
  public close(): void {
    this.controller?.close();
  }

  private relative(fullId: string): string {
    const prefix = `${this.deviceId}.`;
    return fullId.startsWith(prefix) ? fullId.slice(prefix.length) : fullId;
  }

  private canonical(id: string): string {
    return canonicalIdOf(this.transport, this.relative(id));
  }
}
