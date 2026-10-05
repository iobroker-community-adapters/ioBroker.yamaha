import type { ConnectionHandle } from "../controller";
import type { HandleCapture } from "../diagnostics/types";
import { errText } from "../err-text";
import { RetryLoop, type Backoff } from "./reconnect-strategy";

// Re-exported so existing importers (main.ts) keep resolving it from here.
export type { ConnectionHandle };

/** The dependencies the supervisor drives — injectable so tests need no real device. */
export interface SupervisorDeps {
  /**
   * Try to bring the device online across its transports. Resolves to a live
   * connection handle, or null when no transport is reachable this attempt.
   *
   * @param signal the attempt's lifetime: aborted when the supervisor is closed while the attempt still runs —
   *   the attempt closes what it built and writes nothing more (a delete or a move during a slow first sweep
   *   left an orphan tree and, in compact mode, a zombie YNCA socket; audit 2026-09-24, A3) — and, once the
   *   attempt produced a handle, when that handle is closed (a drop, a delete, a move): everything the handle
   *   writes checks it (review 2026-10-05, A6). An attempt that produced nothing ends with it aborted.
   */
  attempt: (signal: AbortSignal) => Promise<ConnectionHandle | null>;
  /**
   * Schedule the next attempt.
   *
   * @param cb the retry callback
   * @param ms delay in milliseconds
   * @returns a handle the supervisor can cancel
   */
  schedule: (cb: () => void, ms: number) => unknown;
  /**
   * Cancel a scheduled attempt.
   *
   * @param handle the handle returned by schedule
   */
  cancel: (handle: unknown) => void;
  /**
   * Report the device's connection state (drives its `info.connection`).
   *
   * @param connected whether a transport is currently connected
   */
  onConnectionChange: (connected: boolean) => void;
  /** Exponential backoff for the retry cadence. */
  backoff: Backoff;
  /** Adapter log. */
  log: { debug(message: string): void; info(message: string): void; warn(message: string): void };
  /** The device the supervisor keeps, so its log lines say which one (audit 2026-09-24, A16). */
  deviceId?: string;
}

/**
 * Keeps one device online. A single loop covers all three cases: a device that
 * is offline at start is retried (with backoff) until a transport connects; a
 * later drop reconnects; a device that never answers keeps retrying at the
 * backoff ceiling without hammering. The `attempt` callback owns building the
 * object tree and seeding state, so a reconnect re-seeds by re-attempting — one
 * place is responsible, never two.
 */
export class DeviceSupervisor {
  private handle: ConnectionHandle | undefined;
  /** The next attempt after a failed one or a drop, on the backoff. */
  private readonly retry: RetryLoop;
  private closed = false;
  /** The attempt currently running, so a caller can wait for it before tearing the device down. */
  private inFlight: Promise<void> | undefined;
  /**
   * The lifetime of the attempt in flight or of the handle it produced (see `SupervisorDeps.attempt`). It was
   * dropped as soon as the attempt returned, so closing the supervisor never reached the running handle's
   * writes: a learn in flight kept writing into a deleted device (review 2026-10-05, A6).
   */
  private lifetime: AbortController | undefined;
  /** The writes the handle closed last still has on their way — {@link settled} waits for them. */
  private draining: Promise<void> | undefined;

  /**
   * @param deps the injected attempt/timer/report callbacks
   */
  public constructor(private readonly deps: SupervisorDeps) {
    this.retry = new RetryLoop(
      { schedule: (cb, ms) => deps.schedule(cb, ms), cancel: handle => deps.cancel(handle) },
      deps.backoff,
    );
  }

  /** Begin supervising: attempt now, then retry/reconnect as needed. */
  public start(): void {
    this.runAttempt();
  }

  /**
   * Resolves once the attempt in flight (if any) has finished — connected, failed or closed — and the handle
   * {@link close} closed has no write left on its way. `close()` aborts the lifetime signal, but a tree write
   * already in flight (`handle.start()`, a learn) still runs to the end. Deleting that tree while it is being
   * built leaves orphans behind, so `removeDevice` waits here first.
   *
   * @returns a promise that settles with the running attempt and the closed handle's last write, or at once
   *   when neither runs
   */
  public settled(): Promise<void> {
    return Promise.all([this.inFlight, this.draining]).then(() => undefined);
  }

  private runAttempt(): void {
    const attempt = this.attemptOnce();
    this.inFlight = attempt;
    void attempt.finally(() => {
      if (this.inFlight === attempt) {
        this.inFlight = undefined;
      }
    });
  }

  /**
   * Route a state change to the currently connected controller (a no-op while the
   * device is offline, so a user write during a reconnect is simply dropped).
   *
   * @param fullStateId the full state id (device id + "." + state)
   * @param ack whether the change is acked (device-originated)
   * @param value the new value
   */
  public handleStateChange(fullStateId: string, ack: boolean, value: unknown): void {
    if (!this.handle) {
      // Offline: the write reaches no transport. Saying so beats the silence a button press
      // used to get here — the handle logs the same way when only ITS transport is down.
      if (!ack) {
        this.deps.log.debug(`${fullStateId}: write dropped — the device is offline`);
      }
      return;
    }
    this.handle.handleStateChange(fullStateId, ack, value);
  }

  private async attemptOnce(): Promise<void> {
    if (this.closed) {
      return;
    }
    let handle: ConnectionHandle | null = null;
    const lifetime = new AbortController();
    this.lifetime = lifetime;
    try {
      handle = await this.deps.attempt(lifetime.signal);
    } catch (e) {
      // Never let an attempt failure vanish silently — without this line a repeatable
      // error (e.g. object creation failing) becomes an invisible endless retry loop.
      this.deps.log.debug(`${this.prefix}connection attempt failed, retrying: ${errText(e)}`);
      handle = null;
    }
    if (this.closed) {
      handle?.close();
      return;
    }
    if (handle) {
      // The lifetime stays with the handle: aborted when it drops or the supervisor closes.
      this.handle = handle;
      this.retry.succeeded();
      this.deps.onConnectionChange(true);
      // Bind the drop to THIS handle: a second drop, or a drop from a handle a
      // reconnect has already superseded, must not schedule another retry.
      handle.onDrop(reason => this.handleDrop(handle, reason));
    } else {
      this.endLifetime(lifetime);
      this.deps.onConnectionChange(false);
      this.scheduleRetry();
    }
  }

  /**
   * End an attempt's lifetime: whatever it built writes nothing more.
   *
   * @param lifetime the lifetime to end (the current one when omitted)
   */
  private endLifetime(lifetime = this.lifetime): void {
    lifetime?.abort();
    if (this.lifetime === lifetime) {
      this.lifetime = undefined;
    }
  }

  private handleDrop(handle: ConnectionHandle, reason?: Error): void {
    if (this.closed || this.handle !== handle) {
      return;
    }
    if (reason) {
      this.deps.log.debug(`${this.prefix}connection dropped, reconnecting: ${errText(reason)}`);
    }
    // The dropped handle writes nothing more — its lifetime ends before it is closed.
    this.endLifetime();
    // Release the dropped connection's resources (keepalive timer, push registration,
    // socket) before reconnecting — not every transport self-cleans on drop.
    handle.close();
    this.handle = undefined;
    this.deps.onConnectionChange(false);
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    this.retry.schedule(() => this.runAttempt());
  }

  /** The log prefix naming the device (empty when the caller gave no id). */
  private get prefix(): string {
    return this.deps.deviceId ? `${this.deps.deviceId}: ` : "";
  }

  /**
   * Read the device for a diagnostics report through its running connection.
   *
   * @returns the read, or undefined when the device is not connected
   */
  public capture(): Promise<HandleCapture | undefined> {
    return this.handle?.capture?.() ?? Promise.resolve(undefined);
  }

  /** Stop supervising and close the connection. Synchronous — safe from onUnload. */
  public close(): void {
    this.closed = true;
    this.endLifetime();
    this.retry.cancel();
    this.handle?.close();
    this.draining = this.handle?.settled?.();
    this.handle = undefined;
  }
}
