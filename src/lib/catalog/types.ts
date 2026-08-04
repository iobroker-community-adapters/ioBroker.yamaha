import type { ValueSpec } from "./value-coerce";

/**
 * One catalogued device function → one ioBroker state. The catalog is
 * device-agnostic: it lists every function a protocol can expose; the
 * per-device mapper picks the entries the device actually reports.
 */
export interface CatalogEntry {
  /** State id relative to the device — dotted for a channel (e.g. `power`, `sound.bass`, `zone2.power`). */
  id: string;
  /** Display name shown in the object browser. */
  name: string;
  /** Value semantics — drives type/role/states/range via {@link ValueSpec}. */
  spec: ValueSpec;
  /** Whether the user can write this state. */
  write: boolean;
  /** Explicit ioBroker role; when omitted it is derived from the spec kind. */
  role?: string;
}

/** An object to create in the device tree: a state or a channel. */
export interface ObjectDef {
  /** Object id relative to the device. */
  id: string;
  /** Object kind. */
  type: "state" | "channel";
  /** ioBroker common part. */
  common: {
    name: string;
    type?: "boolean" | "number" | "string";
    role?: string;
    read?: boolean;
    write?: boolean;
    unit?: string;
    min?: number;
    max?: number;
    step?: number;
    states?: Record<string, string>;
  };
}

/**
 * Display names for the channel ids the catalogs use. A channel id not listed
 * here falls back to its capitalised segment, so a new channel still renders.
 */
export const CHANNEL_NAMES: Record<string, string> = {
  zone2: "Zone 2",
  zone3: "Zone 3",
  zone4: "Zone 4",
  sound: "Sound",
  hdmi: "HDMI",
  scenes: "Scenes",
  tuner: "Tuner",
  net: "Network player",
  usb: "USB",
  server: "Media server",
  cd: "CD",
  dab: "DAB",
  clock: "Clock",
};
