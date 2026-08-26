/**
 * Exponential backoff for reconnect attempts, capped at a maximum delay and spread by a
 * small random offset.
 *
 * The offset matters once more than one device is configured: a router reboot or a switch
 * losing power takes every receiver — and every one of their transports — down at the same
 * moment, so without it they all retry in lockstep for as long as the outage lasts, each
 * wave hitting the network together. Up to 20 % jitter breaks the convoy apart while
 * keeping the backoff's shape.
 */
export class ReconnectStrategy {
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
    return Math.round(delay * (1 + this.jitter * Math.random()));
  }

  /** Reset the backoff to the base delay after a successful connection. */
  public reset(): void {
    this.attempt = 0;
  }
}
