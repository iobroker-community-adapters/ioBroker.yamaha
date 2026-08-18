import type { ConnectionHandle } from "../controller";

// Re-exported so existing importers (main.ts) keep resolving it from here.
export type { ConnectionHandle };

/** The dependencies the supervisor drives — injectable so tests need no real device. */
export interface SupervisorDeps {
  /**
   * Try to bring the device online across its transports. Resolves to a live
   * connection handle, or null when no transport is reachable this attempt.
   */
  attempt: () => Promise<ConnectionHandle | null>;
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
  backoff: { nextDelay(): number; reset(): void };
  /** Adapter log. */
  log: { debug(message: string): void; info(message: string): void; warn(message: string): void };
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
  private timer: unknown;
  private closed = false;

  /**
   * @param deps the injected attempt/timer/report callbacks
   */
  public constructor(private readonly deps: SupervisorDeps) {}

  /** Begin supervising: attempt now, then retry/reconnect as needed. */
  public start(): void {
    void this.attemptOnce();
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
    this.handle?.handleStateChange(fullStateId, ack, value);
  }

  private async attemptOnce(): Promise<void> {
    if (this.closed) {
      return;
    }
    let handle: ConnectionHandle | null = null;
    try {
      handle = await this.deps.attempt();
    } catch (e) {
      // Never let an attempt failure vanish silently — without this line a repeatable
      // error (e.g. object creation failing) becomes an invisible endless retry loop.
      this.deps.log.debug(`connection attempt failed, retrying: ${e instanceof Error ? e.message : String(e)}`);
      handle = null;
    }
    if (this.closed) {
      handle?.close();
      return;
    }
    if (handle) {
      this.handle = handle;
      this.deps.backoff.reset();
      this.deps.onConnectionChange(true);
      // Bind the drop to THIS handle: a second drop, or a drop from a handle a
      // reconnect has already superseded, must not schedule another retry.
      handle.onDrop(reason => this.handleDrop(handle, reason));
    } else {
      this.deps.onConnectionChange(false);
      this.scheduleRetry();
    }
  }

  private handleDrop(handle: ConnectionHandle, reason?: Error): void {
    if (this.closed || this.handle !== handle) {
      return;
    }
    if (reason) {
      this.deps.log.debug(`connection dropped, reconnecting: ${reason.message}`);
    }
    // Release the dropped connection's resources (keepalive timer, push registration,
    // socket) before reconnecting — not every transport self-cleans on drop.
    handle.close();
    this.handle = undefined;
    this.deps.onConnectionChange(false);
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    this.timer = this.deps.schedule(() => void this.attemptOnce(), this.deps.backoff.nextDelay());
  }

  /** Stop supervising and close the connection. Synchronous — safe from onUnload. */
  public close(): void {
    this.closed = true;
    this.deps.cancel(this.timer);
    this.handle?.close();
    this.handle = undefined;
  }
}
