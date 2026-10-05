import type { ObjectDef } from "../catalog/types";
import {
  canCarryWrite,
  coordinateObjectTree,
  keepsForm,
  type TransportObjects,
} from "../catalog/object-tree-coordinator";
import { capabilityKeyOf, pickOwner, type Transport } from "../catalog/owner-policy";
import type { ConnectionHandle, ControllerLog } from "../controller";
import { errText } from "../err-text";
import { readyLine } from "../ready-line";
import type { HandleCapture, TransportCapture } from "../diagnostics/types";
import { emptyLearnedTree, type LearnedTree } from "./learned-tree";

/**
 * What a transport made of a user write:
 * - `sent`: the device took it, or it is on its way.
 * - `refused`: the device said no.
 * - `unavailable`: the transport could not send it at all.
 * - `unclear`: nothing can be said, so nothing may be sent again.
 */
export type WriteOutcome = "sent" | "refused" | "unavailable" | "unclear";

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
  /** Apply a user write to one of this transport's states; says what became of it. */
  handleWrite(canonicalId: string, value: unknown): Promise<WriteOutcome>;
  /** Register a drop handler for this transport. */
  onDrop(cb: (reason?: Error) => void): void;
  /**
   * Register the handler the transport calls when it learned something mid-session that changes
   * the objects it would build (2.7.0). Optional: a transport that never changes shape within a
   * session simply does not offer it.
   */
  onShapeChanged?(cb: () => void): void;
  /**
   * Whether what this transport built comes from a receiver that was switched on. A receiver in standby
   * refuses many questions, so a read-in judged on such an answer would take datapoints away that the
   * receiver has. Optional: a transport whose answers do not depend on the power state leaves it out.
   */
  readComplete?(): boolean;
  /** Register the handler the transport calls once its read is complete (see {@link readComplete}). */
  onReadComplete?(cb: () => void): void;
  /** The firmware version the transport read from the device on this connection, if any. */
  firmware?(): string | undefined;
  /**
   * Ask the device once, now, and report a drop if it does not answer. Called when ANOTHER
   * transport of the same device dropped: a polled transport would otherwise keep the device
   * "connected" until its own run of missed polls (MusicCast: three five-minute polls).
   * Optional — a transport with a socket judges itself.
   */
  verifyAlive?(): Promise<void>;
  /**
   * Read the device for a diagnostics report: every question this transport can ask without changing
   * anything, answered verbatim. Optional — a transport without it is reported as live but unread.
   */
  capture?(): Promise<TransportCapture | undefined>;
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
  /**
   * Create an object or add what it learned to it. `settle` is the completion of a read-in — the one
   * moment a definition may also lose something (a list entry, a bound).
   */
  upsertObject(id: string, def: ObjectDef, settle?: boolean): Promise<void>;
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
  /**
   * The object definitions last written for this DEVICE, shared by every handle it gets. Kept per
   * handle, a device that came back as a whole (a new handle per attempt) rewrote its entire tree
   * unchanged (audit 2026-09-24, A14). The owner of the map drops it whenever it deletes objects.
   */
  writtenObjects?: Map<string, string>;
  /**
   * Transports this device has been shown to have (it answered them before) that did not answer
   * this attempt. They are reconnected like a dropped transport; a read-in does not complete without them.
   */
  missing?: readonly Transport[];
  /** The device's learned tree — read once, written back whenever something was learned. */
  tree?: { get(): LearnedTree; set(tree: LearnedTree): void };
  /** The running adapter version — a read-in completed under another version is done again. */
  adapterVersion?: string;
  /** A datapoint as it stands in the tree (canonical id), from the one start-up read — never a database read. */
  existing?(id: string): { type: string; common: Partial<ObjectDef["common"]> } | undefined;
  /** At the completion of a read-in: remove the device's objects no transport built (canonical ids). */
  settleTree?(built: ReadonlySet<string>): Promise<void>;
}

/**
 * Holds every transport that answered for one device and presents them as a single
 * {@link ConnectionHandle}, on ONE object tree.
 *
 * Who serves which datapoint is decided ONCE and kept (krobi 2026-10-02): a receiver does not change
 * what it can, and a power cut takes every transport at once. So:
 * - A transport that drops or comes back writes nothing and moves nothing.
 * - What a transport learns later (a new datapoint, a longer list, a proof) is only ever ADDED.
 * - The tree is coordinated in full, and may shrink, only when a read-in completes: after an installation,
 *   an adapter update or a firmware update, with the receiver switched on and every transport it has
 *   answering.
 *
 * A drop of a SINGLE transport does not tear the device down: the dropped transport is closed and rebuilt
 * on its own backoff loop while the others keep running. Only when the LAST live transport drops (the
 * device is really gone) is the supervisor's drop callback fired, which reconnects the whole set.
 */
export class MultiTransportHandle implements ConnectionHandle {
  private ownerByCanonicalId = new Map<string, Transport>();
  /** Object id → the definition last written, so an unchanged learn writes nothing. */
  private readonly writtenObjects: Map<string, string>;
  private readonly live: TransportConnection[];
  /**
   * The definitions each transport built in this session (canonical id → def), kept after a transport
   * dropped: a write that falls back to another transport compares the two definitions.
   */
  private readonly built = new Map<Transport, Map<string, ObjectDef>>();
  private tree: LearnedTree;
  private readonly retries = new Map<Transport, { timer: unknown; backoff: { nextDelay(): number } }>();
  /** The proven transports that have not answered yet this handle (see `MultiTransportDeps.missing`). */
  private readonly missing: Set<Transport>;
  /** A firmware update opened the read-in in this session — its completion says "ready" again. */
  private firmwareChanged = false;
  private supervisorDrop: ((reason?: Error) => void) | undefined;
  /** The learn in flight, so two signals never run one concurrently. */
  private learning: Promise<void> = Promise.resolve();
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
    this.writtenObjects = deps.writtenObjects ?? new Map<string, string>();
    this.missing = new Set(deps.missing ?? []);
    this.tree = deps.tree?.get() ?? emptyLearnedTree();
  }

  /**
   * Learn what the transports built, write it, seed the owned states, and arm the drop handlers.
   *
   * @returns the transports still live once every handler is armed — empty when all of them
   *   dropped on the way (a drop latched before start is delivered while arming)
   */
  public async start(): Promise<Transport[]> {
    for (const connection of this.live) {
      this.noteFirmware(connection);
    }
    this.learning = this.learn();
    await this.learning;
    // Over a COPY: a drop latched before start is delivered synchronously while its handler is
    // armed, and handleTransportDrop splices it out of `live` — iterating `live` itself skipped
    // the NEXT transport, which then never got a drop handler: a device without power stayed
    // connected for good (audit 2026-09-24, A1).
    for (const connection of [...this.live]) {
      if (!this.live.includes(connection)) {
        continue;
      }
      connection.onDrop(reason => this.handleTransportDrop(connection, reason));
      this.armSignals(connection);
    }
    // A transport this device has but that did not answer is brought back like a dropped one —
    // before, it stayed away for the whole session (audit 2026-09-29, D1).
    if (this.live.length > 0) {
      for (const transport of this.missing) {
        this.deps.log.debug(`${this.deviceId}/${transport}: did not answer this attempt — reconnecting it`);
        this.scheduleTransportRetry(transport);
      }
    }
    this.reportTransports();
    return this.live.map(connection => connection.transport);
  }

  /**
   * Re-learn when a transport learned something mid-session (a function a background refresh answered,
   * an XML status field delivered for the first time, a dropdown grown by an observed value, a proof) or
   * when its read became complete. Serialized behind whatever learn is in flight.
   *
   * @param connection the transport to listen to
   */
  private armSignals(connection: TransportConnection): void {
    const relearn = (): void => {
      if (this.closed || !this.live.includes(connection)) {
        return;
      }
      this.queueLearn().catch((e: unknown) => {
        this.deps.log.debug(`${this.deviceId}/${connection.transport}: learning what changed failed (${errText(e)})`);
      });
    };
    connection.onShapeChanged?.(relearn);
    connection.onReadComplete?.(relearn);
  }

  /**
   * Run a learn SERIALIZED behind whatever is already in flight. The chain itself never rejects: a
   * failure is handed back to the caller, so one failed learn cannot poison every later one.
   *
   * @returns the queued learn, rejecting with its error for the caller to handle
   */
  private queueLearn(): Promise<void> {
    let failure: unknown;
    let failed = false;
    const queued = this.learning.then(async () => {
      if (this.closed) {
        return;
      }
      try {
        await this.learn();
      } catch (e) {
        failure = e;
        failed = true;
      }
    });
    this.learning = queued;
    return queued.then(() => {
      if (failed) {
        throw failure;
      }
    });
  }

  /** Take what the live transports build now, then complete the read-in or add what is new. */
  private async learn(): Promise<void> {
    for (const connection of this.live) {
      this.built.set(connection.transport, new Map(connection.buildObjects().map(def => [def.id, def])));
    }
    if (this.readyToSettle()) {
      await this.settle();
      return;
    }
    await this.addLearned();
  }

  /**
   * Whether the read-in can complete now: it is open (installation, adapter update, firmware update), every
   * transport this device has is live, and every live transport's read comes from a switched-on receiver.
   *
   * @returns true when {@link settle} may run
   */
  private readyToSettle(): boolean {
    const version = this.deps.adapterVersion;
    if (version === undefined || this.tree.settledVersion === version || this.live.length === 0) {
      return false;
    }
    if (this.missing.size > 0) {
      return false;
    }
    const liveSet = new Set(this.live.map(connection => connection.transport));
    if (this.tree.transports.some(transport => !liveSet.has(transport))) {
      return false;
    }
    return this.live.every(connection => connection.readComplete?.() !== false);
  }

  /**
   * Complete the read-in: coordinate the live transports in full, write every definition as it is now
   * (the one moment a list or a bound may shrink), remember who serves what, and remove what no
   * transport built.
   */
  private async settle(): Promise<void> {
    const contributions = this.liveContributions();
    const { objects, ownerByCanonicalId } = coordinateObjectTree(contributions);
    for (const object of objects) {
      await this.deps.upsertObject(`${this.deviceId}.${object.id}`, object, true);
      this.writtenObjects.set(object.id, JSON.stringify(object));
    }
    this.tree = {
      shared: this.sharedOf(contributions, ownerByCanonicalId),
      transports: this.live.map(connection => connection.transport),
      settledVersion: this.deps.adapterVersion,
      firmware: { ...this.tree.firmware },
    };
    this.deps.tree?.set(this.tree);
    await this.deps.settleTree?.(new Set(objects.map(object => object.id)));
    await this.arm(ownerByCanonicalId);
    if (this.firmwareChanged) {
      this.firmwareChanged = false;
      this.deps.log.info(
        readyLine(
          this.deviceId,
          this.live.map(connection => connection.transport),
        ),
      );
    }
  }

  /**
   * Add what the transports built to the tree: a new datapoint, a longer list, a bound where there was none,
   * a transport that serves a datapoint as well. Nothing is taken away, and a learned owner stays — unless a
   * transport that proves the datapoint now ranks before it and keeps the datapoint's form (a one-way step:
   * the YNCA menu proof over the XML menus, forum 85413).
   */
  private async addLearned(): Promise<void> {
    const contributions = [...this.built].map(([transport, defs]) => ({ transport, objects: [...defs.values()] }));
    const learned = this.learnedOwners(contributions);
    const coordinated = coordinateObjectTree(contributions, learned);
    const owners = new Map(coordinated.ownerByCanonicalId);
    for (const object of coordinated.objects) {
      const keep = learned.get(object.id);
      if (keep !== undefined && owners.get(object.id) !== keep) {
        // The owner was learned but did not build the datapoint this time (it is away): the datapoint
        // stays as it is and keeps its owner.
        owners.set(object.id, keep);
        continue;
      }
      const fingerprint = JSON.stringify(object);
      if (this.writtenObjects.get(object.id) === fingerprint) {
        continue;
      }
      await this.deps.upsertObject(`${this.deviceId}.${object.id}`, object);
      this.writtenObjects.set(object.id, fingerprint);
    }
    const shared = { ...this.tree.shared, ...this.sharedOf(contributions, owners) };
    const transports = [...new Set([...this.tree.transports, ...this.live.map(connection => connection.transport)])];
    const next: LearnedTree = { ...this.tree, shared, transports };
    if (JSON.stringify(next) !== JSON.stringify(this.tree)) {
      this.tree = next;
      this.deps.tree?.set(this.tree);
    }
    await this.arm(owners);
  }

  /**
   * The owner each datapoint keeps: the learned one, or — for a datapoint no owner was learned for yet —
   * the one that keeps the form the datapoint already has in the tree.
   *
   * @param contributions what every transport built
   * @returns canonical id → the owner to keep
   */
  private learnedOwners(contributions: readonly TransportObjects[]): Map<string, Transport> {
    const builders = new Map<string, Map<Transport, ObjectDef>>();
    for (const { transport, objects } of contributions) {
      for (const def of objects) {
        let entry = builders.get(def.id);
        if (!entry) {
          entry = new Map();
          builders.set(def.id, entry);
        }
        entry.set(transport, def);
      }
    }
    const owners = new Map<string, Transport>();
    for (const [id, stored] of Object.entries(this.tree.shared)) {
      const owner = stored[0];
      if (owner !== undefined) {
        owners.set(id, owner);
      }
    }
    for (const [id, defs] of builders) {
      const key = capabilityKeyOf(defs.keys().next().value!, id);
      const unproven = new Set([...defs].filter(([, def]) => def.unproven).map(([transport]) => transport));
      const best = pickOwner(key, [...defs.keys()], unproven);
      const stored = owners.get(id);
      if (stored !== undefined) {
        // Against a learned owner only the RANK counts, never this session's proofs: the owner proved itself
        // when it was learned (a receiver in standby cannot prove its YNCA menus again, and must not hand them
        // back to XML for that — forum 85413). One way only: a transport that ranks before the learned owner,
        // serves the datapoint with a proof and keeps its form takes it over. Never back.
        const ranked = pickOwner(key, [...defs.keys()]);
        const storedDef = defs.get(stored);
        const rankedDef = defs.get(ranked);
        if (ranked !== stored && storedDef && rankedDef && !rankedDef.unproven && keepsForm(storedDef, rankedDef)) {
          owners.set(id, ranked);
        }
        continue;
      }
      const existing = this.deps.existing?.(id);
      const bestDef = defs.get(best);
      if (existing === undefined || (bestDef && keepsForm(existing, bestDef))) {
        continue;
      }
      // The datapoint stands in the tree already: the transport that keeps its form owns it.
      const keeper = rankOf(key, [...defs.keys()], unproven).find(transport =>
        keepsForm(existing, defs.get(transport)!),
      );
      if (keeper !== undefined) {
        owners.set(id, keeper);
      }
    }
    return owners;
  }

  /**
   * Who serves each datapoint more than one transport built, the owner first, then the others in the order
   * a write falls back to them.
   *
   * @param contributions what every transport built
   * @param owners the owner of each canonical id
   * @returns canonical id → the transports serving it
   */
  private sharedOf(
    contributions: readonly TransportObjects[],
    owners: ReadonlyMap<string, Transport>,
  ): Record<string, Transport[]> {
    const serving = new Map<string, Transport[]>();
    for (const { transport, objects } of contributions) {
      for (const def of objects) {
        if (def.unproven) {
          continue;
        }
        const list = serving.get(def.id) ?? [];
        list.push(transport);
        serving.set(def.id, list);
      }
    }
    const shared: Record<string, Transport[]> = {};
    for (const [id, transports] of serving) {
      const owner = owners.get(id);
      if (transports.length < 2 || owner === undefined) {
        continue;
      }
      const rest = rankOf(
        capabilityKeyOf(owner, id),
        transports.filter(transport => transport !== owner),
      );
      shared[id] = [owner, ...rest];
    }
    return shared;
  }

  /**
   * Install the owners and seed each live transport with what it owns.
   *
   * @param owners the owner of each canonical id
   */
  private async arm(owners: Map<string, Transport>): Promise<void> {
    this.ownerByCanonicalId = owners;
    for (const connection of this.live) {
      await connection.seedOwned(this.ownedFor(connection.transport));
    }
  }

  /** @returns what the live transports build, for the completion of a read-in */
  private liveContributions(): TransportObjects[] {
    return this.live.map(connection => ({
      transport: connection.transport,
      objects: [...(this.built.get(connection.transport)?.values() ?? [])],
    }));
  }

  /**
   * Note the firmware a transport read. A different one than the read-in knew is a firmware update: the
   * one moment besides an adapter update where what a receiver can may change, so the read-in opens again.
   *
   * @param connection the transport that connected
   */
  private noteFirmware(connection: TransportConnection): void {
    const firmware = connection.firmware?.();
    if (!firmware) {
      return;
    }
    const known = this.tree.firmware[connection.transport];
    if (known === firmware) {
      return;
    }
    this.tree = { ...this.tree, firmware: { ...this.tree.firmware, [connection.transport]: firmware } };
    if (known !== undefined) {
      this.deps.log.info(
        `${this.deviceId}: new firmware found (${known} → ${firmware}) — reading the receiver again, this can take a few minutes`,
      );
      this.tree = { ...this.tree, settledVersion: undefined };
      this.firmwareChanged = true;
    }
    this.deps.tree?.set(this.tree);
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
   * One transport dropped. Remove and close it; if others are still live, reconnect just this one on its
   * own backoff loop — otherwise the device is gone: report the drop to the supervisor, which reconnects
   * the whole set. Nothing is written and no datapoint changes hands: a receiver loses power as a whole.
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
        `${reason ? ` (${errText(reason)})` : ""} — other transports keep running`,
    );
    // The first drop is the question to the others: a device that lost power has every
    // transport dead, but a polled one notices only at its own cadence. Asked now, it reports
    // its drop through the same path and the device is judged gone within seconds.
    for (const other of [...this.live]) {
      other.verifyAlive?.().catch((e: unknown) => {
        this.deps.log.debug(`${this.deviceId}/${other.transport}: liveness check failed (${errText(e)})`);
      });
    }
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
   * Try to bring one dropped transport back: build a fresh connectable, connect it, and on success learn
   * what it built (only additions). A failed attempt keeps the backoff loop going.
   *
   * @param transport the transport to bring back
   */
  private async attemptTransport(transport: Transport): Promise<void> {
    if (this.closed || !this.deps.rebuild) {
      return;
    }
    let connection: ConnectableTransport;
    try {
      // Inside the guard on purpose: this is a fire-and-forget call from a timer callback, so a
      // throw out of the factory would be an unhandled rejection — and js-controller answers
      // those by stopping the instance. Everything below already sat inside a try.
      connection = this.deps.rebuild(transport);
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}/${transport}: could not rebuild the transport (${errText(e)})`);
      if (!this.closed) {
        this.scheduleTransportRetry(transport);
      }
      return;
    }
    let connected = false;
    try {
      connected = await connection.connect();
      if (connected && !this.closed) {
        this.live.push(connection);
        this.missing.delete(transport);
        this.noteFirmware(connection);
        connection.onDrop(reason => this.handleTransportDrop(connection, reason));
        this.armSignals(connection);
        await this.queueLearn();
        this.retries.delete(transport);
        this.reportTransports();
        this.deps.log.debug(`${this.deviceId}/${transport}: transport reconnected`);
        return;
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}/${transport}: reconnect attempt failed (${errText(e)})`);
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
   * Route a user write to the transport that owns the datapoint (a no-op for an acked echo or an id no
   * transport owns). When the owner is offline or the device refused the command there, the write goes to
   * the next transport that serves the datapoint and carries the value unchanged — only for a datapoint
   * that holds a value: a key press or a step sent twice would be two presses.
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
    void this.routeWrite(canonicalId, owner, value);
  }

  /**
   * Send a write through the owner, then through the next transport that can carry it.
   *
   * @param canonicalId the datapoint
   * @param owner its owner
   * @param value the value
   */
  private async routeWrite(canonicalId: string, owner: Transport, value: unknown): Promise<void> {
    try {
      const ownerDef = this.built.get(owner)?.get(canonicalId);
      // A datapoint that cannot be read is a key or a step: sent twice it would act twice.
      const repeatable = ownerDef !== undefined && ownerDef.common.read !== false;
      const others = (this.tree.shared[canonicalId] ?? []).filter(transport => transport !== owner);
      let reason = "offline";
      for (const transport of [owner, ...others]) {
        const connection = this.live.find(c => c.transport === transport);
        if (transport !== owner) {
          const def = this.built.get(transport)?.get(canonicalId);
          if (
            !repeatable ||
            !ownerDef ||
            !def ||
            !canCarryWrite({ transport: owner, def: ownerDef }, { transport, def })
          ) {
            continue;
          }
          if (!connection) {
            continue;
          }
          this.deps.log.debug(`${this.deviceId}: ${canonicalId} — ${owner} ${reason}, sent through ${transport}`);
        } else if (!connection) {
          this.deps.log.debug(`${this.deviceId}: write to ${canonicalId} — its transport (${owner}) is offline`);
          continue;
        }
        const outcome = await connection.handleWrite(canonicalId, value);
        if (outcome !== "refused" && outcome !== "unavailable") {
          return;
        }
        reason = outcome === "refused" ? "refused it" : "could not send it";
      }
    } catch (e) {
      this.deps.log.debug(`${this.deviceId}: write to ${canonicalId} failed (${errText(e)})`);
    }
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

  /**
   * Read the device for a diagnostics report: each live transport asks what it can without changing
   * anything — in parallel, every transport through its own command gate — and the report learns who
   * serves which datapoint. Nothing is learned, owned or written differently because of it.
   *
   * @returns the live set, the owners and the raw captures
   */
  public async capture(): Promise<HandleCapture> {
    const live = [...this.live];
    const captures = await Promise.all(live.map(connection => connection.capture?.() ?? Promise.resolve(undefined)));
    return {
      live: live.map(connection => connection.transport),
      missing: [...this.missing],
      owners: Object.fromEntries([...this.ownerByCanonicalId].sort(([a], [b]) => a.localeCompare(b))),
      tree: this.tree,
      captures: captures.filter((capture): capture is TransportCapture => capture !== undefined),
    };
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

/**
 * Transports in the order the owner policy prefers them for a capability.
 *
 * @param key the capability key
 * @param candidates the transports to order
 * @param unproven the candidates that claim without a proof
 * @returns the candidates, most preferred first
 */
function rankOf(key: string, candidates: readonly Transport[], unproven?: ReadonlySet<Transport>): Transport[] {
  const rest = [...candidates];
  const ranked: Transport[] = [];
  while (rest.length > 0) {
    const next = pickOwner(key, rest, unproven);
    ranked.push(next);
    rest.splice(rest.indexOf(next), 1);
  }
  return ranked;
}
