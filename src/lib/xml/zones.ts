/**
 * The zones of the XML API — ONE table for the command mapper and the controller (the mapper kept its
 * own element and prefix maps beside the controller's list; audit 2026-09-29, D17).
 */
export interface XmlZone {
  /** Unified zone key (`main`, `zone2`, …). */
  key: string;
  /** XML zone element — also the key of its `Feature_Existence` flag in System/Config. */
  element: "Main_Zone" | "Zone_2" | "Zone_3" | "Zone_4";
  /** State-id prefix for the zone. */
  prefix: string;
}

/** Every zone the XML API knows, main first. */
export const XML_ZONES: readonly XmlZone[] = [
  { key: "main", element: "Main_Zone", prefix: "" },
  { key: "zone2", element: "Zone_2", prefix: "multiroom.zone2." },
  { key: "zone3", element: "Zone_3", prefix: "multiroom.zone3." },
  { key: "zone4", element: "Zone_4", prefix: "multiroom.zone4." },
];

/**
 * The zone of a unified zone key.
 *
 * @param key the zone key (`main`, `zone2`, …)
 * @returns the zone, or undefined for an unknown key
 */
export function xmlZone(key: string): XmlZone | undefined {
  return XML_ZONES.find(zone => zone.key === key);
}
