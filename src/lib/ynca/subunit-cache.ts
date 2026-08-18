/**
 * What the two-pass YNCA init sweep learned about a device: the subunits that
 * answered the AVAIL probe, keyed by the device identity (model + firmware) so a
 * swapped or updated receiver invalidates the cache.
 */
export interface YncaAvailSnapshot {
  /** The subunits that answered `AVAIL=?` (SYS excluded — it is always swept). */
  subunits: string[];
  /** SYS MODELNAME at the time of the probe — cache key half 1. */
  model: string;
  /** SYS VERSION at the time of the probe — cache key half 2. */
  firmware: string;
}

/**
 * Per-device cache of the AVAIL probe result, held ACROSS reconnect attempts (the
 * controller is rebuilt per attempt, so the cache lives with the caller — the
 * ReachabilityDedup pattern) and persisted so an adapter restart also skips the
 * probe. A reconnect or restart then goes straight to the targeted sweep; the sweep
 * itself always runs (values must be fresh), only the probe phase is saved.
 */
export interface YncaSubunitCache {
  /** The cached snapshot, or undefined when none/invalidated. */
  get(): YncaAvailSnapshot | undefined;
  /** Store a fresh probe result (also persists it). */
  set(snapshot: YncaAvailSnapshot): void;
  /** Drop the cache (also persists the removal) — used when model/firmware changed. */
  clear(): void;
}

/**
 * Whether a persisted value is a usable snapshot (API boundary — the device
 * object's native part is untrusted storage).
 *
 * @param value the raw persisted value
 * @returns true when it carries the snapshot shape
 */
export function isAvailSnapshot(value: unknown): value is YncaAvailSnapshot {
  const candidate = value as Partial<YncaAvailSnapshot> | null;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    Array.isArray(candidate.subunits) &&
    candidate.subunits.every(entry => typeof entry === "string") &&
    typeof candidate.model === "string" &&
    typeof candidate.firmware === "string"
  );
}

/**
 * Build a cache around an initial (persisted) snapshot and a persist callback.
 *
 * @param initial the snapshot loaded from persistence, if any
 * @param persist called with the new snapshot on set, and undefined on clear
 * @returns the cache
 */
export function createSubunitCache(
  initial: YncaAvailSnapshot | undefined,
  persist: (snapshot: YncaAvailSnapshot | undefined) => void,
): YncaSubunitCache {
  let current = initial;
  return {
    get: () => current,
    set: snapshot => {
      current = snapshot;
      persist(snapshot);
    },
    clear: () => {
      current = undefined;
      persist(undefined);
    },
  };
}
