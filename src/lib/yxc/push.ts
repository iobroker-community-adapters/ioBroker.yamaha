/** The zone keys a YXC push event may carry — each is a getStatus re-fetch signal. */
const ZONE_KEYS = ["main", "zone2", "zone3", "zone4"];

/** The media-player blocks a YXC push may carry — each is a getPlayInfo re-fetch signal. */
const MEDIA_KEYS = ["netusb", "cd", "tuner"];

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

/**
 * Determine which media-player sources a YXC push asks to re-fetch. A push
 * carries a top-level `netusb`/`cd`/`tuner` block (with flags like
 * `play_info_updated`) when that source changed; the new values come from a
 * getPlayInfo per source, not from the push itself. Without this, media metadata
 * (track, band, playback) would only refresh on the slow keepalive poll.
 *
 * @param pushEvent the parsed UDP push JSON
 * @returns the media blocks present in the event, in canonical order
 */
export function mediaToRefresh(pushEvent: unknown): string[] {
  if (typeof pushEvent !== "object" || pushEvent === null) {
    return [];
  }
  const event = pushEvent as Record<string, unknown>;
  return MEDIA_KEYS.filter(block => block in event);
}

/**
 * Determine which netusb LISTS a YXC push asks to re-fetch: the stored favourites
 * (`preset_info_updated`) and the recently-played list (`recent_info_updated`) are
 * flags inside the push's netusb block — without them the lists would only refresh
 * on the keepalive poll.
 *
 * @param pushEvent the parsed UDP push JSON
 * @returns which of the two lists changed
 */
export function netusbListsToRefresh(pushEvent: unknown): { presets: boolean; recent: boolean } {
  const netusb = (pushEvent as { netusb?: unknown } | null)?.netusb;
  if (typeof netusb !== "object" || netusb === null) {
    return { presets: false, recent: false };
  }
  const flags = netusb as Record<string, unknown>;
  return { presets: flags.preset_info_updated === true, recent: flags.recent_info_updated === true };
}
