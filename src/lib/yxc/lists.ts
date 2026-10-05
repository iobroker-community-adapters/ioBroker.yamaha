import type { StateValue } from "../types";
import type { SlotField } from "../catalog/list-slots";
import { musicCastInputName } from "../catalog/musiccast-vocabulary";

/**
 * The device's lists: the favourites, the recently played, the stored stations, the MusicCast playlists, the play queue
 * and a group's linked devices — each as its JSON state and as slot entries (`catalog/list-slots.ts`). Split out of the
 * command mapper, which did five jobs (review 2026-10-05, SOLID).
 *
 * Each list is read ONCE into its entries by slot (`undefined` = an empty slot), and the JSON state and the slot
 * datapoints both come from that read. They were parsed two or three times with rules that had drifted apart: the
 * recently-played JSON kept an entry of input `unknown` that its slots called empty, the playlist JSON listed a name ""
 * its slots showed as an entry, a linked device without an address was a slot but no roster member (review
 * 2026-10-05, DRY). One rule now: an entry without a name (or an address) is an empty slot everywhere.
 */

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
 * A field of a raw list entry, whatever the entry is.
 *
 * @param entry the raw entry
 * @returns its fields, empty for a non-object
 */
function fieldsOf(entry: unknown): Record<string, unknown> {
  return typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
}

/**
 * A text that names something: a non-blank string, as the device sent it.
 *
 * @param value the raw value
 * @returns the text, or undefined for a blank or non-text value
 */
function named(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** One favourite or recently-played entry as the device reports it. */
interface NetusbEntry {
  /** The source it plays (MusicCast input id). */
  input: string;
  /** Its name. */
  name: string;
  /** The cover's address, where the device reports one. */
  albumArt?: string;
  /** How often it was played (the recent list). */
  playCount?: number;
}

/**
 * A netusb list (`preset_info` of getPresetInfo, `recent_info` of getRecentInfo), read once: a slot is empty when its
 * source is `unknown` or it has no name.
 *
 * @param list the raw list
 * @param cover turns a reported cover path into the address to show
 * @returns the entries by slot, undefined when the list is malformed
 */
function netusbEntries(
  list: unknown,
  cover: (url: string) => string = url => url,
): Array<NetusbEntry | undefined> | undefined {
  if (!Array.isArray(list)) {
    return undefined;
  }
  return list.map(raw => {
    const entry = fieldsOf(raw);
    const name = named(entry.text);
    if (typeof entry.input !== "string" || entry.input === "unknown" || name === undefined) {
      return undefined;
    }
    const art = typeof entry.albumart_url === "string" ? cover(entry.albumart_url) : "";
    return {
      input: entry.input,
      name,
      ...(art.length > 0 ? { albumArt: art } : {}),
      ...(typeof entry.play_count === "number" ? { playCount: entry.play_count } : {}),
    };
  });
}

/**
 * The stored entries of a list with their 1-based slot numbers — the JSON form of every list.
 *
 * @param entries the entries by slot
 * @returns the stored ones, numbered
 */
function numbered<T extends object>(entries: ReadonlyArray<T | undefined>): Array<{ num: number } & T> {
  return entries.flatMap((entry, index) => (entry ? [{ num: index + 1, ...entry }] : []));
}

/**
 * Parse a `/netusb/getPresetInfo` response into the favourites JSON state: the stored slots with their names, empty
 * slots skipped.
 *
 * @param info the getPresetInfo response object
 * @returns the state update, or undefined if the response is malformed
 */
export function parseYxcPresetList(info: unknown): StateValue | undefined {
  const entries = netusbEntries(fieldsOf(info).preset_info);
  return (
    entries && {
      id: "player.netPlayer.presets",
      value: JSON.stringify(numbered(entries).map(({ num, input, name }) => ({ num, input, name }))),
    }
  );
}

/**
 * Parse a `/netusb/getRecentInfo` response into the recently-played JSON state.
 *
 * @param info the getRecentInfo response object
 * @param cover turns a reported cover path into the address to show (see `absoluteDeviceUrl`)
 * @returns the state update, or undefined if the response is malformed
 */
export function parseYxcRecentList(info: unknown, cover: (url: string) => string = url => url): StateValue | undefined {
  const entries = netusbEntries(fieldsOf(info).recent_info, cover);
  return entries && { id: "player.netPlayer.recent", value: JSON.stringify(numbered(entries)) };
}

/**
 * A netusb list (`preset_info` of getPresetInfo, `recent_info` of getRecentInfo) as slot entries: name and source,
 * the source by the name it is shown with.
 *
 * @param list the raw list
 * @returns the entries by slot, undefined when the list is malformed
 */
export function netusbSlotEntries(list: unknown): SlotEntry[] | undefined {
  return netusbEntries(list)?.map(entry => entry && { name: entry.name, input: musicCastInputName(entry.input) });
}

/**
 * Whether a tuner preset slot holds nothing. The device marks an unused slot with the band `unknown`,
 * frequency/service number 0 and empty text — a slot counts as empty only when none of the three carries anything,
 * so a firmware that fills only some of them is kept.
 *
 * @param slot one raw preset_info entry
 * @returns true when the slot is unused
 */
function isEmptyTunerPreset(slot: Record<string, unknown>): boolean {
  const band = slot.band;
  const hasBand = typeof band === "string" && band.length > 0 && band !== "unknown";
  const hasNumber = typeof slot.number === "number" && slot.number !== 0;
  return !hasBand && !hasNumber && named(slot.text) === undefined;
}

/**
 * One band's stored stations (`preset_info` of `/tuner/getPresetInfo`), read once: the raw slot, kept for the JSON
 * (its shape varies per band and firmware), or undefined for an unused one.
 *
 * @param info the getPresetInfo response of one band
 * @returns the slots, undefined when malformed
 */
function stationSlots(info: unknown): Array<Record<string, unknown> | undefined> | undefined {
  const list = fieldsOf(info).preset_info;
  return Array.isArray(list)
    ? list.map(raw => {
        const slot = fieldsOf(raw);
        return typeof raw === "object" && raw !== null && !isEmptyTunerPreset(slot) ? slot : undefined;
      })
    : undefined;
}

/**
 * Parse `/tuner/getPresetInfo` responses (one per fetched band) into the tuner presets JSON state: an object keyed by
 * band, each STORED slot kept in its raw response form plus its 1-based slot number.
 *
 * The device answers with its full slot count whether or not anything is stored — on a receiver with no tuner presets
 * that is 40 FM plus 40 DAB entries of `{band:"unknown", number:0, text:""}`, a JSON datapoint nobody can use. Empty
 * slots are dropped the same way the favourites list drops them.
 *
 * @param byBand each fetched band's getPresetInfo response object
 * @returns the state update, or undefined when no band delivered a list
 */
export function parseYxcTunerPresetLists(byBand: Record<string, unknown>): StateValue | undefined {
  const result: Record<string, unknown[]> = {};
  for (const [band, info] of Object.entries(byBand)) {
    const slots = stationSlots(info);
    if (slots) {
      result[band] = numbered(slots);
    }
  }
  return Object.keys(result).length > 0 ? { id: "tuner.presets", value: JSON.stringify(result) } : undefined;
}

/**
 * One band's stored stations as slot entries. `number` is the frequency in kHz on AM/FM and a service id on DAB
 * (Basic §6.1) — only the frequency becomes one.
 *
 * @param info the getPresetInfo response of one band
 * @returns the entries by slot, undefined when malformed
 */
export function stationSlotEntries(info: unknown): SlotEntry[] | undefined {
  return stationSlots(info)?.map(slot => {
    if (!slot) {
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
 * The MusicCast playlist names (`name_list` of getMcPlaylistName), read once: a slot without a name is empty.
 *
 * @param info the getMcPlaylistName response
 * @returns the entries by slot, undefined when malformed
 */
export function playlistSlotEntries(info: unknown): SlotEntry[] | undefined {
  const names = fieldsOf(info).name_list;
  return Array.isArray(names)
    ? names.map(raw => {
        const name = named(raw);
        return name === undefined ? undefined : { name };
      })
    : undefined;
}

/**
 * Parse a `/netusb/getMcPlaylistName` response into the playlists JSON state.
 *
 * @param info the getMcPlaylistName response object
 * @returns the state update, or undefined if the response is malformed
 */
export function parseYxcPlaylistNames(info: unknown): StateValue | undefined {
  const entries = playlistSlotEntries(info);
  return entries && { id: "player.netPlayer.playlists", value: JSON.stringify(numbered(entries)) };
}

/** The play queue as the device reports it (getPlayQueue: `track_info`, `playing_index`, `max_line`). */
interface Queue {
  /** The tracks as reported (the JSON keeps them). */
  tracks: unknown[];
  /** The 0-based playing position, -1 while nothing plays. */
  playingIndex?: number;
  /** The queue's length. */
  maxLine?: number;
}

/**
 * The play queue, read once. The spec leaves it "Reserved"; its answer has the list form of getMcPlaylist (`index`,
 * `max_line`, `track_info`), whose entries carry `text`, `input`, `thumbnail` and `attribute` (Grenton's MusicCast
 * knowledge base).
 *
 * @param info the getPlayQueue response
 * @returns the queue, undefined when malformed
 */
function queueOf(info: unknown): Queue | undefined {
  const q = fieldsOf(info);
  if (!Array.isArray(q.track_info)) {
    return undefined;
  }
  return {
    tracks: q.track_info,
    ...(typeof q.playing_index === "number" ? { playingIndex: q.playing_index } : {}),
    ...(typeof q.max_line === "number" ? { maxLine: q.max_line } : {}),
  };
}

/**
 * Parse a `/netusb/getPlayQueue` response into the play-queue JSON state (capture-verified shape: `track_info` plus
 * `playing_index`).
 *
 * @param info the getPlayQueue response object
 * @returns the state update, or undefined if the response is malformed
 */
export function parseYxcPlayQueue(info: unknown): StateValue | undefined {
  const queue = queueOf(info);
  return (
    queue && {
      id: "player.netPlayer.queue",
      value: JSON.stringify({
        playingIndex: queue.playingIndex ?? -1,
        totalTracks: queue.maxLine ?? queue.tracks.length,
        tracks: queue.tracks,
      }),
    }
  );
}

/**
 * The play queue's tracks as slot entries: the name each track is shown with; a track without one is an empty slot.
 *
 * @param info the getPlayQueue response
 * @returns the entries by slot, undefined when malformed
 */
export function playQueueSlotEntries(info: unknown): SlotEntry[] | undefined {
  return queueOf(info)?.tracks.map(track => {
    const name = named(fieldsOf(track).text);
    return name === undefined ? undefined : { name };
  });
}

/**
 * The play queue's length and position (`max_line`, `playing_index` of getPlayQueue) as their own datapoints: the JSON
 * list holds only the first eight entries while the queue may declare 200 (audit 2026-09-29, C30). Position counts
 * from 1; 0 while nothing plays.
 *
 * @param info the getPlayQueue response
 * @returns the two values, empty when malformed
 */
export function playQueueCounters(info: unknown): StateValue[] {
  const q = fieldsOf(info);
  const updates: StateValue[] = [];
  if (typeof q.max_line === "number") {
    updates.push({ id: "player.netPlayer.queueLength", value: q.max_line });
  }
  if (typeof q.playing_index === "number") {
    updates.push({ id: "player.netPlayer.queuePosition", value: q.playing_index >= 0 ? q.playing_index + 1 : 0 });
  }
  return updates;
}

/**
 * A group's linked devices (`client_list` of getDistributionInfo), read once: their addresses by slot. The
 * specification's form is `{ ip_address, data_type }` (Advanced §5.1); a bare address is taken too. The roster of
 * the group summary and the slot datapoints read this one list.
 *
 * @param info the getDistributionInfo response
 * @returns the addresses by slot (undefined = an entry without one), undefined when the response carries no list
 */
export function clientAddresses(info: unknown): Array<string | undefined> | undefined {
  const list = fieldsOf(info).client_list;
  return Array.isArray(list)
    ? list.map(entry => named(typeof entry === "string" ? entry : fieldsOf(entry).ip_address))
    : undefined;
}

/**
 * The linked devices of a MusicCast Link server as slot entries.
 *
 * @param info the getDistributionInfo response
 * @returns the entries by slot, undefined when the response carries no list
 */
export function clientSlotEntries(info: unknown): SlotEntry[] | undefined {
  return clientAddresses(info)?.map(ip => (ip === undefined ? undefined : { ip }));
}
