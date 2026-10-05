import { MEDIA_STATE, MEDIA_STATE_LABELS } from "./media-state";
import type { ObjectDef } from "./types";
import type { I18nKey } from "../i18n";
import type { StateValue } from "../types";

/** A player-block state as its catalog carries it: the common with name/explanation KEYS. */
export interface PlayerBlockState {
  /** The id below the player channel. */
  state: string;
  /** The common, with `nameKey`/`descKey` resolved by the builder (`keyedCommon`). */
  common: Omit<ObjectDef["common"], "name"> & { nameKey: I18nKey; descKey?: I18nKey };
}

/**
 * The display states of a zone's "now playing" block — what is playing, from which source, in which
 * mode, with which cover. ONE list for the transports that build the block from a table (MusicCast and
 * XML), so the same id has the same shape whichever owns it (the XML block came with audit 2026-09-29,
 * D3; YNCA builds its block from its own catalog, which the coordinator matches).
 */
export const PLAYER_DISPLAY_STATES: readonly PlayerBlockState[] = [
  {
    // What the zone is playing (the netusb source name, or `cd`) — read-only display;
    // switching happens over the zone's `input` state.
    state: "source",
    common: {
      nameKey: "playingSource",
      descKey: "descPlayingSource",
      type: "string",
      role: "text",
      read: true,
      write: false,
    },
  },
  {
    state: "playback",
    common: {
      // media.state is a number in the type-detector; the role catalog's coding, shared with the YNCA
      // player (catalog/media-state.ts).
      nameKey: "playback",
      type: "number",
      role: "media.state",
      read: true,
      write: false,
      states: MEDIA_STATE_LABELS,
    },
  },
  { state: "artist", common: { nameKey: "artist", type: "string", role: "media.artist", read: true, write: false } },
  { state: "album", common: { nameKey: "album", type: "string", role: "media.album", read: true, write: false } },
  { state: "track", common: { nameKey: "track", type: "string", role: "media.title", read: true, write: false } },
  // Read-only playback metadata, typed exactly like the YNCA sources so both players
  // present the same shape on one device: repeat as the media.mode.repeat number code
  // (wire off/one/all, captures-verified), shuffle as a media.mode.shuffle boolean
  // (wire knows only off/on). Writable where the device takes setRepeat/setShuffle (API 1.19+,
  // `pushPlayerBlock`); below that the toggle buttons are the way.
  {
    state: "repeat",
    common: {
      nameKey: "repeat",
      type: "number",
      role: "media.mode.repeat",
      read: true,
      write: false,
      states: { 0: "Off", 1: "Single", 2: "All" },
    },
  },
  {
    state: "shuffle",
    common: { nameKey: "shuffle", type: "boolean", role: "media.mode.shuffle", read: true, write: false },
  },
  // Both forms of each time, from the one value the device reports: the seconds fill the
  // type detector's media-player slot (it takes nothing else), the text is what a
  // visualisation shows. The YNCA side publishes exactly the same pair, converted the other
  // way round — so the datapoints mean the same thing on every device.
  {
    state: "elapsedTime",
    common: {
      nameKey: "elapsedTime",
      descKey: "descElapsedTime",
      type: "number",
      unit: "s",
      role: "media.elapsed",
      read: true,
      write: false,
    },
  },
  {
    state: "elapsedTimeText",
    common: {
      nameKey: "elapsedTimeReadable",
      descKey: "descElapsedTimeReadable",
      type: "string",
      role: "media.elapsed.text",
      read: true,
      write: false,
    },
  },
  {
    state: "totalTime",
    common: {
      nameKey: "totalTime",
      descKey: "descTotalTime",
      type: "number",
      unit: "s",
      role: "media.duration",
      read: true,
      write: false,
    },
  },
  {
    state: "totalTimeText",
    common: {
      nameKey: "totalTimeReadable",
      descKey: "descTotalTimeReadable",
      type: "string",
      role: "media.duration.text",
      read: true,
      write: false,
    },
  },
  {
    state: "albumArt",
    common: {
      nameKey: "albumArt",
      descKey: "descAlbumArt",
      type: "string",
      role: "media.cover",
      read: true,
      write: false,
    },
  },
];

/** The station a radio source names — YNCA's and XML's `player.station`; MusicCast reports none. */
export const PLAYER_STATION_STATE: PlayerBlockState = {
  state: "station",
  common: { nameKey: "station", type: "string", role: "text", read: true, write: false },
};

/**
 * What a zone's player block shows once the zone left its media source: no metadata, times zero, playback Stop —
 * ONE table for all three transports, each writing only the states it built. It stood three times and had drifted
 * (YNCA left the cover standing, MusicCast the station and channel, XML the play times), so the same zone switch
 * left a different block behind depending on the protocol (review 2026-10-05, D3).
 */
export const PLAYER_CLEAR: readonly StateValue[] = [
  { id: "player.source", value: "" },
  { id: "player.playback", value: MEDIA_STATE.stop },
  { id: "player.artist", value: "" },
  { id: "player.album", value: "" },
  { id: "player.track", value: "" },
  { id: "player.station", value: "" },
  { id: "player.channelName", value: "" },
  { id: "player.albumArt", value: "" },
  { id: "player.elapsedTime", value: 0 },
  { id: "player.elapsedTimeText", value: "" },
  { id: "player.totalTime", value: 0 },
  { id: "player.totalTimeText", value: "" },
  { id: "player.repeat", value: 0 },
  { id: "player.shuffle", value: false },
];
