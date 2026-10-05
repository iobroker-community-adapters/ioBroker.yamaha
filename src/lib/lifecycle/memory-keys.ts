/**
 * The keys of a device's probe memory (`ProbeMemory`, persisted in the capability profile) — ONE table.
 *
 * Several modules read keys another module writes: the connect attempt asks whether a transport ever answered
 * (`yncaCapabilities`, `yxcIdentity`, `xmlIdentity`), the capability profile derives the device identity from them, the
 * scene titles read XML's and YNCA's answers, and YNCA reads XML's input evidence. Spelled as string literals in six
 * modules, a rename in one of them broke the others without a sound (review 2026-10-05, X6).
 *
 * The VALUES are persisted in every installation's profile: never rename one, or every device forgets what it learned.
 * A transport's own keys start with its prefix (MusicCast's three oldest ones excepted), which is what the XML identity
 * check relies on when it forgets everything XML learned about a device that was swapped.
 */
export const MEMORY_KEY = {
  /** YNCA: the capability shape (subunits, functions, model, firmware) — the fast-restart layer. */
  yncaCapabilities: "yncaCapabilities",
  /** YNCA: the values that do not change while the device runs (names, scene titles, …). */
  yncaStaticValues: "yncaStaticValues",
  /** YNCA: every value an enum function was ever seen with. */
  yncaObserved: "yncaObserved",
  /** YNCA: the proven key dialect of the main pad. */
  yncaPadDialect: "yncaPadDialect",
  /** YNCA: the proven key fields of the zone pads. */
  yncaZonePads: "yncaZonePads",
  /** YNCA: the sources whose menu a probe proved. */
  yncaBrowseSources: "yncaBrowseSources",
  /** MusicCast: `model|system_version` — the identity the MusicCast memory is valid for. */
  yxcIdentity: "yxcIdentity",
  /** MusicCast: serial (`system_id`) and MAC (`device_id`). */
  yxcDeviceIds: "yxcDeviceIds",
  /** MusicCast: the parsed `getFeatures`. */
  yxcFeatures: "features",
  /** MusicCast: the model of an earlier release (only ever dropped). */
  yxcModel: "model",
  /** MusicCast: the names of an earlier release (only ever dropped — names are read fresh). */
  yxcNames: "name",
  /** MusicCast: the volume display scale per zone, settled at a read-in. */
  yxcVolumeMode: "yxcVolumeMode",
  /** MusicCast: the device-wide entries the device ever declared. */
  yxcSystemEntries: "yxcSystemEntries",
  /** XML: `model|systemId|version`. */
  xmlIdentity: "xmlIdentity",
  /** XML: System > Config (zones, features, input names) — read by YNCA as input evidence. */
  xmlConfig: "xmlConfig",
  /** XML: the dialect the device answered in (`classic`/`legacy`). */
  xmlDialect: "xmlDialect",
  /** XML: every zone that ever answered. */
  xmlZones: "xmlZones",
  /** XML: the parsed device description. */
  xmlDescriptor: "xmlDescriptor:v3",
  /** XML: the sources whose menu the probe proved. */
  xmlBrowseSources: "xmlBrowseSources:v2",
  /** XML: the tuner probe. */
  xmlTuner: "xmlTuner",
  /** XML: the tuner preset list. */
  xmlTunerPresets: "xmlTunerPresets",
  /** XML: the system power probe. */
  xmlSystemPower: "xmlSystemPower",
} as const;

/**
 * XML: the raw scene declaration of one zone (read by the scene titles of every transport).
 *
 * @param zone the zone key
 * @returns the key
 */
export function xmlScenesKey(zone: string): string {
  return `xmlScenes:${zone}`;
}

/**
 * XML: the raw input declaration of one zone.
 *
 * @param zone the zone key
 * @returns the key
 */
export function xmlInputsKey(zone: string): string {
  return `xmlInputs:${zone}`;
}

/**
 * XML: the Basic_Status fields one zone ever delivered.
 *
 * @param zone the zone key
 * @returns the key
 */
export function xmlStatusFieldsKey(zone: string): string {
  return `xmlStatusFields:${zone}`;
}

/**
 * XML: the zone names one zone declared.
 *
 * @param zone the zone key
 * @returns the key
 */
export function xmlZoneNamesKey(zone: string): string {
  return `xmlZoneNames:${zone}`;
}
