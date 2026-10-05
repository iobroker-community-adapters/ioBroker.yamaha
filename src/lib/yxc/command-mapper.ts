import { splitZone } from "../catalog/zones";
import { coerceBool, isWritableValue } from "../catalog/value-coerce";
import { gateValue } from "./values";
import { YXC_AMP_CATALOG } from "./catalog";
import { isRemoteWord, YXC_CURSOR_VALUES, YXC_MENU_VALUES } from "./remote";
import type { YxcClientLike } from "./client-contract";

/**
 * A mapped YXC write. Almost every command is a ready-to-run client call (`run`) built
 * from the catalog's `write.apply` or the transport/toggle tables — no method-name
 * string, no dispatch switch, no "unknown command" runtime path. The commands that need
 * controller-held state stay declarative: the equalizer (the device sets all three bands in
 * one call, the other two come from the cached status), the volume (the zone's display
 * scale), the tuner band, frequency, preset, clear and search (the current band), the
 * favourite and recent recalls (the listening zone), and the player block's transport and
 * modes (the source the zone plays).
 */
export type YxcCommand =
  | {
      kind: "run";
      run: (client: YxcClientLike) => Promise<unknown>;
      /**
       * What the key changes, read back instead of the zone status: a media source's play info (a
       * tuner step or the CD tray changes `tuner/getPlayInfo` or `cd/getPlayInfo`, never `getStatus`;
       * YXC Basic §6.6/§6.15/§8.3; audit 2026-09-29, C32), the clock settings, or the stored
       * favourites/stations list.
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
 * Button states → their client call (the CD tray; the transport buttons go through the
 * controller's `runTransport`).
 */
const BUTTON_ACTIONS: Record<string, (client: YxcClientLike) => Promise<unknown>> = {
  "player.cd.tray": client => client.toggleTray(),
};

/** The unified player block's transport buttons (v2.0.0) — routed by the controller to the zone's playing source. */
const PLAYER_TRANSPORTS = ["play", "pause", "stop", "next", "prev", "repeatToggle", "shuffleToggle"] as const;

/** A transport action of the unified player block. */
export type PlayerTransport = (typeof PLAYER_TRANSPORTS)[number];

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
  const entry = YXC_AMP_CATALOG.find(e => e.state === name);
  if (!entry?.write) {
    return undefined;
  }
  // The one gate of a written value: a switch reads the words a script writes ("false", "off", "0") for what they
  // mean, a number takes the strict number rule, a word is trimmed text.
  const { value: input } = gateValue(entry.common.type, value);
  if (input === undefined) {
    return undefined;
  }
  const write = entry.write;
  switch (write.kind) {
    case "volume":
      // Declarative: the datapoint carries what the receiver DISPLAYS while setVolume takes only the raw step
      // count. Converting between the two needs the zone's declared scale and the display mode it currently
      // reports, and both live in the controller.
      return { kind: "volume", zone, value: Number(input) };
    case "equalizer":
      // The controller supplies the other two bands; the value carries only this band.
      return { kind: "equalizer", zone, band: write.band, value: Number(input) };
    case "set":
      return { kind: "run", run: client => write.apply(client, input, zone) };
  }
}

// The parsers live in their own modules now (review 2026-10-05, SOLID: the command mapper did five jobs). Re-exported
// for the importers outside the MusicCast data layer (the device controller, manifest.test.ts) until they import from
// the modules themselves — then this block goes.
export { parseYxcSignalInfo, parseYxcStatus } from "./status";
export { DAB_FIELDS, parseYxcPlayInfo, parseYxcTunerInfo } from "./play-info";
export {
  CLIENT_SLOT_FIELDS,
  clientSlotEntries,
  NETUSB_SLOT_FIELDS,
  netusbSlotEntries,
  parseYxcPlaylistNames,
  parseYxcPlayQueue,
  parseYxcPresetList,
  parseYxcRecentList,
  parseYxcTunerPresetLists,
  PLAYLIST_SLOT_FIELDS,
  playlistSlotEntries,
  playQueueCounters,
  playQueueSlotEntries,
  STATION_SLOT_FIELDS,
  stationSlotEntries,
  type SlotEntry,
} from "./lists";
export { distributionSummary, parseYxcDistribution, type DistributionSummary } from "./distribution";
export { ALARM_DAYS, parseYxcClock } from "./clock";
