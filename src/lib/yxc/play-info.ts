import { MEDIA_STATE } from "../catalog/media-state";
import type { StateValue } from "../types";
import type { I18nKey } from "../i18n";
import { formatPlayTime } from "../catalog/play-time";
import { musicCastInputName } from "../catalog/musiccast-vocabulary";
import { withAlbumArtId } from "../catalog/device-url";

/**
 * What a media source is playing: the network player's and the CD's getPlayInfo (the unified player block) and the
 * tuner's (band, frequency, RDS, DAB). Parsers only — split out of the command mapper, which did five jobs (review
 * 2026-10-05, SOLID).
 */

/** The play time YXC reports when there is none (YXC Basic §7.2: "-60000 (invalid)"). */
const INVALID_PLAY_TIME = -60000;

/**
 * Leaves a reported address as it is — for a caller that has no device to resolve it against.
 *
 * @param url the reported address
 * @returns the same address
 */
const asReported = (url: string): string => url;

/**
 * Parse a YXC getPlayInfo response into a player's read-only state updates
 * (playback status plus artist/album/track metadata). The same response shape is
 * used by every player source; the updates target the unified flat `player.*` block
 * (v2.0.0) — the CONTROLLER routes them to the zones listening to the source and
 * keeps the drive-own `player.cd.*` extras device-global.
 *
 * @param playInfo the getPlayInfo response object
 * @param block the source the info came from (`netusb` or `cd`)
 * @param cover turns the reported cover path into the address to show (see {@link absoluteDeviceUrl})
 * @returns the player state updates, empty if malformed
 */
export function parseYxcPlayInfo(
  playInfo: unknown,
  block: "netusb" | "cd" = "netusb",
  cover: (url: string) => string = asReported,
): StateValue[] {
  if (typeof playInfo !== "object" || playInfo === null) {
    return [];
  }
  const info = playInfo as Record<string, unknown>;
  const updates: StateValue[] = [];
  // String metadata whose field name doubles as the state id (playback is coded separately).
  for (const field of ["artist", "album", "track"]) {
    const value = info[field];
    if (typeof value === "string") {
      updates.push({ id: `player.${field}`, value });
    }
  }
  // Repeat/shuffle carry the same typed form as the YNCA sources: repeat as the
  // media.mode.repeat code, shuffle as a boolean. The specification's words (YXC Basic §7.2
  // netusb, §8.1 cd): repeat off/one/all, on a CD also folder (= all of it) and a-b (a stretch
  // played again = one); shuffle off/on/songs/albums, on a CD folder/program — every one but
  // "off" shuffles (audit 2026-09-24, C14). A word outside them is skipped, never coerced.
  const repeatCode: Record<string, number> = { off: 0, one: 1, all: 2, folder: 2, "a-b": 1 };
  if (typeof info.repeat === "string" && info.repeat in repeatCode) {
    updates.push({ id: "player.repeat", value: repeatCode[info.repeat] });
  }
  if (
    typeof info.shuffle === "string" &&
    ["off", "on", "songs", "albums", "folder", "program"].includes(info.shuffle)
  ) {
    updates.push({ id: "player.shuffle", value: info.shuffle !== "off" });
  }
  // Playback status → media.state code (the role catalog's, shared with the YNCA player); winding
  // forward or back is still playing.
  const playbackCode: Record<string, number> = {
    play: MEDIA_STATE.play,
    stop: MEDIA_STATE.stop,
    pause: MEDIA_STATE.pause,
    fast_reverse: MEDIA_STATE.play,
    fast_forward: MEDIA_STATE.play,
  };
  if (typeof info.playback === "string" && info.playback in playbackCode) {
    updates.push({ id: "player.playback", value: playbackCode[info.playback] });
  }
  // Album art URL and the elapsed/total play time (renamed from the YXC field names).
  const albumArt = info.albumart_url;
  if (typeof albumArt === "string") {
    updates.push({ id: "player.albumArt", value: withAlbumArtId(cover(albumArt), info.albumart_id) });
  }
  // Both forms of each time — see catalog/play-time.ts. MusicCast reports the seconds, so
  // the readable text is formatted from them here; the YNCA side parses its text into the
  // same seconds. One meaning per datapoint, on every device.
  // -60000 is the specification's "invalid" (YXC Basic §7.2) — no time, like total_time 0; every
  // other negative value is a valid time before the start (audit 2026-09-24, C11).
  const elapsed = info.play_time;
  if (elapsed === INVALID_PLAY_TIME) {
    updates.push({ id: "player.elapsedTime", value: 0 });
    updates.push({ id: "player.elapsedTimeText", value: "" });
  } else if (typeof elapsed === "number") {
    updates.push({ id: "player.elapsedTime", value: elapsed });
    updates.push({ id: "player.elapsedTimeText", value: formatPlayTime(elapsed) });
  }
  const total = info.total_time;
  if (typeof total === "number") {
    updates.push({ id: "player.totalTime", value: total });
    updates.push({ id: "player.totalTimeText", value: formatPlayTime(total) });
  }
  // The playing source: netusb reports its active input ("spotify", "net_radio", …);
  // the CD block IS its source.
  if (block === "cd") {
    updates.push({ id: "player.source", value: musicCastInputName("cd") });
  } else if (typeof info.input === "string") {
    updates.push({ id: "player.source", value: musicCastInputName(info.input) });
  }
  // CD drive-own extras (presence-checked, netusb responses carry none of these fields).
  if (typeof info.track_number === "number") {
    updates.push({ id: "player.cd.trackNumber", value: Math.max(0, info.track_number) });
  }
  if (typeof info.total_tracks === "number") {
    updates.push({ id: "player.cd.totalTracks", value: info.total_tracks });
  }
  if (typeof info.disc_time === "number") {
    updates.push({ id: "player.cd.discTime", value: info.disc_time });
  }
  if (typeof info.device_status === "string") {
    updates.push({ id: "player.cd.deviceStatus", value: info.device_status });
  }
  return updates;
}

/**
 * The DAB block's fields → their unified state ids (aligned with the YNCA DAB ids so
 * both transports feed one node), with the object name each state is created under.
 * Single source for the object mapper (creation) and the parser below (read-back).
 */
export const DAB_FIELDS: Array<{
  field: string;
  id: string;
  type: "string" | "number" | "boolean";
  /** Object name as its translation KEY — this table is a module-level constant. */
  nameKey: I18nKey;
  /** Explanation key — absent means self-explanatory. */
  descKey?: I18nKey;
  /** The unit and bounds YXC Basic §6.2 declares for the field. */
  unit?: string;
  min?: number;
  max?: number;
  /** The tuner function (`func_list`) the field needs as proof — §6.2 "Available only when …". */
  requires?: string;
  /** A role more specific than the type's default (`media.bitrate` — audit 2026-09-29, C41). */
  role?: string;
  /** Every value §6.2 declares for a word field — its list, labelled where the object is written. */
  states?: readonly string[];
}> = [
  {
    field: "service_label",
    id: "tuner.dab.serviceLabel",
    type: "string",
    nameKey: "serviceLabel",
    descKey: "descDabService",
  },
  {
    field: "ensemble_label",
    id: "tuner.dab.ensembleLabel",
    type: "string",
    nameKey: "ensembleLabel",
    descKey: "descDabEnsemble",
  },
  {
    field: "ch_label",
    id: "tuner.dab.channelLabel",
    type: "string",
    nameKey: "channelLabel",
    descKey: "descDabChannel",
  },
  { field: "dls", id: "tuner.dab.dls", type: "string", nameKey: "dlsText", descKey: "descDabDLSText" },
  {
    field: "program_type",
    id: "tuner.dab.programType",
    type: "string",
    nameKey: "programmeType",
    descKey: "descDabProgramType",
  },
  // preset and audio_mode are NOT listed here: the active-band parse feeds the
  // unified flat tuner.preset / tuner.audioMode states (v2.0.0).
  {
    field: "status",
    id: "tuner.dab.status",
    type: "string",
    nameKey: "dabStatus",
    descKey: "descDabStatus",
    role: "state",
    states: ["not_ready", "initial_scan", "tune_aid", "ready"],
  },
  {
    field: "bit_rate",
    id: "tuner.dab.bitRate",
    type: "number",
    nameKey: "bitRate",
    descKey: "descBitRate",
    unit: "kbps",
    // 32–256 for a received service (YXC Basic, getDabInfo); the device reports 0 while none is received
    // (RX-V6A capture) — the range takes the device's own word, or every idle poll warns.
    min: 0,
    max: 256,
    role: "media.bitrate",
  },
  {
    field: "quality",
    id: "tuner.dab.quality",
    type: "number",
    nameKey: "signalQuality",
    descKey: "descSignalQuality",
    min: 0,
    max: 100,
  },
  { field: "off_air", id: "tuner.dab.offAir", type: "boolean", nameKey: "offAir", descKey: "descOffAir" },
  { field: "dab_plus", id: "tuner.dab.dabPlus", type: "boolean", nameKey: "dabPlus", descKey: "descDabPlus" },
  {
    field: "category",
    id: "tuner.dab.category",
    type: "string",
    nameKey: "serviceCategory",
    descKey: "descServiceCategory",
    role: "state",
    states: ["primary", "secondary"],
  },
  {
    field: "total_station_num",
    id: "tuner.dab.totalStations",
    type: "number",
    nameKey: "totalStations",
    descKey: "descTotalStations",
    min: 0,
    max: 255,
    requires: "dab_initial_scan",
  },
  {
    field: "initial_scan_progress",
    id: "tuner.dab.scanProgress",
    type: "number",
    nameKey: "initialScanProgress",
    descKey: "descInitialScanProgress",
    unit: "%",
    min: 0,
    max: 100,
    requires: "dab_initial_scan",
  },
  {
    field: "tune_aid",
    id: "tuner.dab.tuneAid",
    type: "number",
    nameKey: "tuneAidLevel",
    descKey: "descTuneAidLevel",
    min: 0,
    max: 100,
  },
];

/**
 * Parse a YXC `/tuner/getPlayInfo` response into the tuner's read-only states: the
 * current band with its frequency/preset/tuned/audio mode, the RDS block, and the
 * DAB details (on the YNCA-shared `tuner.dab.*` ids). Absent fields are skipped.
 *
 * @param tunerInfo the getPlayInfo("tuner") response object
 * @returns the tuner state updates, empty if malformed
 */
export function parseYxcTunerInfo(tunerInfo: unknown): StateValue[] {
  if (typeof tunerInfo !== "object" || tunerInfo === null) {
    return [];
  }
  const info = tunerInfo as Record<string, unknown>;
  const updates: StateValue[] = [];
  const band = info.band;
  if (typeof band === "string") {
    updates.push({ id: "tuner.band", value: band });
    const bandInfo = info[band];
    if (typeof bandInfo === "object" && bandInfo !== null) {
      const current = bandInfo as Record<string, unknown>;
      if (typeof current.freq === "number") {
        updates.push({ id: "tuner.frequency", value: current.freq });
      }
      // The active band's preset slot, tuned flag and audio mode — consolidated onto
      // the flat tuner states (the band state says which band they describe).
      if (typeof current.preset === "number") {
        updates.push({ id: "tuner.preset", value: current.preset });
      }
      // A field the active band does not carry is not the old band's any more (YXC Basic §6.2: `am` has
      // no `audio_mode`, `dab` no `tuned` but a `status`) — until 3.0.1 the FM values stood on after a
      // switch to AM or DAB (audit 2026-09-29, C39).
      updates.push({
        id: "tuner.tuned",
        value: typeof current.tuned === "boolean" ? current.tuned : band === "dab" ? current.status === "ready" : false,
      });
      updates.push({
        id: "tuner.audioMode",
        value: typeof current.audio_mode === "string" ? current.audio_mode : null,
      });
    }
  }
  const rds = info.rds;
  if ((typeof rds !== "object" || rds === null) && typeof band === "string") {
    // §6.2: `rds` "Available only when RDS is valid" — gone with the FM station, so is its text.
    for (const id of ["tuner.rdsText", "tuner.rdsTextB", "tuner.rdsService", "tuner.rdsProgramType"]) {
      updates.push({ id, value: "" });
    }
  }
  if (typeof rds === "object" && rds !== null) {
    const r = rds as Record<string, unknown>;
    if (typeof r.radio_text_a === "string") {
      updates.push({ id: "tuner.rdsText", value: r.radio_text_a });
    }
    if (typeof r.radio_text_b === "string") {
      updates.push({ id: "tuner.rdsTextB", value: r.radio_text_b });
    }
    if (typeof r.program_service === "string") {
      updates.push({ id: "tuner.rdsService", value: r.program_service });
    }
    if (typeof r.program_type === "string") {
      updates.push({ id: "tuner.rdsProgramType", value: r.program_type });
    }
  }
  // The DAB block is reported alongside the band blocks (capture-verified) and feeds
  // the same tuner.dab.* ids as the YNCA DAB subunit, so both transports share one node.
  const dab = info.dab;
  if (typeof dab === "object" && dab !== null) {
    const d = dab as Record<string, unknown>;
    for (const { field, id, type } of DAB_FIELDS) {
      const value = d[field];
      if (typeof value === type) {
        updates.push({ id, value: value as string | number | boolean });
      }
    }
  }
  return updates;
}
