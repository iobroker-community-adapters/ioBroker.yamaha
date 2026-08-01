/** The zone keys a YXC push event may carry — each is a getStatus re-fetch signal. */
const ZONE_KEYS = ["main", "zone2", "zone3", "zone4"];

/**
 * Determine which zones a YXC push event asks to re-fetch. A push carries one
 * top-level block per changed area; zone blocks (`main`/`zone2`/…) are re-fetch
 * signals — their current values come from a getStatus per zone, not from the
 * push itself. Media blocks (`netusb`/`tuner`/…) are ignored here.
 *
 * @param pushEvent the parsed UDP push JSON
 * @returns the zones present in the event, in canonical order
 */
export function zonesToRefresh(pushEvent: unknown): string[] {
  if (typeof pushEvent !== "object" || pushEvent === null) {
    return [];
  }
  const event = pushEvent as Record<string, unknown>;
  return ZONE_KEYS.filter(zone => zone in event);
}
