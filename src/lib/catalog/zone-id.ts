/**
 * A state id split into its zone and the zone-relative name — the one parse of the `multiroom.zoneN.`
 * prefix every transport writes its zones under (it stood as a regex literal at eight places in the
 * MusicCast and XML code; audit 2026-09-29, C46/D17).
 *
 * @param stateId the state id relative to the device
 * @returns the zone (`main` without a prefix) and the rest of the id
 */
export function splitZone(stateId: string): { zone: string; name: string } {
  const match = /^multiroom\.(zone[234])\.(.+)$/.exec(stateId);
  return match ? { zone: match[1], name: match[2] } : { zone: "main", name: stateId };
}
