/**
 * Tracks whether a device's "unreachable" state has already been reported, so a
 * retry loop's repeat failures log at debug instead of re-warning on every attempt
 * (nut2 `failedUps` pattern: first failure in a row warns, repeats stay quiet until
 * the device is reachable again).
 */
export class ReachabilityDedup {
  private unreachable = false;

  /**
   * Report a failed connect attempt.
   *
   * @returns "warn" the first time in a row, "debug" for a repeat while still unreachable
   */
  public reportUnreachable(): "warn" | "debug" {
    if (this.unreachable) {
      return "debug";
    }
    this.unreachable = true;
    return "warn";
  }

  /** Report a successful connect — clears the dedup so the next failure warns again. */
  public reportReachable(): void {
    this.unreachable = false;
  }
}
