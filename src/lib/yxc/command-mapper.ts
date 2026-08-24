import type { StateValue } from "../types";
import { isWritableValue } from "../catalog/value-coerce";
import { YXC_AMP_CATALOG } from "./catalog";
import type { YxcClientLike } from "./client-contract";

/**
 * A mapped YXC write. Almost every command is a ready-to-run client call (`run`) built
 * from the catalog's `write.apply` or the transport/toggle tables — no method-name
 * string, no dispatch switch, no "unknown command" runtime path. The two commands that
 * need controller-cached state stay declarative: the equalizer (the device sets all
 * three bands in one call, the other two come from the cached status) and the tuner
 * frequency (setFreq needs the current band).
 */
export type YxcCommand =
  | { kind: "run"; run: (client: YxcClientLike) => Promise<unknown> }
  | { kind: "equalizer"; zone: string; band: "low" | "mid" | "high"; value: number }
  | { kind: "tunerFreq"; value: number }
  | { kind: "tunerPreset"; value: number };

/**
 * Read a catalog entry's raw getStatus value — a flat field or a nested path.
 *
 * @param status the getStatus response object
 * @param read the entry's read location
 * @returns the raw value, or undefined if the field is absent
 */
function readStatusField(status: Record<string, unknown>, read: { field: string } | { path: string[] }): unknown {
  if ("path" in read) {
    let value: unknown = status;
    for (const key of read.path) {
      if (typeof value !== "object" || value === null) {
        return undefined;
      }
      value = (value as Record<string, unknown>)[key];
    }
    return value;
  }
  return status[read.field];
}

/**
 * Button states → their client call. The CD transport routes through the one
 * `setCDPlayback(action)` method (not the per-action `pauseCD()` helpers, one of
 * which sends the wrong command in the library).
 */
const BUTTON_ACTIONS: Record<string, (client: YxcClientLike) => Promise<unknown>> = {
  "player.netPlayer.play": client => client.playNet(),
  "player.netPlayer.pause": client => client.pauseNet(),
  "player.netPlayer.stop": client => client.stopNet(),
  "player.netPlayer.next": client => client.nextNet(),
  "player.netPlayer.prev": client => client.prevNet(),
  "player.cd.play": client => client.setCDPlayback("play"),
  "player.cd.pause": client => client.setCDPlayback("pause"),
  "player.cd.stop": client => client.setCDPlayback("stop"),
  "player.cd.next": client => client.setCDPlayback("next"),
  "player.cd.prev": client => client.setCDPlayback("previous"),
  "player.netPlayer.repeatToggle": client => client.toggleNetRepeat(),
  "player.netPlayer.shuffleToggle": client => client.toggleNetShuffle(),
  "player.cd.repeatToggle": client => client.toggleCDRepeat(),
  "player.cd.shuffleToggle": client => client.toggleCDShuffle(),
  "player.cd.tray": client => client.toggleTray(),
};

/** Equalizer band state (without zone prefix) → the band of the declarative equalizer command. */
const EQ_CHANNELS: Record<string, "low" | "mid" | "high"> = {
  "sound.equalizerLow": "low",
  "sound.equalizerMid": "mid",
  "sound.equalizerHigh": "high",
};

const ZONE_PREFIX: Record<string, string> = {
  main: "",
  zone2: "multiroom.zone2.",
  zone3: "multiroom.zone3.",
  zone4: "multiroom.zone4.",
};

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
  const prefix = ZONE_PREFIX[zone];
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
 * Map a unified state write to a YXC amplifier command.
 *
 * @param stateId the state id (e.g. `power`, `zone2.volume`)
 * @param value the value written to the state
 * @returns the YXC command, or undefined if the state or its zone is not mapped
 */
export function stateToYxc(stateId: string, value: unknown): YxcCommand | undefined {
  const button = BUTTON_ACTIONS[stateId];
  if (button) {
    return { kind: "run", run: button };
  }
  if (stateId === "tuner.band" && isWritableValue(value, false)) {
    const band = String(value);
    return { kind: "run", run: client => client.setBand(band) };
  }
  if (stateId === "tuner.frequency" && isWritableValue(value, true)) {
    // The controller supplies the current band; the value carries only the frequency.
    return { kind: "tunerFreq", value: Number(value) };
  }
  if (stateId === "player.netPlayer.preset" && isWritableValue(value, true)) {
    const preset = Number(value);
    return { kind: "run", run: client => client.recallPreset(preset, "main") };
  }
  if (stateId === "player.netPlayer.recallRecent" && isWritableValue(value, true)) {
    const num = Number(value);
    return { kind: "run", run: client => client.recallRecentItem(num, "main") };
  }
  if (stateId === "tuner.preset" && isWritableValue(value, true)) {
    // The controller supplies the band (or `common` on shared-list devices).
    return { kind: "tunerPreset", value: Number(value) };
  }
  if (stateId === "tuner.presetUp") {
    return { kind: "run", run: client => client.switchTunerPreset("next") };
  }
  if (stateId === "tuner.presetDown") {
    return { kind: "run", run: client => client.switchTunerPreset("previous") };
  }
  let zone = "main";
  let name = stateId;
  const zoneMatch = /^multiroom\.(zone[234])\.(.+)$/.exec(stateId);
  if (zoneMatch) {
    zone = zoneMatch[1];
    name = zoneMatch[2];
  }
  const eqBand = EQ_CHANNELS[name];
  if (eqBand && isWritableValue(value, true)) {
    // The controller supplies the other two bands; the value carries only this band.
    return { kind: "equalizer", zone, band: eqBand, value: Number(value) };
  }
  const entry = YXC_AMP_CATALOG.find(e => e.state === name);
  if (!entry?.write || !isWritableValue(value, entry.common.type === "number")) {
    return undefined;
  }
  const { apply } = entry.write;
  return { kind: "run", run: client => apply(client, value, zone) };
}

/**
 * Parse a getDistributionInfo response into the read-only multiroom (dist) states.
 *
 * @param info the getDistributionInfo response object
 * @returns the dist state updates, or an empty list if malformed
 */
export function parseYxcDistribution(info: unknown): StateValue[] {
  if (typeof info !== "object" || info === null) {
    return [];
  }
  const d = info as Record<string, unknown>;
  const updates: StateValue[] = [];
  if (typeof d.role === "string") {
    updates.push({ id: "multiroom.group.role", value: d.role });
  }
  if (typeof d.group_id === "string") {
    updates.push({ id: "multiroom.group.id", value: d.group_id });
  }
  if (typeof d.group_name === "string") {
    updates.push({ id: "multiroom.group.name", value: d.group_name });
  }
  if (typeof d.server_zone === "string") {
    updates.push({ id: "multiroom.group.serverZone", value: d.server_zone });
  }
  if (Array.isArray(d.client_list)) {
    updates.push({ id: "multiroom.group.linkedDevices", value: JSON.stringify(d.client_list) });
  }
  return updates;
}

/**
 * Parse a YXC getPlayInfo response into a player's read-only state updates
 * (playback status plus artist/album/track metadata). The same response shape is
 * used by every player source, so the target channel is chosen via `prefix`.
 *
 * @param playInfo the getPlayInfo response object
 * @param prefix the target player channel (`netPlayer` for netusb, `cd` for the disc player)
 * @returns the player state updates, empty if malformed
 */
export function parseYxcPlayInfo(playInfo: unknown, prefix = "player.netPlayer"): StateValue[] {
  if (typeof playInfo !== "object" || playInfo === null) {
    return [];
  }
  const info = playInfo as Record<string, unknown>;
  const updates: StateValue[] = [];
  // String metadata whose field name doubles as the state id (playback is coded separately).
  for (const field of ["artist", "album", "track"]) {
    const value = info[field];
    if (typeof value === "string") {
      updates.push({ id: `${prefix}.${field}`, value });
    }
  }
  // Repeat/shuffle carry the same typed form as the YNCA sources: repeat as the
  // media.mode.repeat code (wire off/one/all — captures-verified), shuffle as a boolean
  // (wire off/on). An unknown wire value is skipped, never coerced to a wrong state.
  const repeatCode: Record<string, number> = { off: 0, one: 1, all: 2 };
  if (typeof info.repeat === "string" && info.repeat in repeatCode) {
    updates.push({ id: `${prefix}.repeat`, value: repeatCode[info.repeat] });
  }
  if (info.shuffle === "on" || info.shuffle === "off") {
    updates.push({ id: `${prefix}.shuffle`, value: info.shuffle === "on" });
  }
  // Playback status → media.state code (the same 0/1/2 numbers as the YNCA player).
  const playbackCode: Record<string, number> = { play: 0, stop: 1, pause: 2 };
  if (typeof info.playback === "string" && info.playback in playbackCode) {
    updates.push({ id: `${prefix}.playback`, value: playbackCode[info.playback] });
  }
  // Album art URL and the elapsed/total play time (renamed from the YXC field names).
  const albumArt = info.albumart_url;
  if (typeof albumArt === "string") {
    updates.push({ id: `${prefix}.albumArt`, value: albumArt });
  }
  const elapsed = info.play_time;
  if (typeof elapsed === "number") {
    updates.push({ id: `${prefix}.elapsedTime`, value: elapsed });
  }
  const total = info.total_time;
  if (typeof total === "number") {
    updates.push({ id: `${prefix}.totalTime`, value: total });
  }
  // The active network source (netusb `input`, e.g. "spotify") — only netusb carries it.
  if (typeof info.input === "string") {
    updates.push({ id: `${prefix}.source`, value: info.input });
  }
  // CD-only extras (presence-checked, netusb responses carry none of these fields).
  if (typeof info.track_number === "number") {
    updates.push({ id: `${prefix}.trackNumber`, value: info.track_number });
  }
  if (typeof info.total_tracks === "number") {
    updates.push({ id: `${prefix}.totalTracks`, value: info.total_tracks });
  }
  if (typeof info.disc_time === "number") {
    updates.push({ id: `${prefix}.discTime`, value: info.disc_time });
  }
  if (typeof info.device_status === "string") {
    updates.push({ id: `${prefix}.deviceStatus`, value: info.device_status });
  }
  return updates;
}

/**
 * The DAB block's fields → their unified state ids (aligned with the YNCA DAB ids so
 * both transports feed one node), with the object name each state is created under.
 * Single source for the object mapper (creation) and the parser below (read-back).
 */
export const DAB_FIELDS: Array<{ field: string; id: string; type: "string" | "number" | "boolean"; name: string }> = [
  { field: "service_label", id: "tuner.dab.serviceLabel", type: "string", name: "Service label" },
  { field: "ensemble_label", id: "tuner.dab.ensembleLabel", type: "string", name: "Ensemble label" },
  { field: "ch_label", id: "tuner.dab.channelLabel", type: "string", name: "Channel label" },
  { field: "dls", id: "tuner.dab.dls", type: "string", name: "DLS text" },
  { field: "program_type", id: "tuner.dab.programType", type: "string", name: "Programme type" },
  { field: "preset", id: "tuner.dab.preset", type: "number", name: "DAB preset" },
  { field: "status", id: "tuner.dab.status", type: "string", name: "DAB status" },
  { field: "audio_mode", id: "tuner.dab.audioMode", type: "string", name: "Audio mode" },
  { field: "bit_rate", id: "tuner.dab.bitRate", type: "number", name: "Bit rate" },
  { field: "quality", id: "tuner.dab.quality", type: "number", name: "Signal quality" },
  { field: "off_air", id: "tuner.dab.offAir", type: "boolean", name: "Off air" },
  { field: "dab_plus", id: "tuner.dab.dabPlus", type: "boolean", name: "DAB+" },
  { field: "category", id: "tuner.dab.category", type: "string", name: "Service category" },
  { field: "total_station_num", id: "tuner.dab.totalStations", type: "number", name: "Total stations" },
  { field: "initial_scan_progress", id: "tuner.dab.scanProgress", type: "number", name: "Initial scan progress" },
  { field: "tune_aid", id: "tuner.dab.tuneAid", type: "number", name: "Tune aid level" },
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
      if (typeof current.tuned === "boolean") {
        updates.push({ id: "tuner.tuned", value: current.tuned });
      }
      if (typeof current.audio_mode === "string") {
        updates.push({ id: "tuner.audioMode", value: current.audio_mode });
      }
    }
  }
  const rds = info.rds;
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
 * @returns the state update, or undefined if the response is malformed
 */
export function parseYxcRecentList(info: unknown): StateValue | undefined {
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
    if (typeof e.albumart_url === "string" && e.albumart_url.length > 0) {
      item.albumArt = e.albumart_url;
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
 * presets JSON state: an object keyed by band, each slot kept in its raw response
 * form plus its 1-based slot number (the shape varies per band and firmware).
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
      if (typeof entry === "object" && entry !== null) {
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
 * Format a YXC alarm time ("0800") as a readable "08:00"; other shapes pass through.
 *
 * @param time the raw time value
 * @returns the formatted time
 */
function formatAlarmTime(time: string): string {
  return /^\d{4}$/.test(time) ? `${time.slice(0, 2)}:${time.slice(2)}` : time;
}

/**
 * Parse one alarm-detail block (oneday and each weekly day share the shape).
 *
 * @param prefix the state-id prefix the fields land under (e.g. `clock.alarm.oneday`)
 * @param detail the raw detail block
 * @returns the state updates for that block
 */
function parseAlarmDetail(prefix: string, detail: Record<string, unknown>): StateValue[] {
  const updates: StateValue[] = [];
  if (typeof detail.enable === "boolean") {
    updates.push({ id: `${prefix}.enable`, value: detail.enable });
  }
  if (typeof detail.time === "string") {
    updates.push({ id: `${prefix}.time`, value: formatAlarmTime(detail.time) });
  }
  if (typeof detail.beep === "boolean") {
    updates.push({ id: `${prefix}.beep`, value: detail.beep });
  }
  if (typeof detail.playback_type === "string") {
    updates.push({ id: `${prefix}.playbackType`, value: detail.playback_type });
  }
  const resume = detail.resume;
  if (typeof resume === "object" && resume !== null && typeof (resume as { input?: unknown }).input === "string") {
    updates.push({ id: `${prefix}.resumeInput`, value: (resume as { input: string }).input });
  }
  const preset = detail.preset;
  if (typeof preset === "object" && preset !== null) {
    const p = preset as Record<string, unknown>;
    if (typeof p.type === "string") {
      updates.push({ id: `${prefix}.presetType`, value: p.type });
    }
    if (typeof p.num === "number") {
      updates.push({ id: `${prefix}.presetNumber`, value: p.num });
    }
    if (typeof p.netusb_input === "string") {
      updates.push({ id: `${prefix}.presetInput`, value: p.netusb_input });
    }
  }
  return updates;
}

/** The weekly alarm day keys, as the YXC clock block names them. */
export const ALARM_DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Parse a `/clock/getSettings` response into the read-only clock/alarm states
 * (capture-verified shape: auto_sync/format plus the nested alarm block).
 *
 * @param settings the getSettings response object
 * @returns the clock state updates, empty if malformed
 */
export function parseYxcClock(settings: unknown): StateValue[] {
  if (typeof settings !== "object" || settings === null) {
    return [];
  }
  const s = settings as Record<string, unknown>;
  const updates: StateValue[] = [];
  if (typeof s.auto_sync === "boolean") {
    updates.push({ id: "clock.autoSync", value: s.auto_sync });
  }
  if (typeof s.format === "string") {
    updates.push({ id: "clock.format", value: s.format });
  }
  const alarm = s.alarm;
  if (typeof alarm === "object" && alarm !== null) {
    const a = alarm as Record<string, unknown>;
    if (typeof a.alarm_on === "boolean") {
      updates.push({ id: "clock.alarm.on", value: a.alarm_on });
    }
    if (typeof a.volume === "number") {
      updates.push({ id: "clock.alarm.volume", value: a.volume });
    }
    if (typeof a.fade_interval === "number") {
      updates.push({ id: "clock.alarm.fadeInterval", value: a.fade_interval });
    }
    if (typeof a.fade_type === "number") {
      updates.push({ id: "clock.alarm.fadeType", value: a.fade_type });
    }
    if (typeof a.mode === "string") {
      updates.push({ id: "clock.alarm.mode", value: a.mode });
    }
    if (typeof a.repeat === "boolean") {
      updates.push({ id: "clock.alarm.repeat", value: a.repeat });
    }
    const oneday = a.oneday;
    if (typeof oneday === "object" && oneday !== null) {
      updates.push(...parseAlarmDetail("clock.alarm.oneday", oneday as Record<string, unknown>));
    }
    for (const day of ALARM_DAYS) {
      const detail = a[day];
      if (typeof detail === "object" && detail !== null) {
        updates.push(...parseAlarmDetail(`clock.alarm.${day}`, detail as Record<string, unknown>));
      }
    }
  }
  return updates;
}
