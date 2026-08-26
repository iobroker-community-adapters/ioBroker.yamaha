/**
 * What a device told us about ITSELF and will keep telling us: which of its sources can be
 * browsed, which capabilities it reports, what it is called. These answers are constant for
 * as long as the device runs, but every reconnect used to ask again — and a reconnect is
 * not rare (a receiver briefly off the network, a single transport dropping).
 *
 * The memory lives with the CALLER (one per device, held across reconnect attempts) exactly
 * like the YNCA subunit cache and the reachability dedup, because the controllers
 * themselves are rebuilt on every attempt. It deliberately does NOT persist: an adapter
 * restart re-asks, so a device that gained a source after a firmware update is picked up
 * without anyone having to invalidate anything.
 */
export class ProbeMemory {
  private readonly values = new Map<string, unknown>();

  /**
   * Return the remembered answer, or run the probe once and remember it.
   *
   * @param key what is being remembered (e.g. "xmlBrowseSources")
   * @param probe the probe to run when nothing is remembered yet
   * @returns the remembered or freshly probed value
   */
  public async once<T>(key: string, probe: () => Promise<T>): Promise<T> {
    if (this.values.has(key)) {
      return this.values.get(key) as T;
    }
    const value = await probe();
    this.values.set(key, value);
    return value;
  }

  /**
   * The remembered value, or undefined when nothing was stored under that key yet.
   *
   * @param key what was remembered
   * @returns the value, or undefined
   */
  public remembered<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  /**
   * Store a value directly — for answers that fall out of a bigger request rather than
   * being fetched on their own.
   *
   * @param key what is being remembered
   * @param value the value to keep
   */
  public set<T>(key: string, value: T): void {
    this.values.set(key, value);
  }

  /** Forget everything — used when a device turns out to be a different one. */
  public clear(): void {
    this.values.clear();
  }
}
