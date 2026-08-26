/**
 * Drop detection for the polled transports.
 *
 * MusicCast and XML have no socket to lose: neither protocol signals "the device is gone",
 * so a run of failed polls IS the signal. Both controllers carried an identical copy of
 * this counter, its threshold and the once-only reporting — which is exactly the kind of
 * duplication that drifts apart the moment one of them is touched.
 */

/** Report a drop after this many consecutive polls in which every zone failed. */
export const MAX_POLL_FAILURES = 3;

/**
 * Counts consecutive failed polls and reports the drop exactly once.
 */
export class PollDropDetector {
  private failures = 0;
  private dropped = false;
  private handler: ((reason?: Error) => void) | undefined;

  /**
   * @param maxFailures consecutive failed polls before the device counts as gone
   */
  public constructor(private readonly maxFailures: number = MAX_POLL_FAILURES) {}

  /**
   * Register the supervisor's drop handler.
   *
   * @param cb invoked once when the device is judged gone
   */
  public onDrop(cb: (reason?: Error) => void): void {
    this.handler = cb;
  }

  /**
   * Record a poll's outcome.
   *
   * @param anySucceeded whether at least one request of this poll came back
   */
  public record(anySucceeded: boolean): void {
    if (anySucceeded) {
      this.failures = 0;
      return;
    }
    if (++this.failures >= this.maxFailures) {
      this.report();
    }
  }

  /** Report the drop once — repeat calls are ignored, as is a report after close. */
  public report(): void {
    if (this.dropped) {
      return;
    }
    this.dropped = true;
    this.handler?.(new Error(`${this.maxFailures} polls failed`));
  }
}
