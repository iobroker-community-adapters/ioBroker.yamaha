/**
 * What the database holds, mirrored in memory — so the adapter writes only what differs, and judges
 * that without reading the database again (audit 2026-09-29, E2/E3; fleet rules of rounds 61/62).
 *
 * Objects: a new process used to write its whole tree again (1,798 unchanged objects on an upgrade
 * start, measured in the inventory run), because the only record of "already written" lived in the
 * process. The mirror is seeded from the one object listing the start reads anyway, and every write
 * and delete of the adapter keeps it current. A patch is skipped when the stored object already
 * carries every field of it — judged with js-controller's own merge: `extendObject` is jQuery's deep
 * `extend(true, old, patch)` (7.2.2 `adapter.ts` `_extendObject`), which skips `undefined`, keeps what
 * the patch does not name, and copies `null`.
 *
 * States: the mirror holds the last value and ack of every state of the namespace — the adapter
 * subscribes to all of them, so a user's write reaches it as well. It is seeded from one bulk read of
 * the namespace at start. A read-only state is decided here and never read back while nothing
 * changes; a writable state, and one the mirror does not know yet, is compared by the database
 * (`setStateChangedAsync`).
 */

/**
 * A plain object in the sense of jQuery's `extend`: an object literal, not an array, not null.
 *
 * @param value the value to test
 * @returns true for a plain object
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Whether `stored` already carries every field of `patch` — an `extend(true, stored, patch)` would
 * change nothing.
 *
 * @param stored the value the database holds
 * @param patch the value about to be merged into it
 * @returns true when the merge would leave `stored` as it is
 */
export function carries(stored: unknown, patch: unknown): boolean {
  if (patch === undefined) {
    return true;
  }
  if (Array.isArray(patch)) {
    return Array.isArray(stored) && patch.every((item, i) => carries(stored[i], item));
  }
  if (isPlainObject(patch)) {
    return isPlainObject(stored) && Object.entries(patch).every(([key, value]) => carries(stored[key], value));
  }
  return Object.is(stored, patch);
}

/**
 * `extend(true, stored, patch)` on copies — what the database holds after an `extendObject`.
 *
 * @param stored the value the database held
 * @param patch the merged patch
 * @returns the merged value (the inputs are not changed)
 */
export function merged(stored: unknown, patch: unknown): unknown {
  if (patch === undefined) {
    return stored;
  }
  if (Array.isArray(patch)) {
    const base: unknown[] = Array.isArray(stored) ? [...stored] : [];
    patch.forEach((item, i) => {
      if (item !== undefined) {
        base[i] = merged(base[i], item);
      }
    });
    return base;
  }
  if (isPlainObject(patch)) {
    const base: Record<string, unknown> = isPlainObject(stored) ? { ...stored } : {};
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) {
        base[key] = merged(base[key], value);
      }
    }
    return base;
  }
  return patch;
}

/** The object half of the mirror (namespace-relative ids). */
export class ObjectMirror {
  private readonly objects = new Map<string, Record<string, unknown>>();

  /**
   * Take the objects a listing read — replaces whatever was mirrored.
   *
   * @param listing the objects by full id, as `getAdapterObjectsAsync` returns them
   * @param namespace the adapter namespace (`yamaha.0`)
   */
  public seed(listing: Record<string, unknown>, namespace: string): void {
    this.objects.clear();
    const prefix = `${namespace}.`;
    for (const [fullId, obj] of Object.entries(listing)) {
      if (fullId.startsWith(prefix) && isPlainObject(obj)) {
        this.objects.set(fullId.slice(prefix.length), obj);
      }
    }
  }

  /**
   * Whether writing `patch` to `id` would change nothing. An object the mirror does not know is
   * always written.
   *
   * @param id the namespace-relative object id
   * @param patch the extendObject patch
   * @returns true when the stored object already carries the patch
   */
  public carries(id: string, patch: Record<string, unknown>): boolean {
    const stored = this.objects.get(id);
    return stored !== undefined && carries(stored, patch);
  }

  /**
   * Whether `id` is a state only the adapter writes (`common.write: false`) — compared in memory; a
   * writable state keeps the database compare, which also corrects a lost user command.
   *
   * @param id the namespace-relative object id
   * @returns true for a known read-only state
   */
  public isReadOnlyState(id: string): boolean {
    const stored = this.objects.get(id);
    return stored?.type === "state" && (stored.common as { write?: unknown } | undefined)?.write === false;
  }

  /**
   * Record a write that went through.
   *
   * @param id the namespace-relative object id
   * @param patch the extendObject patch
   */
  public wrote(id: string, patch: Record<string, unknown>): void {
    this.objects.set(id, merged(this.objects.get(id), patch) as Record<string, unknown>);
  }

  /**
   * Forget an object that was deleted, and with `below` everything under it.
   *
   * @param id the namespace-relative object id
   * @param below true for a recursive delete
   */
  public deleted(id: string, below = false): void {
    this.objects.delete(id);
    if (below) {
      for (const key of [...this.objects.keys()]) {
        if (key.startsWith(`${id}.`)) {
          this.objects.delete(key);
        }
      }
    }
  }
}

/** The state half of the mirror (namespace-relative ids): the last value and ack of each state. */
export class StateMirror {
  private readonly states = new Map<string, string>();

  /**
   * Take the states one bulk read returned (`getStatesAsync` of the own namespace) — a restart then
   * writes nothing blind and reads nothing per state.
   *
   * @param states the states by full id
   * @param namespace the adapter namespace (`yamaha.0`)
   */
  public seed(states: Record<string, unknown>, namespace: string): void {
    const prefix = `${namespace}.`;
    for (const [fullId, state] of Object.entries(states)) {
      const s = state as { val?: unknown; ack?: unknown } | null | undefined;
      if (fullId.startsWith(prefix) && s && typeof s === "object") {
        this.holds(fullId.slice(prefix.length), s.val, s.ack === true);
      }
    }
  }

  /**
   * The key a value is compared by — what js-controller compares in `setStateChangedAsync`: the value
   * strictly and the ack flag. An object value never counts as unchanged.
   *
   * @param val the value
   * @param ack the ack flag
   * @returns the comparison key, undefined for an object value
   */
  private static key(val: unknown, ack: boolean): string | undefined {
    return val !== null && typeof val === "object" ? undefined : JSON.stringify([val, ack]);
  }

  /**
   * What a write of this value would be: `unchanged` (skip it), `changed` (write it), or `unknown` —
   * nothing mirrored yet in this process, the database decides.
   *
   * @param id the namespace-relative state id
   * @param val the value to write
   * @param ack the ack flag to write
   * @returns the verdict
   */
  public judge(id: string, val: unknown, ack: boolean): "unchanged" | "changed" | "unknown" {
    const stored = this.states.get(id);
    if (stored === undefined) {
      return "unknown";
    }
    const key = StateMirror.key(val, ack);
    return key !== undefined && key === stored ? "unchanged" : "changed";
  }

  /**
   * Record what the database holds now — a write of the adapter, or a change it was told about.
   *
   * @param id the namespace-relative state id
   * @param val the value
   * @param ack the ack flag
   */
  public holds(id: string, val: unknown, ack: boolean): void {
    const key = StateMirror.key(val, ack);
    if (key === undefined) {
      this.states.delete(id);
    } else {
      this.states.set(id, key);
    }
  }

  /**
   * Forget a state that was deleted, and with `below` everything under it.
   *
   * @param id the namespace-relative state id
   * @param below true for a recursive delete
   */
  public deleted(id: string, below = false): void {
    this.states.delete(id);
    if (below) {
      for (const key of [...this.states.keys()]) {
        if (key.startsWith(`${id}.`)) {
          this.states.delete(key);
        }
      }
    }
  }
}
