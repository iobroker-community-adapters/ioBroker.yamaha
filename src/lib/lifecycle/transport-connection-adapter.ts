import type { ObjectDef } from "../catalog/types";
import { canonicalIdOf, type Transport } from "../catalog/owner-policy";
import type { TransportConnection } from "./multi-transport-handle";

/** Inverse of the id drifts: canonical template → the transport's own template (for routing writes back). */
const INVERSE_DRIFT: Partial<Record<Transport, Readonly<Record<string, string>>>> = {
  ynca: { bass: "sound.bass", treble: "sound.treble" },
  yxc: { subwooferTrim: "subwooferVolume", party: "partyEnable" },
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
  private readonly collected: ObjectDef[] = [];
  private readonly buffered: Array<{ canonicalId: string; value: boolean | number | string }> = [];
  private owned: ReadonlySet<string> | undefined;
  private controller: AdaptedController | undefined;

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
    this.collected.push({ ...def, id: this.canonical(def.id) });
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
    if (this.owned) {
      if (this.owned.has(canonicalId)) {
        this.setStateAck(`${this.deviceId}.${canonicalId}`, value);
      }
    } else {
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

  /** The objects the controller built, canonicalized. Valid after {@link connect}. */
  public buildObjects(): readonly ObjectDef[] {
    return this.collected;
  }

  /**
   * Arm the owned filter and flush the buffered seeds for the owned ids.
   *
   * @param owned the canonical ids this transport owns
   */
  public seedOwned(owned: ReadonlySet<string>): void {
    this.owned = owned;
    for (const seed of this.buffered) {
      if (owned.has(seed.canonicalId)) {
        this.setStateAck(`${this.deviceId}.${seed.canonicalId}`, seed.value);
      }
    }
    this.buffered.length = 0;
  }

  /**
   * Route a user write to the controller under its own (drift-reversed, zone-kept) id.
   *
   * @param canonicalId the canonical state id the user wrote
   * @param ack whether the write is acked
   * @param value the value written
   */
  public handleWrite(canonicalId: string, ack: boolean, value: unknown): void {
    const zone = /^zone[234]\./.exec(canonicalId)?.[0] ?? "";
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
