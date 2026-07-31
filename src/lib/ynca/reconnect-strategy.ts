/** Exponential backoff for reconnect attempts, capped at a maximum delay. */
export class ReconnectStrategy {
  private attempt = 0;

  /**
   * @param baseMs the first delay in milliseconds
   * @param maxMs the maximum delay in milliseconds
   */
  public constructor(
    private readonly baseMs: number,
    private readonly maxMs: number,
  ) {}

  /**
   * Get the next backoff delay and advance the attempt counter.
   *
   * @returns the delay in milliseconds for the next reconnect attempt
   */
  public nextDelay(): number {
    const delay = Math.min(this.baseMs * 2 ** this.attempt, this.maxMs);
    this.attempt++;
    return delay;
  }

  /** Reset the backoff to the base delay after a successful connection. */
  public reset(): void {
    this.attempt = 0;
  }
}
