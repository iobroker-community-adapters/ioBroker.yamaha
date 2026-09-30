import type { DeviceIdentity } from "./device-identity";
import type { DeviceServices } from "./discovery";

/**
 * Where a device's address came from. A manual device carries an address the user typed, so it
 * stays there for good; a discovered one answered the network search and may move; a migrated
 * one is the row the 0.5.4 upgrade wrote with a numeric address as its NAME (nobody typed it), and
 * it follows the device like a discovered one. A carried-over hostname row counts as manual: the
 * name server follows the device for it.
 */
export type DeviceSource = "manual" | "migrated" | "discovered";

/** A configured device (name + address, from the admin device table or the discovery store). */
export interface DeviceRecord {
  /** Stable device id (used as the object-tree path segment). */
  id: string;
  /** Device IP address. */
  ip: string;
  /**
   * Where this record came from. Absent in the stored discovery file (everything in it is
   * discovered by definition), present on every record the search returns and on every
   * record a running device was started from.
   */
  source?: DeviceSource;
  /** Serial/MAC as the description or a transport reported it — the match key next to the id. */
  identity?: DeviceIdentity;
  /** The model the UPnP description advertised (discovered devices only) — half of the id. */
  model?: string;
  /** The control services the UPnP description advertised (discovered devices only). */
  services?: DeviceServices;
}

/** A device value as a datapoint takes it: `null` is "none right now" — never `""` on a list. */
export type DeviceValue = boolean | number | string | null;

/** A unified state id and its typed value (catalog / status-parser form). */
export interface StateValue {
  /** State id relative to the device (e.g. `power`, `multiroom.zone2.volume`). */
  id: string;
  /** Typed value for the state — `null` where there is none (a list value the device does not report now). */
  value: DeviceValue;
}
