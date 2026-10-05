/**
 * A drop that is reported once and delivered once a handler is registered — whichever of the two comes first.
 *
 * A connection is often judged gone before anyone listens: the multi-transport handle arms its transports' drop
 * handlers only after the first learn, and the supervisor registers on the handle only after `start()`. A drop in
 * that window must be kept, not lost (a device without power stayed "connected" for good, audit 2026-09-24, A1),
 * and a drop reported twice must not reconnect twice. The handle, the polled transports' drop detector and the
 * YNCA client each carried a hand-made copy of this latch (review 2026-10-05, E).
 */
export class DropLatch {
  private handler: ((reason?: Error) => void) | undefined;
  private reported = false;
  /** A drop reported while no handler was registered — delivered on registration. */
  private pending: { reason?: Error } | undefined;

  /** Whether the drop was reported. */
  public get dropped(): boolean {
    return this.reported;
  }

  /**
   * Register the handler. A drop reported before is delivered to it now.
   *
   * @param cb called once with the drop's reason
   */
  public onDrop(cb: (reason?: Error) => void): void {
    this.handler = cb;
    const pending = this.pending;
    if (pending) {
      this.pending = undefined;
      cb(pending.reason);
    }
  }

  /**
   * Report the drop. Only the first report counts; it is delivered at once, or on registration.
   *
   * @param reason why the connection counts as gone
   * @returns whether this report was the first
   */
  public report(reason?: Error): boolean {
    if (this.reported) {
      return false;
    }
    this.reported = true;
    if (this.handler) {
      this.handler(reason);
    } else {
      this.pending = { reason };
    }
    return true;
  }
}
