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
  /** A drop that fired before onDrop was registered — delivered once it is. */
  private pending: Error | undefined;

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
    if (this.pending) {
      const reason = this.pending;
      this.pending = undefined;
      cb(reason);
    }
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
    const reason = new Error(`${this.maxFailures} polls failed`);
    if (this.handler) {
      this.handler(reason);
      return;
    }
    // Latched, not lost: the handler is registered by the multi-transport handle only after
    // every transport connected, so a drop judged before that would have vanished — and
    // because `dropped` is set, it would never be reported again either. The YNCA client and
    // the handle both latch for exactly this; the polled transports were the odd ones out.
    this.pending = reason;
  }
}
