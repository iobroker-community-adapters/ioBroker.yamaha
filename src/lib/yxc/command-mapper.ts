import type { StateValue } from "../types";
import { isWritableValue } from "../catalog/value-coerce";
import { YXC_AMP_CATALOG } from "./catalog";

/** A YXC amplifier command: a YamahaYXC method with its target zone and value. */
export interface YxcCommand {
  /** The YamahaYXC method to call (`power`, `setVolumeTo`, `mute`, `setInput`, `setSound`). */
  method: string;
  /** The target zone (`main`, `zone2`, …). */
  zone: string;
  /** The value to pass to the method. */
  value: boolean | number | string;
}

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

/** Network-player transport buttons → YamahaYXC method (no zone/value). */
const NETUSB_TRANSPORT: Record<string, string> = {
  "player.netPlayer.play": "playNet",
  "player.netPlayer.pause": "pauseNet",
  "player.netPlayer.stop": "stopNet",
  "player.netPlayer.next": "nextNet",
  "player.netPlayer.prev": "prevNet",
};

/**
 * CD transport buttons → the YXC action word for `setCDPlayback`. Routed through
 * the one `setCDPlayback(action)` method (not the per-action `pauseCD()` helpers,
 * one of which sends the wrong command in the library).
 */
const CD_TRANSPORT: Record<string, string> = {
  "player.cd.play": "play",
  "player.cd.pause": "pause",
  "player.cd.stop": "stop",
  "player.cd.next": "next",
  "player.cd.prev": "previous",
};

/** Repeat/shuffle/tray toggle buttons → the YamahaYXC method (no zone or value). */
const TOGGLE_ACTIONS: Record<string, string> = {
  "player.netPlayer.repeatToggle": "toggleNetRepeat",
  "player.netPlayer.shuffleToggle": "toggleNetShuffle",
  "player.cd.repeatToggle": "toggleCDRepeat",
  "player.cd.shuffleToggle": "toggleCDShuffle",
  "player.cd.tray": "toggleTray",
};

/** Equalizer band state (without zone prefix) → the band suffix of its setEqualizer<Band> method. */
const EQ_CHANNELS: Record<string, string> = {
  "sound.equalizerLow": "Low",
  "sound.equalizerMid": "Mid",
  "sound.equalizerHigh": "High",
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
  const transport = NETUSB_TRANSPORT[stateId];
  if (transport) {
    return { method: transport, zone: "netusb", value: true };
  }
  const cdAction = CD_TRANSPORT[stateId];
  if (cdAction) {
    return { method: "setCDPlayback", zone: "cd", value: cdAction };
  }
  const toggle = TOGGLE_ACTIONS[stateId];
  if (toggle) {
    return { method: toggle, zone: "netusb", value: true };
  }
  if (stateId === "tuner.band" && isWritableValue(value, false)) {
    return { method: "setBand", zone: "tuner", value: String(value) };
  }
  if (stateId === "tuner.frequency" && isWritableValue(value, true)) {
    // The controller supplies the current band; the value carries only the frequency.
    return { method: "setFreq", zone: "tuner", value: Number(value) };
  }
  if (stateId === "player.netPlayer.preset" && isWritableValue(value, true)) {
    return { method: "recallPreset", zone: "netusb", value: Number(value) };
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
    return { method: `setEqualizer${eqBand}`, zone, value: Number(value) };
  }
  const entry = YXC_AMP_CATALOG.find(e => e.state === name);
  if (!entry?.write || !isWritableValue(value, entry.common.type === "number")) {
    return undefined;
  }
  return { method: entry.write.method, zone, value: entry.write.toYxc(value) };
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
    updates.push({ id: "multiroom.role", value: d.role });
  }
  if (typeof d.group_id === "string") {
    updates.push({ id: "multiroom.groupId", value: d.group_id });
  }
  if (typeof d.group_name === "string") {
    updates.push({ id: "multiroom.groupName", value: d.group_name });
  }
  if (typeof d.server_zone === "string") {
    updates.push({ id: "multiroom.serverZone", value: d.server_zone });
  }
  if (Array.isArray(d.client_list)) {
    updates.push({ id: "multiroom.clientList", value: JSON.stringify(d.client_list) });
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
  for (const field of ["artist", "album", "track", "repeat", "shuffle"]) {
    const value = info[field];
    if (typeof value === "string") {
      updates.push({ id: `${prefix}.${field}`, value });
    }
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
  return updates;
}

/**
 * Parse a YXC `/tuner/getPlayInfo` response into the tuner's read-only states:
 * the current band, the active band's raw frequency (nested under the band key,
 * e.g. `fm.freq`), and the RDS radio text. Fields absent from the response are
 * skipped, so a device without RDS simply yields no rdsText update.
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
      const freq = (bandInfo as Record<string, unknown>).freq;
      if (typeof freq === "number") {
        updates.push({ id: "tuner.frequency", value: freq });
      }
    }
  }
  const rds = info.rds;
  if (typeof rds === "object" && rds !== null) {
    const text = (rds as Record<string, unknown>).radio_text_a;
    if (typeof text === "string") {
      updates.push({ id: "tuner.rdsText", value: text });
    }
  }
  return updates;
}
