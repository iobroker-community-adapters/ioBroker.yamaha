import type { ValueSpec } from "./value-coerce";
import { tName, type I18nKey } from "../i18n";

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
  /**
   * Values substituted into the name key's `%s` placeholders, in order. Lets a family of
   * datapoints built in a loop carry distinguishable names (the assignable input names)
   * instead of all sharing the family's label.
   */
  nameArgs?: Array<string | number>;
  /**
   * The datapoint's EXPLANATION, as its translation key (fleet standard
   * `feedback_beschreibung_ist_erklaerung`): one short sentence saying what the value means,
   * never the protocol identifier and never the name again. Deliberately OPTIONAL — where a
   * datapoint explains itself (`power`, `volume`, `artist`) an invented sentence would be
   * noise, and the standard asks for an empty field rather than filler. What must never
   * happen is a SILENT gap, so every catalog entry without a key is covered by a pattern in
   * `test/self-explaining.json` — the one decision file, which the fleet inventory gate holds
   * against the built object tree — and the manifest test refuses an entry that is in neither.
   */
  descKey?: I18nKey;
  /** Value semantics — drives type/role/states/range via {@link ValueSpec}. */
  spec: ValueSpec;
  /** Whether the user can write this state. */
  write: boolean;
  /** Explicit ioBroker role; when omitted it is derived from the spec kind. */
  role?: string;
}

/** An object to create in the device tree: a state or a channel. */
export interface ObjectDef {
  /**
   * Set when the transport could not PROVE it serves this capability and is claiming it on
   * presence alone. The object-tree coordinator then prefers a transport that DID prove it,
   * whatever the modernity rank says.
   *
   * The one case today is the YNCA menu claim: a receiver in standby answers `@RESTRICTED` to
   * every media subunit, which is indistinguishable from "cannot browse", so the claim is kept
   * rather than stripping the menus off a device that serves them once it is on. A receiver
   * spends most of its life in standby, so that unproven claim is the NORMAL state at adapter
   * start — and ranking above XML it displaced the transport that does probe. That is issue
   * #613, reached through the standby door (audit 2026-09-06). Never written to the object.
   */
  unproven?: boolean;
  /**
   * The `common.states` map is the DEVICE'S OWN declaration of the selectable values — the XML
   * `Input_Sel_Item` list, the `desc.xml` enumerations, the MusicCast `input_list` and value
   * lists — not a catalog union. The object-tree coordinator lets such a declaration replace a
   * union on the owning transport's datapoint (#619: the YNCA-owned input showed all 54 catalog
   * inputs while XML had read the receiver's own list). Only within one wire vocabulary, see
   * `STATES_VOCABULARY`. Never written to the object, like `unproven`.
   */
  declaredStates?: boolean;
  /** Object id relative to the device. */
  id: string;
  /** Object kind. */
  type: "state" | "channel";
  /** ioBroker common part. */
  common: {
    /** Resolved to all admin languages — never a plain string (state-role gate). */
    name: ioBroker.StringOrTranslated;
    /**
     * The datapoint's explanation, resolved to all admin languages. Absent where the datapoint
     * explains itself — the fleet standard wants an empty field there, not invented prose.
     * The field was MISSING from this type until 2026-09-03, which is why the tuner and scene
     * datapoints built directly by the MusicCast and XML controllers could never carry one:
     * the catalogs had the key, the object type had nowhere to put it.
     */
    desc?: ioBroker.StringOrTranslated;
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
/**
 * Explanations for the channel ids that need one — the folders whose purpose is not obvious
 * from their name. Same rule as {@link CatalogEntry.descKey}: a folder that explains itself
 * (`sound`, `tuner`, a source name like `spotify`) stays out, because the fleet standard wants
 * an empty description rather than filler. Keys are the identifiers in `admin/i18n`.
 */
export const CHANNEL_DESC_KEYS: Record<string, I18nKey> = {
  info: "descChannelInfo",
  zoneB: "descChannelZoneB",
  advanced: "descChannelAdvanced",
  speakers: "descChannelSpeakers",
  scene: "descChannelScene",
  remote: "descChannelRemote",
  inputNames: "descChannelInputNames",
  initialVolume: "descChannelInitialVolume",
  equalizer: "descChannelEqualizer",
  signal: "descChannelSignal",
  dab: "descChannelDab",
  player: "descChannelPlayer",
  multiroom: "descChannelMultiroom",
  group: "descChannelGroup",
  browse: "descChannelBrowse",
  trigger1Inputs: "descChannelTrigger1Inputs",
};

export const CHANNEL_NAME_KEYS: Record<string, I18nKey> = {
  // Device info (metadata beside the per-device connection indicator)
  info: "info",
  // Zones
  zone2: "zone2",
  zone3: "zone3",
  zone4: "zone4",
  zoneB: "zoneB",
  // Amplifier groups
  sound: "sound",
  advanced: "advanced",
  hdmi: "hdmi",
  speakers: "speakers",
  scene: "scenes",
  remote: "remoteControl",
  inputNames: "inputNames",
  initialVolume: "initialVolume",
  equalizer: "equalizer",
  signal: "audioSignal",
  // Tuner
  tuner: "tuner",
  dab: "dab",
  // Media player container + multiroom
  player: "mediaPlayer",
  multiroom: "multiroom",
  // The MusicCast-Link folder under multiroom — a group of linked DEVICES, not zones.
  group: "musiccastGroupLinkedDevices",
  // Media player sources
  ipod: "iPod",
  ipodUsb: "ipodUSB",
  netRadio: "netRadio",
  trigger1Inputs: "trigger1Inputs",
  usb: "usb",
  napster: "napster",
  pandora: "pandora",
  rhapsody: "rhapsody",
  sirius: "siriusxm",
  airplay: "airplay",
  bluetooth: "bluetooth",
  pc: "pc",
  musicCastLink: "musiccastLink",
  // The browsing surface's own folder. It was missing here until the object inventory measured
  // the built tree (2026-09-07): the folder HAS an explanation, so it went out with a translated
  // desc next to the hard-coded English fallback name "Browse" — on every device.
  browse: "browse",
  // YXC/XML media channels
  cd: "cd",
  netPlayer: "networkPlayer",
  clock: "clock",
};

/**
 * The `common` of a channel object: its translated name, plus its explanation where one
 * exists. THE one place that answers both questions — the four object builders (the shared
 * catalog path, the MusicCast object mapper, the XML controller and the browsing surface) all
 * go through it.
 *
 * It exists because they did not: only the catalog path read {@link CHANNEL_DESC_KEYS}, so
 * every folder built by MusicCast or XML came out without an explanation, and on a device that
 * speaks both the owner policy handed the description-less MusicCast definition to the user
 * (audit 2026-09-06: 3 of 303 folders explained on the MusicCast path against 105 of 213 on
 * the YNCA one). A folder id not listed falls back to its capitalised segment — that is a
 * device-derived name (a MusicCast weekday alarm channel), which has nothing to translate.
 *
 * @param segment the channel's last path segment
 * @returns the channel's common (name, and desc where the segment has one)
 */
export function channelCommon(segment: string): ObjectDef["common"] {
  const nameKey = CHANNEL_NAME_KEYS[segment];
  const descKey = CHANNEL_DESC_KEYS[segment];
  return {
    name: nameKey ? tName(nameKey) : segment.charAt(0).toUpperCase() + segment.slice(1),
    ...(descKey ? { desc: tName(descKey) } : {}),
  };
}
