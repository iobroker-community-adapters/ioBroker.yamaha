/** The zone keys a YXC push event may carry — each is a getStatus re-fetch signal. */
const ZONE_KEYS = ["main", "zone2", "zone3", "zone4"];

/** The media-player blocks a YXC push may carry — each is a getPlayInfo re-fetch signal. */
const MEDIA_KEYS = ["netusb", "cd", "tuner"];

/**
 * The playback clock: while a source plays, the device pushes `play_time` every second. A
 * block carrying nothing else is a clock tick, not a change of the metadata — its values go
 * straight to the player states, and the device is not asked for the whole playback status.
 */
const TIME_KEYS = new Set(["play_time", "total_time"]);

/** The two sources with a playback clock — the tuner has none. */
const CLOCK_BLOCKS = ["netusb", "cd"] as const;

/**
 * Whether a push block is nothing but the playback clock.
 *
 * @param block the block's value in the push event
 * @returns true for a non-empty object whose every key is a clock field
 */
function isClockOnly(block: unknown): block is Record<string, unknown> {
  if (typeof block !== "object" || block === null) {
    return false;
  }
  const keys = Object.keys(block);
  return keys.length > 0 && keys.every(key => TIME_KEYS.has(key));
}

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
 * A block that carries only the playback clock is not a re-fetch signal — see
 * {@link mediaTimeUpdates}.
 *
 * @param pushEvent the parsed UDP push JSON
 * @returns the media blocks present in the event, in canonical order
 */
export function mediaToRefresh(pushEvent: unknown): string[] {
  if (typeof pushEvent !== "object" || pushEvent === null) {
    return [];
  }
  const event = pushEvent as Record<string, unknown>;
  return MEDIA_KEYS.filter(block => block in event && !isClockOnly(event[block]));
}

/**
 * The clock ticks in a push: the `netusb`/`cd` blocks that carry nothing but `play_time`
 * (and `total_time`). Their values feed the player states directly, so the elapsed time
 * follows every second without a request to the device.
 *
 * @param pushEvent the parsed UDP push JSON
 * @returns the clock-only blocks with their fields, in canonical order
 */
export function mediaTimeUpdates(pushEvent: unknown): Array<{ block: "netusb" | "cd"; info: Record<string, unknown> }> {
  if (typeof pushEvent !== "object" || pushEvent === null) {
    return [];
  }
  const event = pushEvent as Record<string, unknown>;
  const updates: Array<{ block: "netusb" | "cd"; info: Record<string, unknown> }> = [];
  for (const block of CLOCK_BLOCKS) {
    const info = event[block];
    if (isClockOnly(info)) {
      updates.push({ block, info });
    }
  }
  return updates;
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
