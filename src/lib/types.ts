/**
 * Where a device's address came from. A manual device carries an address the user typed, so it
 * is never searched for again; a discovered one answered the network search and may move.
 */
export type DeviceSource = "manual" | "discovered";

/** A configured device (name + address, from the admin device table or the discovery store). */
export interface DeviceRecord {
  /** Stable device id (used as the object-tree path segment). */
  id: string;
  /** Device IP address. */
  ip: string;
  /**
   * Where this record came from. Absent in the stored discovery file (everything in it is
   * discovered by definition) and filled when the running set is assembled.
   */
  source?: DeviceSource;
}

/** A unified state id and its typed value (catalog / status-parser form). */
export interface StateValue {
  /** State id relative to the device (e.g. `power`, `zone2.volume`). */
  id: string;
  /** Typed value for the state. */
  value: boolean | number | string;
}
