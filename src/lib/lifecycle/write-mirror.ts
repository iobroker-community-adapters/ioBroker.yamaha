/**
 * What the states database holds, mirrored in memory — so the adapter writes a state only when it differs, and
 * judges that without reading the database again (audit 2026-09-29, E3; fleet rule of round 62).
 *
 * The mirror holds the last value and ack of every state of the namespace — the adapter subscribes to all of
 * them, so a user's write reaches it as well. It is seeded from one bulk read of the namespace at start. A
 * read-only state is decided here and never read back while nothing changes; a writable state, and one the
 * mirror does not know yet, is compared by the database (`setStateChangedAsync`).
 *
 * Objects go through the fleet master `known-objects.ts` (`KnownObjects`) since 2026-10-02; the object half that
 * stood here — a second version of the database merge — is gone.
 */

/** The state half of the mirror (namespace-relative ids): the last value and ack of each state. */
export class StateMirror {
  private readonly states = new Map<string, string>();
  /**
   * Whether the bulk read of the namespace went in: from then on a state the mirror does not hold has
   * no value in the database — its first write is a change, and `setStateChangedAsync` would only read
   * it one by one to learn that (forum 85413 release run, round 77 resource check).
   */
  private seeded = false;

  /**
   * Take the states one bulk read returned (`getStatesAsync` of the own namespace) — a restart then
   * writes nothing blind and reads nothing per state.
   *
   * @param states the states by full id
   * @param namespace the adapter namespace (`yamaha.0`)
   */
  public seed(states: Record<string, unknown>, namespace: string): void {
    this.seeded = true;
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
   * the bulk read did not go in, the database decides. After the bulk read a state the mirror does not
   * hold has no value: `changed`.
   *
   * @param id the namespace-relative state id
   * @param val the value to write
   * @param ack the ack flag to write
   * @returns the verdict
   */
  public judge(id: string, val: unknown, ack: boolean): "unchanged" | "changed" | "unknown" {
    const stored = this.states.get(id);
    if (stored === undefined) {
      return this.seeded ? "changed" : "unknown";
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
