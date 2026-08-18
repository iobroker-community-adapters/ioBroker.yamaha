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
  | { kind: "tunerFreq"; value: number };

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
