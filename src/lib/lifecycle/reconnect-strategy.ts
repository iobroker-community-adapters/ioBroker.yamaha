/**
 * The reconnect backoff of a device (the supervisor) and of each of its transports (the handle): from one second
 * up to a minute. Stood twice, as `RECONNECT_*` in main.ts and `TRANSPORT_RECONNECT_*` in attempt-device.ts
 * (review 2026-10-05, E).
 */
export const RECONNECT_BASE_MS = 1000;
/** The longest wait between two reconnect attempts — see {@link RECONNECT_BASE_MS}. */
export const RECONNECT_MAX_MS = 60_000;

/** A backoff as a {@link RetryLoop} uses it. */
export interface Backoff {
  /** The delay before the next attempt — every call one step further. */
  nextDelay(): number;
  /** Start again at the first delay. */
  reset(): void;
}

/** The timers a {@link RetryLoop} schedules on — the adapter's, so nothing outlives onUnload. */
export interface RetryTimers {
  /** Schedule a one-shot timer. */
  schedule(cb: () => void, ms: number): unknown;
  /** Cancel a timer {@link schedule} returned. */
  cancel(handle: unknown): void;
}

/**
 * Exponential backoff for reconnect attempts, capped at a maximum delay and spread by a
 * small random offset BELOW it.
 *
 * The offset matters once more than one device is configured: a router reboot or a switch
 * losing power takes every receiver — and every one of their transports — down at the same
 * moment, so without it they all retry in lockstep for as long as the outage lasts, each
 * wave hitting the network together. Up to 20 % jitter breaks the convoy apart while
 * keeping the backoff's shape. It spreads downward so the cap stays a cap (an upward
 * spread let the "60 s ceiling" reach 72 s) — and so the spread still works AT the
 * ceiling, where every device of a long outage ends up.
 */
export class ReconnectStrategy implements Backoff {
  private attempt = 0;

  /**
   * @param baseMs the first delay in milliseconds
   * @param maxMs the maximum delay in milliseconds
   * @param jitter fraction of the delay to spread randomly (0 disables it — used by tests
   *   that assert exact delays)
   */
  public constructor(
    private readonly baseMs: number,
    private readonly maxMs: number,
    private readonly jitter = 0.2,
  ) {}

  /**
   * Get the next backoff delay and advance the attempt counter.
   *
   * @returns the delay in milliseconds for the next reconnect attempt
   */
  public nextDelay(): number {
    const delay = Math.min(this.baseMs * 2 ** this.attempt, this.maxMs);
    this.attempt++;
    return Math.round(delay * (1 - this.jitter * Math.random()));
  }

  /** Reset the backoff to the base delay after a successful connection. */
  public reset(): void {
    this.attempt = 0;
  }
}

/**
 * One reconnect loop: the next attempt after the backoff's next delay, at most one of them pending, cancelled on
 * close, and the backoff reset once an attempt held. The device supervisor and the handle's per-transport
 * reconnect each ran a copy of this (review 2026-10-05, E); the copy in the handle forgot a pending timer and
 * reset the backoff of a transport that dropped again at once (A52).
 */
export class RetryLoop {
  private timer: unknown;
  private pending = false;

  /**
   * @param timers the adapter's timers
   * @param backoff the backoff this loop steps through — kept across its attempts
   */
  public constructor(
    private readonly timers: RetryTimers,
    private readonly backoff: Backoff,
  ) {}

  /**
   * Schedule the next attempt after the backoff's next delay. One still pending is replaced, never doubled.
   *
   * @param attempt the attempt to run
   */
  public schedule(attempt: () => void): void {
    this.cancel();
    this.pending = true;
    this.timer = this.timers.schedule(() => {
      this.pending = false;
      this.timer = undefined;
      attempt();
    }, this.backoff.nextDelay());
  }

  /** An attempt held: the next outage starts again at the first delay. */
  public succeeded(): void {
    this.backoff.reset();
  }

  /** Cancel the pending attempt, if one is. */
  public cancel(): void {
    if (!this.pending) {
      return;
    }
    this.timers.cancel(this.timer);
    this.pending = false;
    this.timer = undefined;
  }
}
