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

/** A transport connection that can be brought online — a {@link TransportConnection} plus connect(). */
export interface ConnectableTransport extends TransportConnection {
  /** Connect, probe, and build the object tree. Resolves true if the transport answered. */
  connect(): Promise<boolean>;
}

/** The adapter callbacks the multi-transport handle drives. */
export interface MultiTransportDeps {
  /** Create or update an object in the device tree. */
  upsertObject(id: string, def: ObjectDef): Promise<void>;
  /** Adapter log. */
  log: ControllerLog;
  /** Report the currently live transports (their id-safe names) after every change. */
  onTransports?(names: string[]): void;
  /** Build a FRESH connectable for a transport — used to reconnect a single dropped transport. */
  rebuild?(transport: Transport): ConnectableTransport;
  /** Schedule a per-transport reconnect attempt. */
  schedule?(cb: () => void, ms: number): unknown;
  /** Cancel a scheduled reconnect attempt. */
  cancel?(handle: unknown): void;
  /** A fresh exponential backoff for one transport's reconnect loop. */
  backoffFactory?(): { nextDelay(): number; reset(): void };
}

/**
 * Holds every transport that answered for one device and presents them as a single
 * {@link ConnectionHandle}. On start it unifies their catalogs into one object tree (each
 * capability owned by exactly one transport, most-modern-but-lossless — see the object-tree
 * coordinator), seeds each transport only its owned states, and routes user writes to the
 * owning transport.
 *
 * A drop of a SINGLE transport no longer tears the device down: the dropped transport is
 * closed and rebuilt on its own backoff loop while the others keep running — a YNCA socket
 * hiccup no longer costs the YXC push registration and a full re-sweep. Only when the LAST
 * live transport drops (the device is really gone) is the supervisor's drop callback fired,
 * which reconnects the whole set as before. When a transport comes back, the object tree is
 * re-coordinated over the now-live set (idempotent upserts), so ownership and seeds are
 * correct again.
 */
export class MultiTransportHandle implements ConnectionHandle {
  private ownerByCanonicalId = new Map<string, Transport>();
  private readonly live: TransportConnection[];
  private readonly retries = new Map<Transport, { timer: unknown; backoff: { nextDelay(): number } }>();
  private supervisorDrop: ((reason?: Error) => void) | undefined;
  /** All transports went down before the supervisor registered onDrop — delivered on registration. */
  private pendingDrop: Error | undefined | false = false;
  private droppedAll = false;
  private closed = false;

  /**
   * @param deviceId the id-safe device id (object-tree path segment)
   * @param connections the transports that connected for this device
   * @param deps the adapter callbacks
   */
  public constructor(
    private readonly deviceId: string,
    connections: readonly TransportConnection[],
    private readonly deps: MultiTransportDeps,
  ) {
    this.live = [...connections];
  }

  /** Unify the catalogs into one tree, create it, seed owned states, and arm the drop handlers. */
  public async start(): Promise<void> {
    await this.coordinate();
    for (const connection of this.live) {
      connection.onDrop(reason => this.handleTransportDrop(connection, reason));
    }
    this.reportTransports();
  }

  /**
   * (Re-)coordinate the unified tree over the currently live transports: recompute
   * ownership, upsert the objects (idempotent), and re-arm every transport's owned set.
   */
  private async coordinate(): Promise<void> {
    const contributions: TransportObjects[] = this.live.map(connection => ({
      transport: connection.transport,
      objects: connection.buildObjects(),
    }));
    const { objects, ownerByCanonicalId } = coordinateObjectTree(contributions);
    this.ownerByCanonicalId = ownerByCanonicalId;
    // Parents before children is guaranteed by the coordinator, so intermediate channels exist.
    for (const object of objects) {
      await this.deps.upsertObject(`${this.deviceId}.${object.id}`, object);
    }
    for (const connection of this.live) {
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

  /** Report the live transport set (device-manager card indicators / info.transports.*). */
  private reportTransports(): void {
    this.deps.onTransports?.(this.live.map(connection => connection.transport));
  }

  /**
   * One transport dropped. Remove and close it; if others are still live, reconnect just
   * this one on its own backoff loop — otherwise the device is gone: report the drop to
   * the supervisor, which reconnects the whole set.
   *
   * @param connection the dropped connection
   * @param reason the drop reason, if known
   */
  private handleTransportDrop(connection: TransportConnection, reason?: Error): void {
    const index = this.live.indexOf(connection);
    if (this.closed || index < 0) {
      return;
    }
    this.live.splice(index, 1);
    connection.close();
    if (this.live.length === 0) {
      this.cancelRetries();
      this.reportDeviceGone(reason);
      return;
    }
    this.reportTransports();
    this.deps.log.debug(
      `${this.deviceId}/${connection.transport}: transport dropped, reconnecting it` +
        `${reason ? ` (${reason.message})` : ""} — other transports keep running`,
    );
    this.scheduleTransportRetry(connection.transport);
  }

  /**
   * Schedule the next reconnect attempt for one dropped transport, keeping its backoff
   * across attempts. Without rebuild/schedule deps (tests, or a caller that opts out)
   * the device-gone path above is the only recovery — matching the old full-reconnect.
   *
   * @param transport the transport to bring back
   */
  private scheduleTransportRetry(transport: Transport): void {
    if (!this.deps.rebuild || !this.deps.schedule || !this.deps.backoffFactory) {
      return;
    }
    const existing = this.retries.get(transport);
    const backoff = existing?.backoff ?? this.deps.backoffFactory();
    const timer = this.deps.schedule(() => void this.attemptTransport(transport), backoff.nextDelay());
    this.retries.set(transport, { timer, backoff });
  }

  /**
   * Try to bring one dropped transport back: build a fresh connectable, connect it, and
   * on success re-coordinate the tree over the extended live set. A failed attempt keeps
   * the backoff loop going.
   *
   * @param transport the transport to bring back
   */
  private async attemptTransport(transport: Transport): Promise<void> {
    if (this.closed || !this.deps.rebuild) {
      return;
    }
    const connection = this.deps.rebuild(transport);
    let connected = false;
    try {
      connected = await connection.connect();
      if (connected && !this.closed) {
        this.live.push(connection);
        connection.onDrop(reason => this.handleTransportDrop(connection, reason));
        await this.coordinate();
        this.retries.delete(transport);
        this.reportTransports();
        this.deps.log.debug(`${this.deviceId}/${transport}: transport reconnected`);
        return;
      }
    } catch (e) {
      this.deps.log.debug(
        `${this.deviceId}/${transport}: reconnect attempt failed (${e instanceof Error ? e.message : String(e)})`,
      );
      const index = this.live.indexOf(connection);
      if (index >= 0) {
        this.live.splice(index, 1);
      }
    }
    connection.close();
    if (this.closed) {
      return;
    }
    this.scheduleTransportRetry(transport);
  }

  /** Cancel every per-transport reconnect loop. */
  private cancelRetries(): void {
    for (const { timer } of this.retries.values()) {
      this.deps.cancel?.(timer);
    }
    this.retries.clear();
  }

  /**
   * The last live transport is gone — the device itself is unreachable. Report once to
   * the supervisor (latched if it has not registered yet), which closes this handle and
   * reconnects the whole set.
   *
   * @param reason the final drop's reason, if known
   */
  private reportDeviceGone(reason?: Error): void {
    if (this.droppedAll) {
      return;
    }
    this.droppedAll = true;
    if (this.supervisorDrop) {
      this.supervisorDrop(reason);
    } else {
      this.pendingDrop = reason ?? undefined;
    }
  }

  /**
   * Route a state change to the transport that owns the datapoint (a no-op for an acked echo or
   * an id no transport owns). While the owning transport is offline (being reconnected), the
   * write is dropped with a debug line instead of vanishing silently.
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
    if (owner === undefined) {
      return;
    }
    const connection = this.live.find(c => c.transport === owner);
    if (!connection) {
      this.deps.log.debug(`${this.deviceId}: write to ${canonicalId} dropped — its transport (${owner}) is offline`);
      return;
    }
    connection.handleWrite(canonicalId, ack, value);
  }

  /**
   * Register the supervisor's drop handler. It fires only when the LAST live transport is
   * gone (the device is unreachable) — a single transport's drop is handled internally.
   *
   * @param cb invoked once when the device is judged gone
   */
  public onDrop(cb: (reason?: Error) => void): void {
    this.supervisorDrop = cb;
    if (this.pendingDrop !== false) {
      const reason = this.pendingDrop;
      this.pendingDrop = false;
      cb(reason);
    }
  }

  /** Close every transport and stop every reconnect loop. Synchronous — safe from onUnload. */
  public close(): void {
    this.closed = true;
    this.cancelRetries();
    for (const connection of this.live) {
      connection.close();
    }
    this.live.length = 0;
  }
}
