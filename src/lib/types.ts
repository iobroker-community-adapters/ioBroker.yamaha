/** A configured device (name + address, from the admin device table). */
export interface DeviceRecord {
  /** Stable device id (used as the object-tree path segment). */
  id: string;
  /** Device IP address. */
  ip: string;
}

/** A unified state id and its typed value (catalog / status-parser form). */
export interface StateValue {
  /** State id relative to the device (e.g. `power`, `zone2.volume`). */
  id: string;
  /** Typed value for the state. */
  value: boolean | number | string;
}
