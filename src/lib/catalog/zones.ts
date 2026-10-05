/** A zone key as every transport and the object tree name it. */
export type ZoneKey = "main" | "zone2" | "zone3" | "zone4";

/** One zone of a receiver, with its name on each transport. */
export interface ZoneDef {
  /** Unified zone key (`main`, `zone2`, …) — also MusicCast's zone id. */
  key: ZoneKey;
  /** State-id prefix in the object tree: the main zone at the device root, the others under `multiroom.`. */
  prefix: string;
  /** The YNCA subunit (`MAIN`, `ZONE2`, …). */
  ynca: string;
  /** The XML zone element — also the key of its `Feature_Existence` flag in System/Config. */
  xml: "Main_Zone" | "Zone_2" | "Zone_3" | "Zone_4";
}

/**
 * The zones — ONE table for every transport, the owner policy and the upgrade cleanup. The prefix
 * stood in six tables and two regular expressions; a copy that did not move with the zones once
 * broke the MusicCast equalizer cache for zones 2–4 (audit 2026-09-29, A25).
 */
export const ZONES: readonly ZoneDef[] = [
  { key: "main", prefix: "", ynca: "MAIN", xml: "Main_Zone" },
  { key: "zone2", prefix: "multiroom.zone2.", ynca: "ZONE2", xml: "Zone_2" },
  { key: "zone3", prefix: "multiroom.zone3.", ynca: "ZONE3", xml: "Zone_3" },
  { key: "zone4", prefix: "multiroom.zone4.", ynca: "ZONE4", xml: "Zone_4" },
];

/** Every zone key, main first. */
export const ZONE_KEYS: readonly ZoneKey[] = ZONES.map(zone => zone.key);

/** The zones with a folder of their own (all but the main zone). */
const ZONED = ZONES.filter(zone => zone.prefix !== "");

/**
 * Zone B — the second speaker set of the main zone. In the tree it is a zone like any other (`multiroom.zoneB.`):
 * MusicCast serves it as its `zone2` on a device that declares `zone_b` (YXC Basic Rev 1.10 §4.2), YNCA and XML
 * through the main zone (`@MAIN:ZONEBVOL`, `<Main_Zone>…<Zone_B>`). No transport addresses it as a zone of its
 * own, so it has no row in {@link ZONES} — but every rule that reads a zone folder (value labels, the datapoint
 * groups, the owner policy, the percent switch) treats it as one. It stood in two hand-written expressions and was
 * missing from the rest, so the same datapoint changed its name and role with the protocol serving it (review
 * 2026-10-05, A27).
 */
export const ZONE_B_PREFIX = "multiroom.zoneB.";

/** Every zone folder of the tree: zones 2 to 4 and Zone B. */
const ZONE_FOLDERS: readonly string[] = [...ZONED.map(zone => zone.prefix), ZONE_B_PREFIX];

/** A zone folder in front of a state id (`multiroom.zone2.`, `multiroom.zoneB.`), derived from the table. */
export const ZONE_PREFIX = new RegExp(`^(?:${ZONE_FOLDERS.map(prefix => prefix.replace(/\./g, "\\.")).join("|")})`);

/**
 * The prefix of a zone.
 *
 * @param key the zone key (`main`, `zone2`, …)
 * @returns the prefix, empty for the main zone or an unknown key
 */
export function zonePrefix(key: string): string {
  return ZONES.find(zone => zone.key === key)?.prefix ?? "";
}

/**
 * A state id split into its zone and the zone-relative name — the one parse of the zone prefix (it
 * stood as a regex literal at eight places; audit 2026-09-29, C46/D17).
 *
 * @param stateId the state id relative to the device
 * @returns the zone (`main` without a prefix) and the rest of the id
 */
export function splitZone(stateId: string): { zone: ZoneKey; name: string } {
  const zone = ZONED.find(candidate => stateId.startsWith(candidate.prefix));
  return zone ? { zone: zone.key, name: stateId.slice(zone.prefix.length) } : { zone: "main", name: stateId };
}

/**
 * The prefix of a zoned id in either tree form — today's `multiroom.zone2.` and the flat `zone2.` of the
 * trees before v0.19.0, which only the upgrade cleanup still has to recognise.
 */
export const ANY_ZONE_PREFIX = new RegExp(`^(?:multiroom\\.)?(?:${ZONED.map(zone => zone.key).join("|")})\\.`);
