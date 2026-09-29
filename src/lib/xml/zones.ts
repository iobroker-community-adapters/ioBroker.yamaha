import { ZONES, type ZoneKey } from "../catalog/zones";

/** A zone of the XML API (see `catalog/zones.ts`, the one zone table). */
export interface XmlZone {
  /** Unified zone key (`main`, `zone2`, …). */
  key: ZoneKey;
  /** XML zone element — also the key of its `Feature_Existence` flag in System/Config. */
  element: "Main_Zone" | "Zone_2" | "Zone_3" | "Zone_4";
  /** State-id prefix for the zone. */
  prefix: string;
}

/** Every zone the XML API knows, main first. */
export const XML_ZONES: readonly XmlZone[] = ZONES.map(zone => ({
  key: zone.key,
  element: zone.xml,
  prefix: zone.prefix,
}));

/**
 * The zone of a unified zone key.
 *
 * @param key the zone key (`main`, `zone2`, …)
 * @returns the zone, or undefined for an unknown key
 */
export function xmlZone(key: string): XmlZone | undefined {
  return XML_ZONES.find(zone => zone.key === key);
}
