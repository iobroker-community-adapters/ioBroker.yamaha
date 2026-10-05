import type { StateValue } from "../types";
import { ZONE_KEYS, zonePrefix, type ZoneKey } from "../catalog/zones";
import { YXC_AMP_CATALOG } from "./catalog";

/**
 * A zone's own answers: its getStatus (the amplifier states of the zone catalog) and its getSignalInfo (what the zone
 * decodes right now). Parsers only — split out of the command mapper, which did five jobs (review 2026-10-05, SOLID).
 */

/**
 * Read a catalog entry's raw getStatus value — a flat field or a nested path.
 *
 * @param status the getStatus response object
 * @param read the entry's read location
 * @returns the raw value, or undefined if the field is absent
 */
function readStatusField(
  status: Record<string, unknown>,
  read: { field: string } | { path: string[]; fallbackField?: string },
): unknown {
  if ("path" in read) {
    let value: unknown = status;
    for (const key of read.path) {
      if (typeof value !== "object" || value === null) {
        value = undefined;
        break;
      }
      value = (value as Record<string, unknown>)[key];
    }
    // A device that does not report the nested form falls back to the flat field, so a speaker
    // without `actual_volume` keeps answering on `volume` exactly as before.
    if (value === undefined && read.fallbackField !== undefined) {
      return status[read.fallbackField];
    }
    return value;
  }
  return status[read.field];
}

/**
 * Parse a YXC getStatus response into unified amp state updates for a zone. Only
 * fields the response actually carries are emitted (presence-checked, so a
 * `mute: false` is kept), each prefixed for its zone. States and their conversions
 * come from {@link YXC_AMP_CATALOG}.
 *
 * @param zoneStatus the getStatus response object
 * @param zone the zone the status belongs to (`main`, `zone2`, …)
 * @returns the state updates, empty if malformed or no amp fields are present
 */
export function parseYxcStatus(zoneStatus: unknown, zone: string): StateValue[] {
  if (typeof zoneStatus !== "object" || zoneStatus === null) {
    return [];
  }
  const prefix = ZONE_KEYS.includes(zone as ZoneKey) ? zonePrefix(zone) : undefined;
  if (prefix === undefined) {
    return [];
  }
  const status = zoneStatus as Record<string, unknown>;
  const updates: StateValue[] = [];
  for (const entry of YXC_AMP_CATALOG) {
    // Device-global entries (id under multiroom.) are emitted once, from the main status —
    // a zone status carrying the same field must not produce a zone-prefixed copy.
    if (zone !== "main" && entry.state.startsWith("multiroom.")) {
      continue;
    }
    const raw = readStatusField(status, entry.read);
    if (raw !== undefined) {
      updates.push({ id: `${prefix}${entry.state}`, value: entry.fromStatus(raw) });
    }
  }
  return updates;
}

/**
 * Parse a `/<zone>/getSignalInfo` response into the read-only audio-signal states
 * (capture-verified shape: `audio` with format/fs/bit/bitrate).
 *
 * @param info the getSignalInfo response object
 * @param zone the zone the info belongs to
 * @returns the signal state updates, empty if malformed
 */
export function parseYxcSignalInfo(info: unknown, zone: string): StateValue[] {
  const audio = (info as { audio?: unknown } | null)?.audio;
  if (typeof audio !== "object" || audio === null) {
    return [];
  }
  const prefix = ZONE_KEYS.includes(zone as ZoneKey) ? zonePrefix(zone) : undefined;
  if (prefix === undefined) {
    return [];
  }
  const a = audio as Record<string, unknown>;
  const updates: StateValue[] = [];
  // With no signal on the input the device fills these with its own dash placeholder ("---").
  // Passing that through makes a text datapoint that reads like content; empty says "nothing
  // here" in the same way the player block's resting seeds do.
  const text = (value: unknown): string => {
    const trimmed = typeof value === "string" ? value.trim() : "";
    return /^-+$/.test(trimmed) ? "" : trimmed;
  };
  if (typeof a.format === "string") {
    updates.push({ id: `${prefix}sound.signal.format`, value: text(a.format) });
  }
  if (typeof a.fs === "string") {
    updates.push({ id: `${prefix}sound.signal.sampling`, value: text(a.fs) });
  }
  if (typeof a.bit === "string") {
    updates.push({ id: `${prefix}sound.signal.bits`, value: text(a.bit) });
  }
  if (typeof a.bitrate === "number") {
    updates.push({ id: `${prefix}sound.signal.bitrate`, value: a.bitrate });
  }
  return updates;
}
