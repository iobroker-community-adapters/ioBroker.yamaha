/**
 * What a device told us about ITSELF and will keep telling us: which of its sources can be
 * browsed, which capabilities it reports, what it is called. These answers are constant for
 * as long as the device runs, but every reconnect used to ask again — and a reconnect is
 * not rare (a receiver briefly off the network, a single transport dropping).
 *
 * The memory lives with the CALLER (one per device, held across reconnect attempts) exactly
 * like the YNCA subunit cache and the reachability dedup, because the controllers
 * themselves are rebuilt on every attempt. Since the fast-restart rework it also PERSISTS
 * (at the device object, like the subunit cache): an adapter restart starts from the
 * remembered answers instead of re-asking everything — that was the restart's 15–20 s.
 * Freshness is guarded per transport: each controller validates its portion against a LIVE
 * identity read (YNCA model+firmware, YXC model+version, XML model) and drops its keys on a
 * mismatch, so a swapped or updated device is re-probed, never served from a stale memory.
 */
export class ProbeMemory {
  private readonly values = new Map<string, unknown>();

  /**
   * @param initial the persisted entries to start from (an adapter restart), if any
   * @param persist called with a plain-object snapshot after every change, if persistence is wired
   */
  public constructor(
    initial?: Record<string, unknown>,
    private readonly persist?: (entries: Record<string, unknown>) => void,
  ) {
    for (const [key, value] of Object.entries(initial ?? {})) {
      this.values.set(key, value);
    }
  }

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
    this.persistNow();
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
    this.persistNow();
  }

  /**
   * Forget the keys a predicate marks — a transport's freshness guard drops ITS portion
   * when the device behind the address turns out to be a different (or updated) one,
   * without touching what the other transports validated.
   *
   * @param match marks the keys to drop
   */
  public drop(match: (key: string) => boolean): void {
    let dropped = false;
    for (const key of [...this.values.keys()]) {
      if (match(key)) {
        this.values.delete(key);
        dropped = true;
      }
    }
    if (dropped) {
      this.persistNow();
    }
  }

  /** Forget everything — used when a device turns out to be a different one. */
  public clear(): void {
    this.values.clear();
    this.persistNow();
  }

  private persistNow(): void {
    if (!this.persist) {
      return;
    }
    this.persist(Object.fromEntries(this.values));
  }
}
