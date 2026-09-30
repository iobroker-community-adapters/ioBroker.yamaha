import { MEDIA_STATE } from "../catalog/media-state";
import type { StateValue } from "../types";
import { splitZone, YXC_ZONE_IDS, zonePrefix } from "./zones";
import type { I18nKey } from "../i18n";
import { coerceBool, isWritableValue } from "../catalog/value-coerce";
import { formatPlayTime } from "../catalog/play-time";
import type { SlotField } from "../catalog/list-slots";
import { YXC_AMP_CATALOG } from "./catalog";
import { musicCastInputName } from "../catalog/musiccast-vocabulary";
import { isRemoteWord, YXC_CURSOR_VALUES, YXC_MENU_VALUES } from "./remote";
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
  | {
      kind: "run";
      run: (client: YxcClientLike) => Promise<unknown>;
      /**
       * The media source whose play info the key changes — read back instead of the zone status: a
       * tuner step or the CD tray changes `tuner/getPlayInfo` or `cd/getPlayInfo`, never `getStatus`
       * (YXC Basic §6.6/§6.15/§8.3; audit 2026-09-29, C32).
       */
      source?: "tuner" | "cd" | "clock" | "favourites" | "stations";
    }
  | { kind: "equalizer"; zone: string; band: "low" | "mid" | "high"; value: number }
  | { kind: "volume"; zone: string; value: number }
  | { kind: "tunerFreq"; value: number }
  | { kind: "tunerPreset"; value: number }
  | { kind: "tunerBand"; band: string }
  | { kind: "netusbPreset"; value: number }
  | { kind: "netusbRecent"; value: number }
  | { kind: "playerTransport"; zone: string; action: PlayerTransport }
  | { kind: "playerMode"; zone: string; repeat?: "off" | "one" | "all"; shuffle?: "off" | "on" }
  | { kind: "tunerClear"; value: number }
  | { kind: "tunerSearch"; direction: "up" | "down" };

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
 * Button states → their client call. The CD transport routes through the one
 * `setCDPlayback(action)` method (not the per-action `pauseCD()` helpers, one of
 * which sends the wrong command in the library).
 */
const BUTTON_ACTIONS: Record<string, (client: YxcClientLike) => Promise<unknown>> = {
  "player.cd.tray": client => client.toggleTray(),
};

/** The unified player block's transport buttons (v2.0.0) — routed by the controller to the zone's playing source. */
const PLAYER_TRANSPORTS = ["play", "pause", "stop", "next", "prev", "repeatToggle", "shuffleToggle"] as const;

/** A transport action of the unified player block. */
export type PlayerTransport = (typeof PLAYER_TRANSPORTS)[number];

/** Equalizer band state (without zone prefix) → the band of the declarative equalizer command. */
const EQ_CHANNELS: Record<string, "low" | "mid" | "high"> = {
  "sound.equalizer.low": "low",
  "sound.equalizer.mid": "mid",
  "sound.equalizer.high": "high",
};

/** The alarm detail fields a datapoint sets, by id segment → `detail` key (YXC Basic Rev 1.10 §9.5). */
const ALARM_DETAIL_WRITES: Readonly<Record<string, "enable" | "time" | "beep">> = {
  enable: "enable",
  time: "time",
  beep: "beep",
};

/**
 * A clock or alarm write as its setter (YXC Basic Rev 1.10 §9.2/§9.4/§9.5): the clock's auto sync
 * and time format, and the alarm's switch, volume, mode, repeat and per-day enable/time/beep. A time
 * is written as the datapoint shows it (`07:30`) and sent as `hhmm`.
 *
 * @param stateId the state id relative to the device
 * @param value the written value
 * @returns the command, or undefined when the id is none of them or the value does not fit
 */
function clockCommand(stateId: string, value: unknown): YxcCommand | undefined {
  const alarm = (settings: Record<string, unknown>): YxcCommand => ({
    kind: "run",
    run: client => client.setAlarmSettings(settings),
    source: "clock",
  });
  if (stateId === "clock.autoSync") {
    const on = coerceBool(value);
    return on === undefined ? undefined : { kind: "run", run: client => client.setClockAutoSync(on), source: "clock" };
  }
  if (stateId === "clock.format") {
    return value === "12h" || value === "24h"
      ? { kind: "run", run: client => client.setClockFormat(value), source: "clock" }
      : undefined;
  }
  if (stateId === "clock.alarm.on" || stateId === "clock.alarm.repeat") {
    const on = coerceBool(value);
    return on === undefined ? undefined : alarm({ [stateId === "clock.alarm.on" ? "alarm_on" : "repeat"]: on });
  }
  if (stateId === "clock.alarm.volume") {
    return isWritableValue(value, true) ? alarm({ volume: Math.round(Number(value)) }) : undefined;
  }
  if (stateId === "clock.alarm.mode") {
    return typeof value === "string" && value !== "" ? alarm({ mode: value }) : undefined;
  }
  const detail = /^clock\.alarm\.(oneday|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\.(\w+)$/.exec(
    stateId,
  );
  const key = detail ? ALARM_DETAIL_WRITES[detail[2]] : undefined;
  if (!detail || !key) {
    return undefined;
  }
  if (key === "time") {
    const time = typeof value === "string" ? /^(\d{1,2}):?(\d{2})$/.exec(value.trim()) : null;
    const hh = time ? Number(time[1]) : Number.NaN;
    const mm = time ? Number(time[2]) : Number.NaN;
    return hh <= 23 && mm <= 59
      ? alarm({ detail: { day: detail[1], time: `${String(hh).padStart(2, "0")}${String(mm).padStart(2, "0")}` } })
      : undefined;
  }
  const on = coerceBool(value);
  return on === undefined ? undefined : alarm({ detail: { day: detail[1], [key]: on } });
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
  const prefix = YXC_ZONE_IDS.includes(zone as (typeof YXC_ZONE_IDS)[number]) ? zonePrefix(zone) : undefined;
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
    return { kind: "run", run: button, source: "cd" };
  }
  if (stateId === "tuner.band" && isWritableValue(value, false)) {
    // Its own kind, not a plain run: the controller has to remember the band, because a
    // frequency or preset write right afterwards needs it. Reading it back from the poll
    // is too late — a script that switches band and sets a frequency in one go would send
    // the frequency to the OLD band.
    return { kind: "tunerBand", band: String(value) };
  }
  if (stateId === "tuner.frequency" && isWritableValue(value, true)) {
    // The controller supplies the current band; the value carries only the frequency.
    return { kind: "tunerFreq", value: Number(value) };
  }
  if (stateId === "player.netPlayer.preset" && isWritableValue(value, true)) {
    const preset = Number(value);
    // Declarative, because the ZONE is not knowable here: recalling a favourite also
    // routes it to a zone, and the right one is whichever zone is listening to the network
    // player. Only the controller tracks that.
    return { kind: "netusbPreset", value: preset };
  }
  if (stateId === "player.netPlayer.recallRecent" && isWritableValue(value, true)) {
    const num = Number(value);
    return { kind: "netusbRecent", value: num };
  }
  if (stateId === "tuner.preset" && isWritableValue(value, true)) {
    // 0 is what the device REPORTS for "no preset" (Basic §6.2) — it is not a slot to recall.
    // That is the specification's statement, not a dropdown used as validation (audit 2026-09-24, C16).
    if (Number(value) === 0) {
      return undefined;
    }
    // The controller supplies the band (or `common` on shared-list devices).
    return { kind: "tunerPreset", value: Number(value) };
  }
  if (stateId === "tuner.presetUp") {
    return { kind: "run", run: client => client.switchTunerPreset("next"), source: "tuner" };
  }
  if (stateId === "tuner.presetDown") {
    return { kind: "run", run: client => client.switchTunerPreset("previous"), source: "tuner" };
  }
  if (stateId === "tuner.dab.serviceUp") {
    return { kind: "run", run: client => client.setDabService("next"), source: "tuner" };
  }
  if (stateId === "tuner.dab.serviceDown") {
    return { kind: "run", run: client => client.setDabService("previous"), source: "tuner" };
  }
  // Spec-covered writes that had no way in (audit 2026-09-29, C38).
  const slot = isWritableValue(value, true) ? Math.round(Number(value)) : Number.NaN;
  if (stateId === "tuner.presetSave") {
    return slot >= 1 ? { kind: "run", run: client => client.storeTunerPreset(slot), source: "stations" } : undefined;
  }
  if (stateId === "tuner.presetClear") {
    return slot >= 1 ? { kind: "tunerClear", value: slot } : undefined;
  }
  if (stateId === "tuner.searchUp" || stateId === "tuner.searchDown") {
    return { kind: "tunerSearch", direction: stateId === "tuner.searchUp" ? "up" : "down" };
  }
  if (stateId === "player.netPlayer.presetSave") {
    return slot >= 1 ? { kind: "run", run: client => client.storeNetPreset(slot), source: "favourites" } : undefined;
  }
  if (stateId === "player.netPlayer.presetClear") {
    return slot >= 1 ? { kind: "run", run: client => client.clearNetPreset(slot), source: "favourites" } : undefined;
  }
  if (stateId === "player.cd.trackSelect") {
    return slot >= 1 && slot <= 512
      ? { kind: "run", run: client => client.selectCdTrack(slot), source: "cd" }
      : undefined;
  }
  if (stateId === "player.netPlayer.playPosition") {
    return slot >= 0 ? { kind: "run", run: client => client.setPlayPosition(slot) } : undefined;
  }
  const clock = clockCommand(stateId, value);
  if (clock) {
    return clock;
  }
  const { zone, name } = splitZone(stateId);
  // Scene recall (#615) and the on-screen remote — zone-scoped, device-verified endpoints.
  if (name === "scene.recall" && isWritableValue(value, true)) {
    const num = Math.round(Number(value));
    const sceneZone = zone;
    return { kind: "run", run: client => client.recallScene(num, sceneZone) };
  }
  // The written word is checked against the transport's own vocabulary, exactly as the
  // browsing engine does it for YNCA and XML. The dropdown is a hint, not a constraint: a
  // script can write anything, and this was the one remote path that passed it straight to
  // the device (audit 2026-09-06).
  if (name === "remote.cursor") {
    if (!isRemoteWord(YXC_CURSOR_VALUES, value)) {
      return undefined;
    }
    const cursorZone = zone;
    return { kind: "run", run: client => client.controlCursor(value, cursorZone) };
  }
  if (name === "remote.menu") {
    if (!isRemoteWord(YXC_MENU_VALUES, value)) {
      return undefined;
    }
    const menuZone = zone;
    return { kind: "run", run: client => client.controlMenu(value, menuZone) };
  }
  // The unified player block's transport buttons (v2.0.0): declarative, because only
  // the controller knows which source (netusb or cd) the zone is playing.
  if (name.startsWith("player.")) {
    const action = name.slice("player.".length);
    if ((PLAYER_TRANSPORTS as readonly string[]).includes(action)) {
      return { kind: "playerTransport", zone, action: action as PlayerTransport };
    }
  }
  // Repeat and shuffle set directly (API 1.19+, audit 2026-09-29, C37) — in the codes the datapoints
  // carry: repeat 0/1/2 = off/one/all, shuffle a switch.
  if (name === "player.repeat" && isWritableValue(value, true)) {
    const mode = (["off", "one", "all"] as const)[Number(value)];
    return mode === undefined ? undefined : { kind: "playerMode", zone, repeat: mode };
  }
  if (name === "player.shuffle") {
    const on = coerceBool(value);
    return on === undefined ? undefined : { kind: "playerMode", zone, shuffle: on ? "on" : "off" };
  }
  // Volume is declarative because the datapoint carries what the receiver DISPLAYS while
  // setVolume takes only the raw step count. Converting between the two needs the ratio of the
  // pair the device reports in one status answer, and that lives in the controller.
  if (name === "volume" && isWritableValue(value, true)) {
    return { kind: "volume", zone, value: Number(value) };
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
  // A switch reads the words a script writes ("false", "off", "0") for what they mean — the
  // entry's Boolean() would send every non-empty string as on.
  const input = entry.common.type === "boolean" ? coerceBool(value) : value;
  if (input === undefined) {
    return undefined;
  }
  const { apply } = entry.write;
  return { kind: "run", run: client => apply(client, input, zone) };
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
  const summary = distributionSummary(info);
  if (typeof d.role === "string") {
    updates.push({ id: "multiroom.group.role", value: summary.role });
    // Only a server reports a construction state (Advanced §5.1) — none, not a word outside the list.
    updates.push({ id: "multiroom.group.status", value: summary.status ?? null });
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

/** What a getDistributionInfo answer says about a device's part in a MusicCast group. */
export interface DistributionSummary {
  /** The effective role: server, client or none (see {@link distributionSummary}). */
  role: string;
  /** The group id, "" when none. */
  groupId: string;
  /** Whether the group id names a group (not empty, not all zeros). */
  inGroup: boolean;
  /** The clients' IPv4 addresses (a server's roster). */
  clients: string[];
  /** The zone the server distributes. */
  serverZone: string;
  /** Building / working / deleting — reported for a server from API 2.00 on; undefined otherwise. */
  status?: string;
}

/**
 * Read a device's part in a group the way YXC Advanced asks for it: a device with a group id and a
 * client list is the server even while it answers "none" (§9.2), and one without a group id is in no
 * group even while it answers "client" (§9.1.7-5 — any zone on the MusicCast Link input says so).
 * The role word alone flickered; the leave path read it and sent a server's clean-up to a client
 * (audit 2026-09-24, C7).
 *
 * @param info the getDistributionInfo answer
 * @returns the summary
 */
export function distributionSummary(info: unknown): DistributionSummary {
  const d = typeof info === "object" && info !== null ? (info as Record<string, unknown>) : {};
  const groupId = typeof d.group_id === "string" ? d.group_id : "";
  const inGroup = /[1-9a-f]/i.test(groupId);
  const clients = (Array.isArray(d.client_list) ? d.client_list : [])
    .map(entry =>
      typeof entry === "string"
        ? entry
        : typeof entry === "object" &&
            entry !== null &&
            typeof (entry as { ip_address?: unknown }).ip_address === "string"
          ? (entry as { ip_address: string }).ip_address
          : "",
    )
    .filter(ip => ip.length > 0);
  const reported = typeof d.role === "string" ? d.role : "none";
  const role = inGroup && clients.length > 0 ? "server" : !inGroup && reported === "client" ? "none" : reported;
  const status = role === "server" && typeof d.status === "string" ? d.status.trim() : undefined;
  return {
    role,
    groupId,
    inGroup,
    clients,
    serverZone: typeof d.server_zone === "string" ? d.server_zone : "main",
    ...(status !== undefined ? { status } : {}),
  };
}

/**
 * The address a device-relative path is fetched at: YXC answers the cover as a path on its own web
 * server ("If xxx/yyy/zzz.jpg is returned, the absolute path is http://{host}/xxx/yyy/zzz.jpg", YXC
 * Basic §7.2). A full URL (a service's own cover in the recently-played list) and "" stay as they
 * are; without a host nothing is invented (audit 2026-09-24, C6).
 *
 * @param url the address the device reported
 * @param host the device's address, as configured
 * @returns the address a browser or a visualisation can load
 */
export function absoluteDeviceUrl(url: string, host: string | undefined): string {
  if (url === "" || host === undefined || /^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    return url;
  }
  return `http://${host}/${url.replace(/^\/+/, "")}`;
}

/**
 * A cover address that changes when the cover does. Several devices serve every cover under ONE fixed
 * path (`/YamahaRemoteControl/AlbumART/AlbumART.jpg`, YXC Basic Rev 1.10 §7.2) and say "the album art
 * changed" only by a new `albumart_id` — the datapoint stayed byte-identical and a widget kept showing the
 * previous track's cover (audit 2026-09-29, C36). The id rides along as a query, so the address changes.
 *
 * @param url the cover address ("" = none)
 * @param id the reported `albumart_id`
 * @returns the address, with the id appended where there is one
 */
export function withAlbumArtId(url: string, id: unknown): string {
  if (url === "" || (typeof id !== "number" && typeof id !== "string") || `${id}` === "") {
    return url;
  }
  return `${url}${url.includes("?") ? "&" : "?"}id=${encodeURIComponent(`${id}`)}`;
}

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
 * The values a zone's player block is reset to when the zone leaves its playing
 * source (v2.0.0 clear-on-switch): metadata empty, times zero, playback Stop.
 */
export const PLAYER_CLEAR: StateValue[] = [
  { id: "player.source", value: "" },
  { id: "player.playback", value: MEDIA_STATE.stop },
  { id: "player.artist", value: "" },
  { id: "player.album", value: "" },
  { id: "player.track", value: "" },
  { id: "player.albumArt", value: "" },
  { id: "player.elapsedTime", value: 0 },
  { id: "player.elapsedTimeText", value: "" },
  { id: "player.totalTime", value: 0 },
  { id: "player.totalTimeText", value: "" },
  { id: "player.repeat", value: 0 },
  { id: "player.shuffle", value: false },
];

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
export function parseYxcRecentList(info: unknown, cover: (url: string) => string = asReported): StateValue | undefined {
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
  const prefix = YXC_ZONE_IDS.includes(zone as (typeof YXC_ZONE_IDS)[number]) ? zonePrefix(zone) : undefined;
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
  if (typeof detail.snooze === "boolean") {
    updates.push({ id: `${prefix}.snooze`, value: detail.snooze });
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
    // YXC Basic §9.1: the slot's source and station name under `netusb_info`, its band and frequency under
    // `tuner_info` — "unknown"/"" /0 when the slot is empty. Until 3.0.1 the adapter read `netusb_input`, a
    // field no source knows, and the input stood empty for good (audit 2026-09-29, C34).
    const netusb = p.netusb_info as { input?: unknown; text?: unknown } | undefined;
    if (netusb && typeof netusb === "object") {
      if (typeof netusb.input === "string") {
        updates.push({ id: `${prefix}.presetInput`, value: netusb.input === "unknown" ? "" : netusb.input });
      }
      if (typeof netusb.text === "string") {
        updates.push({ id: `${prefix}.presetName`, value: netusb.text });
      }
    }
    const tuner = p.tuner_info as { band?: unknown; number?: unknown } | undefined;
    if (tuner && typeof tuner === "object") {
      const band = typeof tuner.band === "string" && tuner.band !== "unknown" ? tuner.band : "";
      updates.push({ id: `${prefix}.presetBand`, value: band });
      // AM/FM carry the frequency in kHz; DAB a station id, which is no frequency.
      const khz = (band === "am" || band === "fm") && typeof tuner.number === "number" ? tuner.number : 0;
      updates.push({ id: `${prefix}.presetFrequency`, value: khz });
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
