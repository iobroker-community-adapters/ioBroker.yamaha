/**
 * Where a zone's states live in the object tree — the MusicCast view of the one zone table
 * (`catalog/zones.ts`). The prefix used to be written out in three places here alone; the third copy
 * once broke the equalizer cache for zones 2–4 when the tree moved the zones under `multiroom.`.
 */
import { ZONE_KEYS } from "../catalog/zones";

/** The zone ids the MusicCast API uses — the unified zone keys. */
export const YXC_ZONE_IDS = ZONE_KEYS;

export { splitZone, zonePrefix } from "../catalog/zones";
