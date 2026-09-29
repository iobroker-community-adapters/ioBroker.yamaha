/**
 * Every collection the adapter keeps per device, in one register — so deleting a device forgets all
 * of them in one call. The collections stood as loose fields, and deleting a device had to clear each
 * by hand: once nine of thirteen were missed, and the pending device-object patch recreated the
 * deleted device as a bare orphan (audit 2026-09-29, A28). A collection made here is forgotten
 * without anyone remembering to; `main.test.ts` keeps a loose one from being added.
 */
export class PerDeviceCaches {
  /** Collections keyed by the device id. */
  private readonly byDevice: Array<Map<string, unknown> | Set<string>> = [];
  /** Collections keyed by namespace-relative state ids (`<device>.<state>`). */
  private readonly byState: Array<Map<string, unknown> | Set<string>> = [];

  /**
   * A map keyed by the device id.
   *
   * @returns the map, registered for {@link forget}
   */
  public map<V>(): Map<string, V> {
    const map = new Map<string, V>();
    this.byDevice.push(map);
    return map;
  }

  /**
   * A set of device ids.
   *
   * @returns the set, registered for {@link forget}
   */
  public set(): Set<string> {
    const set = new Set<string>();
    this.byDevice.push(set);
    return set;
  }

  /**
   * A map keyed by namespace-relative state ids — a device owns the keys under its own prefix.
   *
   * @returns the map, registered for {@link forget}
   */
  public stateMap<V>(): Map<string, V> {
    const map = new Map<string, V>();
    this.byState.push(map);
    return map;
  }

  /**
   * A set of namespace-relative state ids.
   *
   * @returns the set, registered for {@link forget}
   */
  public stateSet(): Set<string> {
    const set = new Set<string>();
    this.byState.push(set);
    return set;
  }

  /**
   * Forget one device everywhere: its entry in every device-keyed collection, every key under its
   * prefix in every state-keyed one.
   *
   * @param deviceId the id-safe device id
   */
  public forget(deviceId: string): void {
    for (const collection of this.byDevice) {
      collection.delete(deviceId);
    }
    const prefix = `${deviceId}.`;
    for (const collection of this.byState) {
      for (const key of [...collection.keys()]) {
        if (key.startsWith(prefix)) {
          collection.delete(key);
        }
      }
    }
  }
}
