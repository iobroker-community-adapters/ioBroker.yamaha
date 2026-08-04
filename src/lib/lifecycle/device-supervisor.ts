/** A live connection to a device, handed back by a successful attempt. */
export interface ConnectionHandle {
  /**
   * Register the callback the transport calls when this connection drops, so the
   * supervisor can reconnect.
   *
   * @param cb invoked once when the connection is lost
   */
  onDrop(cb: () => void): void;
  /**
   * Route a state change (a user write or a device echo) to the active controller.
   *
   * @param fullStateId the full state id (device id + "." + state)
   * @param ack whether the change is acked (device-originated)
   * @param value the new value
   */
  handleStateChange(fullStateId: string, ack: boolean, value: unknown): void;
  /** Close the connection synchronously — safe to call from onUnload. */
  close(): void;
}

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
    } catch {
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
      handle.onDrop(() => this.handleDrop());
    } else {
      this.deps.onConnectionChange(false);
      this.scheduleRetry();
    }
  }

  private handleDrop(): void {
    if (this.closed) {
      return;
    }
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
