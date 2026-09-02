/**
 * Where a zone's states live in the object tree.
 *
 * The prefix used to be written out in three places — the object mapper's zone table, the
 * command mapper's lookup and an inline expression in the controller's equalizer cache.
 * That third copy is what once broke the cache for zones 2–4: the tree moved the zones
 * under `multiroom.` and the inline copy was not moved with them, so the lookup silently
 * missed every zoned band. One definition, no drift.
 */

/** The zone ids the MusicCast API uses. */
export const YXC_ZONE_IDS = ["main", "zone2", "zone3", "zone4"] as const;

/**
 * The state-id prefix for a zone: the main zone writes at the device root, the others
 * under their `multiroom.<zone>.` folder.
 *
 * @param zone the zone id (`main`, `zone2`, …)
 * @returns the prefix, empty for the main zone
 */
export function zonePrefix(zone: string): string {
  return zone === "main" ? "" : `multiroom.${zone}.`;
}
