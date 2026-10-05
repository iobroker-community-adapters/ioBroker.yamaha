import type { StateValue } from "../types";
import type { SlotField } from "../catalog/list-slots";
import { musicCastInputName } from "../catalog/musiccast-vocabulary";

/**
 * The device's lists: the favourites, the recently played, the stored stations, the MusicCast playlists, the play queue
 * and a group's linked devices — each as its JSON state and as slot entries (`catalog/list-slots.ts`). Parsers only —
 * split out of the command mapper, which did five jobs (review 2026-10-05, SOLID).
 */

/**
 * Parse a `/netusb/getPresetInfo` response into the favourites JSON state: the stored
 * slots with their names, empty slots (input `unknown` or no text) skipped.
 *
 * @param info the getPresetInfo response object
 * @returns the state update, or undefined if the response is malformed
 */
export function parseYxcPresetList(info: unknown): StateValue | undefined {
  const list = (info as { preset_info?: unknown } | null)?.preset_info;
  if (!Array.isArray(list)) {
    return undefined;
  }
  const slots: Array<{ num: number; input: string; name: string }> = [];
  list.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      return;
    }
    const { input, text } = entry as { input?: unknown; text?: unknown };
    if (typeof input === "string" && input !== "unknown" && typeof text === "string" && text.length > 0) {
      slots.push({ num: index + 1, input, name: text });
    }
  });
  return { id: "player.netPlayer.presets", value: JSON.stringify(slots) };
}

/**
 * Parse a `/netusb/getRecentInfo` response into the recently-played JSON state.
 *
 * @param info the getRecentInfo response object
 * @param cover turns a reported cover path into the address to show (see {@link absoluteDeviceUrl})
 * @returns the state update, or undefined if the response is malformed
 */
export function parseYxcRecentList(info: unknown, cover: (url: string) => string = url => url): StateValue | undefined {
  const list = (info as { recent_info?: unknown } | null)?.recent_info;
  if (!Array.isArray(list)) {
    return undefined;
  }
  const items: Array<{ num: number; input: string; name: string; albumArt?: string; playCount?: number }> = [];
  list.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      return;
    }
    const e = entry as { input?: unknown; text?: unknown; albumart_url?: unknown; play_count?: unknown };
    if (typeof e.input !== "string" || typeof e.text !== "string" || e.text.length === 0) {
      return;
    }
    const item: { num: number; input: string; name: string; albumArt?: string; playCount?: number } = {
      num: index + 1,
      input: e.input,
      name: e.text,
    };
    const art = typeof e.albumart_url === "string" ? cover(e.albumart_url) : "";
    if (art.length > 0) {
      item.albumArt = art;
    }
    if (typeof e.play_count === "number") {
      item.playCount = e.play_count;
    }
    items.push(item);
  });
  return { id: "player.netPlayer.recent", value: JSON.stringify(items) };
}

/**
 * Parse `/tuner/getPresetInfo` responses (one per fetched band) into the tuner
 * presets JSON state: an object keyed by band, each STORED slot kept in its raw response
 * form plus its 1-based slot number (the shape varies per band and firmware).
 *
 * The device answers with its full slot count whether or not anything is stored — on a
 * receiver with no tuner presets that is 40 FM plus 40 DAB entries of
 * `{band:"unknown", number:0, text:""}`, a JSON datapoint nobody can use. Empty slots are
 * dropped the same way the favourites list drops them; a slot is only empty when it says so
 * on every count, so an unfamiliar firmware shape is kept rather than silently swallowed.
 *
 * @param byBand each fetched band's getPresetInfo response object
 * @returns the state update, or undefined when no band delivered a list
 */
export function parseYxcTunerPresetLists(byBand: Record<string, unknown>): StateValue | undefined {
  const result: Record<string, unknown[]> = {};
  for (const [band, info] of Object.entries(byBand)) {
    const list = (info as { preset_info?: unknown } | null)?.preset_info;
    if (!Array.isArray(list)) {
      continue;
    }
    const slots: unknown[] = [];
    list.forEach((entry, index) => {
      if (typeof entry === "object" && entry !== null && !isEmptyTunerPreset(entry as Record<string, unknown>)) {
        slots.push({ num: index + 1, ...(entry as Record<string, unknown>) });
      }
    });
    result[band] = slots;
  }
  if (Object.keys(result).length === 0) {
    return undefined;
  }
  return { id: "tuner.presets", value: JSON.stringify(result) };
}

/**
 * Whether a tuner preset slot holds nothing. The device marks an unused slot with the band
 * `unknown`, frequency/service number 0 and empty text — a slot counts as empty only when
 * none of the three carries anything, so a firmware that fills only some of them is kept.
 *
 * @param slot one raw preset_info entry
 * @returns true when the slot is unused
 */
function isEmptyTunerPreset(slot: Record<string, unknown>): boolean {
  const band = slot.band;
  const hasBand = typeof band === "string" && band.length > 0 && band !== "unknown";
  const hasNumber = typeof slot.number === "number" && slot.number !== 0;
  const hasText = typeof slot.text === "string" && slot.text.trim().length > 0;
  return !hasBand && !hasNumber && !hasText;
}

/**
 * Parse a `/netusb/getMcPlaylistName` response into the playlists JSON state
 * (capture-verified shape: `name_list` of strings).
 *
 * @param info the getMcPlaylistName response object
 * @returns the state update, or undefined if the response is malformed
 */
export function parseYxcPlaylistNames(info: unknown): StateValue | undefined {
  const names = (info as { name_list?: unknown } | null)?.name_list;
  if (!Array.isArray(names)) {
    return undefined;
  }
  const list = names
    .map((name, index) => ({ num: index + 1, name }))
    .filter((entry): entry is { num: number; name: string } => typeof entry.name === "string");
  return { id: "player.netPlayer.playlists", value: JSON.stringify(list) };
}

/**
 * Parse a `/netusb/getPlayQueue` response into the play-queue JSON state
 * (capture-verified shape: `track_info` plus `playing_index`).
 *
 * @param info the getPlayQueue response object
 * @returns the state update, or undefined if the response is malformed
 */
export function parseYxcPlayQueue(info: unknown): StateValue | undefined {
  if (typeof info !== "object" || info === null) {
    return undefined;
  }
  const q = info as { track_info?: unknown; playing_index?: unknown; max_line?: unknown };
  if (!Array.isArray(q.track_info)) {
    return undefined;
  }
  const value = {
    playingIndex: typeof q.playing_index === "number" ? q.playing_index : -1,
    totalTracks: typeof q.max_line === "number" ? q.max_line : q.track_info.length,
    tracks: q.track_info,
  };
  return { id: "player.netPlayer.queue", value: JSON.stringify(value) };
}

/** One entry of a device list, by field (see `catalog/list-slots.ts`). */
export type SlotEntry = Record<string, string | number> | undefined;

/** The fields of a favourite and of a recently-played entry: its name and the source it plays. */
export const NETUSB_SLOT_FIELDS: readonly SlotField[] = [
  { key: "name", nameKey: "entryName", descKey: "descSlotName", type: "string", role: "text" },
  { key: "input", nameKey: "input", descKey: "descSlotInput", type: "string", role: "text" },
];

/** The field of a MusicCast playlist: its name. */
export const PLAYLIST_SLOT_FIELDS: readonly SlotField[] = [
  { key: "name", nameKey: "entryName", descKey: "descSlotName", type: "string", role: "text" },
];

/** The fields of a stored station: its band, name and — AM/FM — frequency in kHz (Basic §6.1 `number`). */
export const STATION_SLOT_FIELDS: readonly SlotField[] = [
  { key: "band", nameKey: "band", descKey: "descSlotBand", type: "string", role: "text" },
  { key: "name", nameKey: "entryName", descKey: "descSlotName", type: "string", role: "text" },
  { key: "frequency", nameKey: "frequency", descKey: "descSlotFrequency", type: "number", role: "value", unit: "kHz" },
];

/** The field of a linked device: its address (Advanced §5.1 `client_list[].ip_address`). */
export const CLIENT_SLOT_FIELDS: readonly SlotField[] = [
  { key: "ip", nameKey: "ipAddress", descKey: "descSlotIp", type: "string", role: "info.ip" },
];

/**
 * A netusb list (`preset_info` of getPresetInfo, `recent_info` of getRecentInfo) as slot entries:
 * name and source; a slot is empty when its source is `unknown` or it has no text.
 *
 * @param list the raw list
 * @returns the entries by slot, undefined when the list is malformed
 */
export function netusbSlotEntries(list: unknown): SlotEntry[] | undefined {
  if (!Array.isArray(list)) {
    return undefined;
  }
  return list.map(entry => {
    const { input, text } = (entry ?? {}) as { input?: unknown; text?: unknown };
    return typeof input === "string" && input !== "unknown" && typeof text === "string" && text.length > 0
      ? { name: text, input: musicCastInputName(input) }
      : undefined;
  });
}

/**
 * The play queue's tracks (`track_info` of getPlayQueue) as slot entries: the name each track is shown with.
 * The spec leaves the queue "Reserved"; its answer has the list form of getMcPlaylist (`index`, `max_line`,
 * `track_info`), whose entries carry `text`, `input`, `thumbnail` and `attribute` (Grenton's MusicCast
 * knowledge base). An entry without a text is an empty slot.
 *
 * @param info the getPlayQueue response
 * @returns the entries by slot, undefined when malformed
 */
export function playQueueSlotEntries(info: unknown): SlotEntry[] | undefined {
  const tracks = (info as { track_info?: unknown } | null)?.track_info;
  if (!Array.isArray(tracks)) {
    return undefined;
  }
  return tracks.map(track => {
    const text = (track as { text?: unknown } | null)?.text;
    return typeof text === "string" && text.length > 0 ? { name: text } : undefined;
  });
}

/**
 * The MusicCast playlist names (`name_list` of getMcPlaylistName) as slot entries.
 *
 * @param info the getMcPlaylistName response
 * @returns the entries by slot, undefined when malformed
 */
export function playlistSlotEntries(info: unknown): SlotEntry[] | undefined {
  const names = (info as { name_list?: unknown } | null)?.name_list;
  return Array.isArray(names) ? names.map(name => (typeof name === "string" ? { name } : undefined)) : undefined;
}

/**
 * One band's stored stations (`preset_info` of `/tuner/getPresetInfo`) as slot entries. `number` is the
 * frequency in kHz on AM/FM and a service id on DAB (Basic §6.1) — only the frequency becomes one.
 *
 * @param info the getPresetInfo response of one band
 * @returns the entries by slot, undefined when malformed
 */
export function stationSlotEntries(info: unknown): SlotEntry[] | undefined {
  const list = (info as { preset_info?: unknown } | null)?.preset_info;
  if (!Array.isArray(list)) {
    return undefined;
  }
  return list.map(entry => {
    const slot = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    if (isEmptyTunerPreset(slot)) {
      return undefined;
    }
    const band = typeof slot.band === "string" ? slot.band : "";
    return {
      band,
      name: typeof slot.text === "string" ? slot.text : "",
      frequency: (band === "fm" || band === "am") && typeof slot.number === "number" ? slot.number : 0,
    };
  });
}

/**
 * The linked devices of a MusicCast Link server (`client_list` of getDistributionInfo) as slot entries.
 *
 * @param info the getDistributionInfo response
 * @returns the entries by slot, undefined when the response carries no list
 */
export function clientSlotEntries(info: unknown): SlotEntry[] | undefined {
  const list = (info as { client_list?: unknown } | null)?.client_list;
  if (!Array.isArray(list)) {
    return undefined;
  }
  // The specification's form is `{ ip_address, data_type }`; a bare address is taken too, as the
  // roster reader (`distributionSummary`) does.
  return list.map(entry => {
    const ip = typeof entry === "string" ? entry : (entry as { ip_address?: unknown } | null)?.ip_address;
    return typeof ip === "string" ? { ip } : undefined;
  });
}

/**
 * The play queue's length and position (`max_line`, `playing_index` of getPlayQueue) as their own
 * datapoints: the JSON list holds only the first eight entries while the queue may declare 200
 * (audit 2026-09-29, C30). Position counts from 1; 0 while nothing plays.
 *
 * @param info the getPlayQueue response
 * @returns the two values, empty when malformed
 */
export function playQueueCounters(info: unknown): StateValue[] {
  if (typeof info !== "object" || info === null) {
    return [];
  }
  const q = info as { playing_index?: unknown; max_line?: unknown };
  const updates: StateValue[] = [];
  if (typeof q.max_line === "number") {
    updates.push({ id: "player.netPlayer.queueLength", value: q.max_line });
  }
  if (typeof q.playing_index === "number") {
    updates.push({ id: "player.netPlayer.queuePosition", value: q.playing_index >= 0 ? q.playing_index + 1 : 0 });
  }
  return updates;
}
