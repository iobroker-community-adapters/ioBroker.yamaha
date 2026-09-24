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

/**
 * The fields a media block carries that are NOT a change of its playback info (YXC Basic Rev 1.10
 * §11.3): the clock, the list and account flags, the network player's error/message and preset
 * results. A block of nothing but these is answered from the push itself or by its own refresh —
 * re-reading the whole playback info on every favourite store or list change was a request for
 * nothing. Any field NOT listed (a firmware newer than the specification) still re-reads, as before.
 */
const NOT_PLAY_INFO: Readonly<Record<string, ReadonlySet<string>>> = {
  netusb: new Set([
    "play_time",
    "total_time",
    "play_error",
    "multiple_play_errors",
    "play_message",
    "account_updated",
    "preset_info_updated",
    "recent_info_updated",
    "preset_control",
    "trial_status",
    "trial_time_left",
    "list_info_updated",
    "play_info_updated",
  ]),
  cd: new Set(["play_time", "total_time", "device_status", "play_info_updated"]),
  tuner: new Set(["preset_info_updated", "play_info_updated"]),
};

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
  return MEDIA_KEYS.filter(block => {
    const fields = event[block];
    if (typeof fields !== "object" || fields === null) {
      return block in event;
    }
    const flags = fields as Record<string, unknown>;
    // The device says whether the playback info changed; a field the specification does not
    // know, and an empty block, are read as "maybe" — only the known non-signals are left alone.
    const keys = Object.keys(flags);
    return flags.play_info_updated === true || keys.length === 0 || keys.some(key => !NOT_PLAY_INFO[block]?.has(key));
  });
}

/** The other refresh signals a YXC push carries — each names the one request that answers it. */
export interface PushSignals {
  /** `dist.dist_info_updated` → getDistributionInfo. */
  distribution: boolean;
  /** `system.func_status_updated` → getFuncStatus. */
  system: boolean;
  /** `system.name_text_updated` (Rev 1.10) → getNameText. */
  nameText: boolean;
  /** `<zone>.signal_info_updated` (Rev 1.10) → getSignalInfo for these zones. */
  signalZones: string[];
  /** `tuner.preset_info_updated` → the tuner preset lists. */
  tunerPresets: boolean;
  /** `clock.settings_updated` (Rev 1.10) → getClockSettings. */
  clock: boolean;
  /** `netusb.list_info_updated` → the open menu window. */
  list: boolean;
}

/**
 * Read the refresh signals of a push (YXC Basic Rev 1.10 §11.3). Six of them were ignored: a group
 * formed in the app, a changed device setting, a renamed room, a new input signal, a stored tuner
 * preset and a changed alarm showed only on the next full sweep — up to 30 minutes with push
 * (audit 2026-09-24, C3). Only a flag that is `true` counts.
 *
 * @param pushEvent the parsed UDP push JSON
 * @returns the signals it carries
 */
export function pushSignals(pushEvent: unknown): PushSignals {
  const event = typeof pushEvent === "object" && pushEvent !== null ? (pushEvent as Record<string, unknown>) : {};
  const flag = (block: string, key: string): boolean => {
    const fields = event[block];
    return typeof fields === "object" && fields !== null && (fields as Record<string, unknown>)[key] === true;
  };
  return {
    distribution: flag("dist", "dist_info_updated"),
    system: flag("system", "func_status_updated"),
    nameText: flag("system", "name_text_updated"),
    signalZones: ZONE_KEYS.filter(zone => flag(zone, "signal_info_updated")),
    tunerPresets: flag("tuner", "preset_info_updated"),
    clock: flag("clock", "settings_updated"),
    list: flag("netusb", "list_info_updated"),
  };
}

/** What the network player reports in a push itself — no request answers it. */
export interface NetusbNotice {
  /** `play_error` (0 = none; the codes of YXC Basic §10.3/§11.3). */
  playError?: number;
  /** `play_message`, as the device sends it. */
  playMessage?: string;
  /** `preset_control`: the result of a favourite store, clear or recall. */
  presetControl?: { type: string; num: number; result: string };
}

/**
 * The network player's own report in a push: the playback error and message and the result of a
 * preset operation — carried by the event and nowhere else (audit 2026-09-24, C18).
 *
 * @param pushEvent the parsed UDP push JSON
 * @returns the fields the push carries
 */
export function netusbNotice(pushEvent: unknown): NetusbNotice {
  const netusb = (pushEvent as { netusb?: unknown } | null)?.netusb;
  if (typeof netusb !== "object" || netusb === null) {
    return {};
  }
  const fields = netusb as Record<string, unknown>;
  const notice: NetusbNotice = {};
  if (typeof fields.play_error === "number") {
    notice.playError = fields.play_error;
  }
  if (typeof fields.play_message === "string") {
    notice.playMessage = fields.play_message;
  }
  const control = fields.preset_control as Record<string, unknown> | undefined;
  if (
    typeof control === "object" &&
    control !== null &&
    typeof control.type === "string" &&
    typeof control.num === "number" &&
    typeof control.result === "string"
  ) {
    notice.presetControl = { type: control.type, num: control.num, result: control.result };
  }
  return notice;
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
