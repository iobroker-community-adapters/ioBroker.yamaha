import type { ValueSpec } from "./value-coerce";
import type { I18nKey } from "../i18n";

/**
 * One catalogued device function → one ioBroker state. The catalog is
 * device-agnostic: it lists every function a protocol can expose; the
 * per-device mapper picks the entries the device actually reports.
 *
 * **Single source rule.** Each protocol catalog extends this with its own
 * protocol key (YNCA: the subunit function name; YXC: the getStatus field +
 * write method; XML: the Basic_Status field + PUT builder). The init sweep, the
 * device→state read-back and the user-write encode are all derived from that one
 * extended list — never a second state↔function table beside the catalog (the
 * `AMP_STATES` vs `STATE_MAPPINGS` split this rewrite removes). `catalogToObjects`
 * reads only the object fields below and ignores the protocol key.
 */
export interface CatalogEntry {
  /** State id relative to the device — dotted for a channel (e.g. `power`, `sound.bass`, `zone2.power`). */
  id: string;
  /**
   * The object's display name, as its translation KEY (the English text, which is also the key
   * in `admin/i18n`). The catalogs are module-level constants, built before the adapter starts
   * — so they carry the key and {@link catalogToObjects} resolves it into all eleven languages.
   */
  nameKey: I18nKey;
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
    /** Resolved to all admin languages — never a plain string (state-role gate). */
    name: ioBroker.StringOrTranslated;
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
 * here falls back to its capitalised segment, so a new channel still renders — but
 * every channel a catalog actually creates is named here, so nothing shows a raw id
 * like "Pc" or "Ipod" in the object browser. Keys match the real channel segments
 * (verified against the built catalogs); do not add speculative entries.
 */
export const CHANNEL_NAME_KEYS: Record<string, I18nKey> = {
  // Device info (metadata beside the per-device connection indicator)
  info: "Info",
  // Zones
  zone2: "Zone 2",
  zone3: "Zone 3",
  zone4: "Zone 4",
  zoneB: "Zone B",
  // Amplifier groups
  sound: "Sound",
  advanced: "Advanced",
  hdmi: "HDMI",
  speakers: "Speakers",
  scene: "Scenes",
  remote: "Remote control",
  inputNames: "Input names",
  initialVolume: "Initial volume",
  equalizer: "Equalizer",
  signal: "Audio signal",
  // Tuner
  tuner: "Tuner",
  dab: "DAB",
  // Media player container + multiroom
  player: "Media player",
  multiroom: "Multiroom",
  // The MusicCast-Link folder under multiroom — a group of linked DEVICES, not zones.
  group: "MusicCast group (linked devices)",
  // Media player sources
  netRadio: "Net radio",
  server: "Media server",
  usb: "USB",
  spotify: "Spotify",
  deezer: "Deezer",
  tidal: "Tidal",
  napster: "Napster",
  pandora: "Pandora",
  rhapsody: "Rhapsody",
  sirius: "SiriusXM",
  airplay: "AirPlay",
  bluetooth: "Bluetooth",
  pc: "PC",
  musicCastLink: "MusicCast Link",
  ipod: "iPod",
  ipodUsb: "iPod (USB)",
  // YXC/XML media channels
  cd: "CD",
  netPlayer: "Network player",
  clock: "Clock",
};
