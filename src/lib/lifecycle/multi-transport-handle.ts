import type { ObjectDef } from "../catalog/types";
import { coordinateObjectTree, type TransportObjects } from "../catalog/object-tree-coordinator";
import type { Transport } from "../catalog/owner-policy";
import type { ConnectionHandle, ControllerLog } from "../controller";

/**
 * One transport's live connection, as the {@link MultiTransportHandle} drives it. The transport
 * builds its own objects and knows how to seed/write its states; the handle only decides which
 * ids it owns (so no state is written twice) and routes user writes to the owner.
 */
export interface TransportConnection {
  /** Which transport this is. */
  readonly transport: Transport;
  /** The objects this transport's catalog builds for the device (own state ids, possibly drifting/zoned). */
  buildObjects(): readonly ObjectDef[];
  /** Seed the states this transport owns (canonical ids), skipping ids another transport owns. */
  seedOwned(ownedIds: ReadonlySet<string>): void | Promise<void>;
  /** Apply a user write to one of this transport's owned states (the handle guarantees ownership). */
  handleWrite(canonicalId: string, ack: boolean, value: unknown): void;
  /** Register a drop handler for this transport. */
  onDrop(cb: (reason?: Error) => void): void;
  /** Close this transport's connection. Synchronous — safe from onUnload. */
  close(): void;
}

/** The adapter callbacks the multi-transport handle drives. */
interface MultiTransportDeps {
  /** Create or update an object in the device tree. */
  upsertObject(id: string, def: ObjectDef): Promise<void>;
  /** Adapter log. */
  log: ControllerLog;
}

/**
 * Holds every transport that answered for one device and presents them as a single
 * {@link ConnectionHandle}. On start it unifies their catalogs into one object tree (each
 * capability owned by exactly one transport, most-modern-but-lossless — see the object-tree
 * coordinator), seeds each transport only its owned states, and routes user writes to the
 * owning transport. A drop from any transport is reported so the supervisor reconnects the set.
 */
export class MultiTransportHandle implements ConnectionHandle {
  private ownerByCanonicalId = new Map<string, Transport>();

  /**
   * @param deviceId the id-safe device id (object-tree path segment)
   * @param connections the transports that connected for this device
   * @param deps the adapter callbacks
   */
  public constructor(
    private readonly deviceId: string,
    private readonly connections: readonly TransportConnection[],
    private readonly deps: MultiTransportDeps,
  ) {}

  /** Unify the catalogs into one tree, create it, and seed each transport its owned states. */
  public async start(): Promise<void> {
    const contributions: TransportObjects[] = this.connections.map(connection => ({
      transport: connection.transport,
      objects: connection.buildObjects(),
    }));
    const { objects, ownerByCanonicalId } = coordinateObjectTree(contributions);
    this.ownerByCanonicalId = ownerByCanonicalId;
    // Parents before children is guaranteed by the coordinator, so intermediate channels exist.
    for (const object of objects) {
      await this.deps.upsertObject(`${this.deviceId}.${object.id}`, object);
    }
    for (const connection of this.connections) {
      await connection.seedOwned(this.ownedFor(connection.transport));
    }
  }

  /**
   * The canonical ids a transport owns.
   *
   * @param transport the transport to collect owned ids for
   * @returns the set of canonical ids owned by that transport
   */
  private ownedFor(transport: Transport): Set<string> {
    const owned = new Set<string>();
    for (const [id, owner] of this.ownerByCanonicalId) {
      if (owner === transport) {
        owned.add(id);
      }
    }
    return owned;
  }

  /**
   * Route a state change to the transport that owns the datapoint (a no-op for an acked echo or
   * an id no transport owns).
   *
   * @param fullStateId the full state id (device id + "." + canonical id)
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
    const canonicalId = fullStateId.slice(prefix.length);
    const owner = this.ownerByCanonicalId.get(canonicalId);
    const connection = this.connections.find(c => c.transport === owner);
    connection?.handleWrite(canonicalId, ack, value);
  }

  /**
   * Register the supervisor's drop handler. A drop from any single transport reports the whole
   * set as dropped, so the supervisor reconnects everything together (per-transport reconnect
   * is a later refinement).
   *
   * @param cb invoked once when a transport is judged gone
   */
  public onDrop(cb: (reason?: Error) => void): void {
    for (const connection of this.connections) {
      connection.onDrop(cb);
    }
  }

  /** Close every transport. Synchronous — safe from onUnload. */
  public close(): void {
    for (const connection of this.connections) {
      connection.close();
    }
  }
}
