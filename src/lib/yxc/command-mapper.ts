import { splitZone, type ZoneKey } from "../catalog/zones";
import { slotNumber, snapToGrid, writableNumber, type NumberGrid } from "../catalog/value-coerce";
import { gateValue, range, shown, type YxcValue } from "./values";
import { YXC_AMP_CATALOG } from "./catalog";
import { isRemoteWord, YXC_CURSOR_VALUES, YXC_MENU_VALUES } from "./remote";
import type { YxcCapabilities, YxcZone } from "./capability";
import type { YxcClientLike } from "./client-contract";

/**
 * A mapped YXC write. Almost every command is a ready-to-run client call (`run`) built
 * from the catalog's `write.apply` or the rule tables below — no method-name
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
       * YXC Basic §6.6/§6.15/§8.3; audit 2026-09-29, C32 — a seek changes `netusb/getPlayInfo`, review
       * 2026-10-05, A49), the clock settings, or the stored favourites/stations list.
       */
      source?: "netusb" | "tuner" | "cd" | "clock" | "favourites" | "stations";
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
 * What the write mapping needs of the controller's knowledge: the device's declarations — a zone's grids, scene
 * count and key lists, the favourite/recent/station slot counts, the tuner's band grids, the alarm volume — and the
 * band the tuner is on. Without it the rules still hold (a slot is a whole number from 1, a number passes the strict
 * rule); only the device's declared ends and grids are not applied.
 */
export interface YxcWriteContext {
  /** The device's getFeatures declarations. */
  capabilities?: YxcCapabilities;
  /** The band the tuner is on right now — a frequency is put on its grid. */
  tunerBand?: string;
}

/**
 * What the mapping made of a write: the command, or why nothing is sent — the controller logs the reason, so a write
 * that goes nowhere leaves the same trace on every protocol (review 2026-10-05, A26).
 */
export type YxcWrite = { command: YxcCommand; dropped?: never } | { dropped: string; command?: never };

/** The unified player block's transport buttons (v2.0.0) — routed by the controller to the zone's playing source. */
const PLAYER_TRANSPORTS = ["play", "pause", "stop", "next", "prev", "repeatToggle", "shuffleToggle"] as const;

/** A transport action of the unified player block. */
export type PlayerTransport = (typeof PLAYER_TRANSPORTS)[number];

/** The repeat modes by the code the datapoint carries (media.mode.repeat: 0 off, 1 one, 2 all). */
const REPEAT_MODES = ["off", "one", "all"] as const;

/** The highest CD track `selectCdTrack` takes (YXC Basic Rev 1.10 §8.2: 1…512). */
const CD_TRACKS = 512;

/** A seek position: whole seconds from the start (YXC Basic Rev 1.10 §7.4). */
const SECONDS: NumberGrid = { min: 0, step: 1 };

/** One datapoint's rule: the written value, the controller's knowledge, the zone its id names. */
type WriteRule = (value: unknown, context: YxcWriteContext, zone: ZoneKey) => YxcWrite;

/**
 * A command to send.
 *
 * @param command the command
 * @returns the write
 */
const send = (command: YxcCommand): YxcWrite => ({ command });

/**
 * Nothing to send.
 *
 * @param reason why — the controller logs it
 * @returns the write
 */
const drop = (reason: string): YxcWrite => ({ dropped: reason });

/**
 * A ready client call.
 *
 * @param call the call
 * @param source what it changes, read back instead of the zone status
 * @returns the write
 */
function run(
  call: (client: YxcClientLike) => Promise<unknown>,
  source?: Extract<YxcCommand, { kind: "run" }>["source"],
): YxcWrite {
  return send({ kind: "run", run: call, ...(source ? { source } : {}) });
}

/**
 * A written slot — a scene, a favourite, a preset, a recent entry, a track: a whole number from 1 to the last slot
 * the device declares. MusicCast recalled scene 2 for 1.5 and sent `recallScene(0)` for 0, and sent a preset 2.5 as
 * it was, where YNCA and XML rounded it (review 2026-10-05, A26) — one rule now, `slotNumber`.
 *
 * @param value the written value
 * @param max the last slot the device declares, if it declares one
 * @param then the write for the slot
 * @returns the write, or the reason
 */
function slot(value: unknown, max: number | undefined, then: (slot: number) => YxcWrite): YxcWrite {
  const num = slotNumber(value, max);
  return num === undefined
    ? drop(`${shown(value)} is no slot number from 1${max !== undefined ? ` to ${max}` : ""}`)
    : then(num);
}

/**
 * A written value through the one gate of its type (switch words, the strict number rule on the declared grid,
 * trimmed text — see `gateValue`).
 *
 * @param type the datapoint's type
 * @param value the written value
 * @param grid the grid the device declares for a number, if any
 * @param then the write for the gated value
 * @returns the write, or the reason
 */
function gated(
  type: "boolean" | "number" | "string" | undefined,
  value: unknown,
  grid: NumberGrid | undefined,
  then: (value: YxcValue) => YxcWrite,
): YxcWrite {
  const result = gateValue(type, value, grid);
  return result.dropped !== undefined ? drop(result.dropped) : then(result.value);
}

/**
 * A zone as the device declares it.
 *
 * @param context the controller's knowledge
 * @param zone the zone
 * @returns the zone's declaration, when known
 */
function declaredZone(context: YxcWriteContext, zone: ZoneKey): YxcZone | undefined {
  return context.capabilities?.zones.find(candidate => candidate.id === zone);
}

/**
 * An alarm setting (YXC Basic Rev 1.10 §9.5).
 *
 * @param settings the setAlarmSettings body
 * @returns the write
 */
const alarm = (settings: Record<string, unknown>): YxcWrite =>
  run(client => client.setAlarmSettings(settings), "clock");

/**
 * The tuner frequency, on the grid the device declares for the band the tuner is on (getFeatures `tuner.range_step`:
 * FM 87500…108000 in 50 kHz steps, AM 531…1611/9 or 530…1710/10). MusicCast sent the written number as it was, YNCA
 * snapped it without ends, XML snapped and clamped — a clamped value tuned another station than the one written
 * (review 2026-10-05, A20/A26). Outside the band's range nothing is sent.
 *
 * @param value the written value
 * @param context the controller's knowledge — the band and its grid
 * @returns the write, or the reason
 */
function tunerFrequency(value: unknown, context: YxcWriteContext): YxcWrite {
  const band = context.tunerBand;
  // setFreq knows only "am" and "fm" (YXC Basic §6.4): a DAB station is chosen by service (§6.15; audit 2026-09-24, C17).
  if (band === "dab") {
    return drop("DAB is tuned by service, not by frequency — tuner.dab.serviceUp/serviceDown choose a station");
  }
  const khz = writableNumber(value);
  if (khz === undefined) {
    return drop(`${shown(value)} is no frequency`);
  }
  const grid = band !== undefined ? context.capabilities?.tuner?.ranges?.[band] : undefined;
  const snapped = snapToGrid(khz, grid);
  // The controller supplies the band; the value carries only the frequency.
  return snapped === undefined
    ? drop(`${khz} kHz is outside the ${String(band).toUpperCase()} range ${range(grid)} kHz`)
    : send({ kind: "tunerFreq", value: snapped });
}

/**
 * An on-screen remote key: the words THIS zone declares (`cursor_list`/`menu_list` — help, mode and the four colour
 * keys exist on some models only), the shared vocabulary for a zone without a list. The written word is checked
 * against them, as the browsing engine does it for YNCA and XML: the dropdown is a hint, not a constraint (audit
 * 2026-09-06). The controller checked the declared words on its own beside this — the routing of a key stood in two
 * places (review 2026-10-05, DRY); with the declarations in the context it is decided here alone.
 *
 * @param name the remote datapoint
 * @param value the written value
 * @param context the controller's knowledge — the zone's declared lists
 * @param zone the zone
 * @returns the write, or the reason
 */
function remoteKey(
  name: "remote.cursor" | "remote.menu",
  value: unknown,
  context: YxcWriteContext,
  zone: ZoneKey,
): YxcWrite {
  const declared = declaredZone(context, zone)?.valueLists?.[name];
  const words = declared ?? (name === "remote.cursor" ? YXC_CURSOR_VALUES : YXC_MENU_VALUES);
  if (!isRemoteWord(words, value)) {
    return drop(`${shown(value)} is no key ${declared ? "this zone declares" : "MusicCast takes"}`);
  }
  const word = value;
  return run(client => (name === "remote.cursor" ? client.controlCursor(word, zone) : client.controlMenu(word, zone)));
}

/** The device-wide writes — the tuner, the network player, the CD drive and the clock — by datapoint. */
const DEVICE_WRITES: Readonly<Record<string, WriteRule>> = {
  "player.cd.tray": () => run(client => client.toggleTray(), "cd"),
  // Its own kind, not a plain run: the controller has to remember the band, because a frequency or preset write
  // right afterwards needs it. Reading it back from the poll is too late — a script that switches band and sets a
  // frequency in one go would send the frequency to the OLD band.
  "tuner.band": value => gated("string", value, undefined, band => send({ kind: "tunerBand", band: String(band) })),
  "tuner.frequency": (value, context) => tunerFrequency(value, context),
  "tuner.preset": (value, context) =>
    // 0 is what the device REPORTS for "no preset" (Basic §6.2) — it is not a slot to recall. That is the
    // specification's statement, not a dropdown used as validation (audit 2026-09-24, C16). The controller
    // supplies the band (or `common` on shared-list devices).
    writableNumber(value) === 0
      ? drop('0 is the device\'s "no preset" — no slot to recall')
      : slot(value, context.capabilities?.tuner?.presetNum, num => send({ kind: "tunerPreset", value: num })),
  "tuner.presetUp": () => run(client => client.switchTunerPreset("next"), "tuner"),
  "tuner.presetDown": () => run(client => client.switchTunerPreset("previous"), "tuner"),
  "tuner.dab.serviceUp": () => run(client => client.setDabService("next"), "tuner"),
  "tuner.dab.serviceDown": () => run(client => client.setDabService("previous"), "tuner"),
  // Spec-covered writes that had no way in (YXC Basic Rev 1.10 §6.4/§6.7/§6.8/§7.4/§7.11/§7.12/§8.2; audit
  // 2026-09-29, C38).
  "tuner.presetSave": (value, context) =>
    slot(value, context.capabilities?.tuner?.presetNum, num => run(client => client.storeTunerPreset(num), "stations")),
  "tuner.presetClear": (value, context) =>
    slot(value, context.capabilities?.tuner?.presetNum, num => send({ kind: "tunerClear", value: num })),
  "tuner.searchUp": () => send({ kind: "tunerSearch", direction: "up" }),
  "tuner.searchDown": () => send({ kind: "tunerSearch", direction: "down" }),
  // Declarative, because the ZONE is not knowable here: recalling a favourite also routes it to a zone, and the
  // right one is whichever zone is listening to the network player. Only the controller tracks that.
  "player.netPlayer.preset": (value, context) =>
    slot(value, context.capabilities?.netusbSlots?.presets, num => send({ kind: "netusbPreset", value: num })),
  "player.netPlayer.recallRecent": (value, context) =>
    slot(value, context.capabilities?.netusbSlots?.recent, num => send({ kind: "netusbRecent", value: num })),
  "player.netPlayer.presetSave": (value, context) =>
    slot(value, context.capabilities?.netusbSlots?.presets, num =>
      run(client => client.storeNetPreset(num), "favourites"),
    ),
  "player.netPlayer.presetClear": (value, context) =>
    slot(value, context.capabilities?.netusbSlots?.presets, num =>
      run(client => client.clearNetPreset(num), "favourites"),
    ),
  "player.cd.trackSelect": value => slot(value, CD_TRACKS, num => run(client => client.selectCdTrack(num), "cd")),
  // A seek changes the network player's play info, not the zone status (review 2026-10-05, A49).
  "player.netPlayer.playPosition": value =>
    gated("number", value, SECONDS, seconds => run(client => client.setPlayPosition(Number(seconds)), "netusb")),
  // The clock and the alarm (YXC Basic Rev 1.10 §9.2/§9.4/§9.5): the per-day details follow below.
  "clock.autoSync": value =>
    gated("boolean", value, undefined, on => run(client => client.setClockAutoSync(on === true), "clock")),
  "clock.format": value =>
    value === "12h" || value === "24h"
      ? run(client => client.setClockFormat(value), "clock")
      : drop(`${shown(value)} is no time format (12h, 24h)`),
  "clock.alarm.on": value => gated("boolean", value, undefined, on => alarm({ alarm_on: on })),
  "clock.alarm.repeat": value => gated("boolean", value, undefined, on => alarm({ repeat: on })),
  "clock.alarm.volume": (value, context) =>
    gated("number", value, context.capabilities?.clock?.alarmVolumeRange, volume => alarm({ volume })),
  "clock.alarm.mode": value => gated("string", value, undefined, mode => alarm({ mode })),
};

/** The alarm days that carry details (YXC Basic Rev 1.10 §9.1: `oneday` and each weekday). */
const ALARM_DETAIL =
  /^clock\.alarm\.(oneday|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\.(enable|time|beep)$/;

/**
 * An alarm day's detail: its switch and beep, or its time — written as the datapoint shows it (`07:30`), sent as
 * `hhmm`.
 *
 * @param day the alarm day
 * @param field the detail
 * @param value the written value
 * @returns the write, or the reason
 */
function alarmDetail(day: string, field: string, value: unknown): YxcWrite {
  if (field !== "time") {
    return gated("boolean", value, undefined, on => alarm({ detail: { day, [field]: on } }));
  }
  const time = typeof value === "string" ? /^(\d{1,2}):?(\d{2})$/.exec(value.trim()) : null;
  const hh = time ? Number(time[1]) : Number.NaN;
  const mm = time ? Number(time[2]) : Number.NaN;
  return hh <= 23 && mm <= 59
    ? alarm({ detail: { day, time: `${String(hh).padStart(2, "0")}${String(mm).padStart(2, "0")}` } })
    : drop(`${shown(value)} is no time of day (hh:mm)`);
}

/** The zone writes that are not zone catalog entries, by the zone-relative datapoint. */
const ZONE_WRITES: Readonly<Record<string, WriteRule>> = {
  // Scene recall (#615) — zone-scoped, up to the scene count the zone declares (the RX-V6A: 8 for main and zone2).
  "scene.recall": (value, context, zone) =>
    slot(value, declaredZone(context, zone)?.sceneNum, num => run(client => client.recallScene(num, zone))),
  "remote.cursor": (value, context, zone) => remoteKey("remote.cursor", value, context, zone),
  "remote.menu": (value, context, zone) => remoteKey("remote.menu", value, context, zone),
  // The unified player block's transport buttons (v2.0.0): declarative, because only the controller knows which
  // source (netusb or cd) the zone is playing.
  ...Object.fromEntries(
    PLAYER_TRANSPORTS.map(action => [
      `player.${action}`,
      ((_value, _context, zone) => send({ kind: "playerTransport", zone, action })) satisfies WriteRule,
    ]),
  ),
  // Repeat and shuffle set directly (API 1.19+, audit 2026-09-29, C37) — in the codes the datapoints carry.
  "player.repeat": (value, _context, zone) => {
    const code = writableNumber(value);
    const mode = code !== undefined && Number.isInteger(code) ? REPEAT_MODES[code] : undefined;
    return mode
      ? send({ kind: "playerMode", zone, repeat: mode })
      : drop(`${shown(value)} is no repeat mode (0 off, 1 one, 2 all)`);
  },
  "player.shuffle": (value, _context, zone) =>
    gated("boolean", value, undefined, on => send({ kind: "playerMode", zone, shuffle: on ? "on" : "off" })),
};

/**
 * A zone catalog datapoint: its write kind, its value through the one gate on the grid the zone declares for it.
 *
 * @param name the zone-relative datapoint
 * @param value the written value
 * @param context the controller's knowledge — the zone's grids
 * @param zone the zone
 * @returns the write, or the reason
 */
function catalogWrite(name: string, value: unknown, context: YxcWriteContext, zone: ZoneKey): YxcWrite {
  const entry = YXC_AMP_CATALOG.find(candidate => candidate.state === name);
  if (!entry) {
    return drop("MusicCast has no command for it");
  }
  const write = entry.write;
  if (!write) {
    return drop("it is read-only on MusicCast");
  }
  const grid = entry.range ? declaredZone(context, zone)?.ranges?.[entry.range] : undefined;
  switch (write.kind) {
    case "volume":
      // Declarative: the datapoint carries what the receiver DISPLAYS while setVolume takes only the raw step
      // count. Converting between the two needs the zone's declared scale and the display mode it currently
      // reports, and both live in the controller — so the raw range is no grid here.
      return gated("number", value, undefined, num => send({ kind: "volume", zone, value: Number(num) }));
    case "equalizer":
      // The controller supplies the other two bands; the value carries only this band.
      return gated("number", value, grid, num =>
        send({ kind: "equalizer", zone, band: write.band, value: Number(num) }),
      );
    case "set":
      return gated(entry.common.type, value, grid, input =>
        send({ kind: "run", run: client => write.apply(client, input, zone) }),
      );
  }
}

/**
 * Map a unified state write to a YXC command — or to the reason nothing is sent. Every number goes through the rules
 * YNCA and XML apply (review 2026-10-05, A26): a slot is a whole number from 1 to the device's last one
 * (`slotNumber`), a number lands on the grid the device declares and is not sent outside it (`snapToGrid`).
 *
 * @param stateId the state id relative to the device (e.g. `power`, `multiroom.zone2.volume`)
 * @param value the value written to the state
 * @param context what the controller knows of the device (declarations, the tuner's band)
 * @returns the command, or why nothing is sent
 */
export function yxcWrite(stateId: string, value: unknown, context: YxcWriteContext = {}): YxcWrite {
  // Own keys only: an inherited name ("constructor") is no datapoint (review 2026-10-05, A35).
  if (Object.hasOwn(DEVICE_WRITES, stateId)) {
    return DEVICE_WRITES[stateId](value, context, "main");
  }
  const detail = ALARM_DETAIL.exec(stateId);
  if (detail) {
    return alarmDetail(detail[1], detail[2], value);
  }
  const { zone, name } = splitZone(stateId);
  const rule = Object.hasOwn(ZONE_WRITES, name) ? ZONE_WRITES[name] : undefined;
  return rule ? rule(value, context, zone) : catalogWrite(name, value, context, zone);
}

/**
 * Map a unified state write to a YXC command.
 *
 * @param stateId the state id (e.g. `power`, `multiroom.zone2.volume`)
 * @param value the value written to the state
 * @param context what the controller knows of the device (declarations, the tuner's band)
 * @returns the YXC command, or undefined when nothing is sent (see {@link yxcWrite} for the reason)
 */
export function stateToYxc(stateId: string, value: unknown, context: YxcWriteContext = {}): YxcCommand | undefined {
  return yxcWrite(stateId, value, context).command;
}
