import { PLAYER_DISPLAY_STATES } from "../catalog/player-block";
import { MUSICCAST_INPUT_NAMES } from "../catalog/musiccast-vocabulary";
import { channelCommon, keyedCommon, parentChannels, zoneRole, type ObjectDef } from "../catalog/types";
import { YXC_CURSOR_VALUES, YXC_MENU_VALUES } from "./remote";
import { tName, type I18nKey } from "../i18n";
import { YXC_ZONE_IDS, zonePrefix } from "./zones";
import type { YxcCapabilities, YxcZone } from "./capability";
import { YXC_AMP_CATALOG } from "./catalog";
import { ALARM_DAYS, DAB_FIELDS } from "./command-mapper";

/**
 * Build a value → label dropdown map from a device-reported value list.
 *
 * @param values the allowed values
 * @returns the states map
 */
function selfMap(values: readonly string[]): Record<string, string> {
  return Object.fromEntries(values.map(value => [value, value]));
}

/** The zones the adapter maps: main flat, zone2-4 each under multiroom. */
const ZONES: Array<{ id: string; prefix: string }> = YXC_ZONE_IDS.map(id => ({ id, prefix: zonePrefix(id) }));

/** The "now playing" block's states (v2.0.0, one per zone): read metadata + transport buttons. */
const PLAYER_STATES: Array<{
  state: string;
  common: Omit<ObjectDef["common"], "name"> & { nameKey: I18nKey; descKey?: I18nKey };
}> = [
  ...PLAYER_DISPLAY_STATES,
  // Transport buttons carry the type-detector media-player roles so a MusicCast player's
  // controls are recognised as play/pause/stop/next/prev, not generic buttons.
  { state: "play", common: { nameKey: "play", type: "boolean", role: "button.play", read: false, write: true } },
  { state: "pause", common: { nameKey: "pause", type: "boolean", role: "button.pause", read: false, write: true } },
  { state: "stop", common: { nameKey: "stop", type: "boolean", role: "button.stop", read: false, write: true } },
  { state: "next", common: { nameKey: "next", type: "boolean", role: "button.next", read: false, write: true } },
  { state: "prev", common: { nameKey: "previous", type: "boolean", role: "button.prev", read: false, write: true } },
  {
    state: "repeatToggle",
    common: {
      nameKey: "toggleRepeat",
      descKey: "descToggleRepeat",
      type: "boolean",
      role: "button",
      read: false,
      write: true,
    },
  },
  {
    state: "shuffleToggle",
    common: {
      nameKey: "toggleShuffle",
      descKey: "descToggleShuffle",
      type: "boolean",
      role: "button",
      read: false,
      write: true,
    },
  },
];

/**
 * An action datapoint: a slot number to act on (store, clear, play — a readable `level` that keeps
 * the slot last written) or a write-only key.
 *
 * @param id the state id
 * @param nameKey its name
 * @param descKey its explanation
 * @param bounds the slot range for a number; undefined for a key
 * @param bounds.min the lowest slot
 * @param bounds.max the highest slot, when declared
 * @returns the object
 */
function actionState(
  id: string,
  nameKey: I18nKey,
  descKey: I18nKey | undefined,
  bounds?: { min: number; max?: number },
): ObjectDef {
  return {
    id,
    type: "state",
    common: {
      name: tName(nameKey),
      ...(descKey ? { desc: tName(descKey) } : {}),
      ...(bounds
        ? {
            type: "number",
            // A `level` is readable by its role (repochecker E1010): it keeps the slot last written.
            role: "level",
            read: true,
            write: true,
            min: bounds.min,
            ...(bounds.max !== undefined ? { max: bounds.max } : {}),
            step: 1,
          }
        : { type: "boolean", role: "button", read: false, write: true }),
    },
  };
}

/**
 * Append a zone's "now playing" block (channel + the shared player states) under a
 * dotted prefix — once for the main zone and once per further zone.
 *
 * @param objects the object list to append to
 * @param prefix the channel/state prefix (`player`, `multiroom.zone2.player`)
 * @param settableModes whether repeat and shuffle are written directly (API 1.19+ network player)
 */
function pushPlayerBlock(objects: ObjectDef[], prefix: string, settableModes: boolean): void {
  // Named and explained from the one channel table — the hand-written name here had no explanation,
  // and MusicCast owns the folder wherever it answers (audit 2026-09-29, A26).
  objects.push({ id: prefix, type: "channel", common: channelCommon("player") });
  for (const player of PLAYER_STATES) {
    objects.push({
      id: `${prefix}.${player.state}`,
      type: "state",
      common: {
        ...keyedCommon(player.common),
        ...(settableModes && (player.state === "repeat" || player.state === "shuffle") ? { write: true } : {}),
      },
    });
  }
}

/**
 * A value list whose labels are its values — the words are said where the object is written
 * (`catalog/state-labels.ts`), in the system language.
 *
 * @param values the values the spec declares
 * @returns the list
 */
function selfLabelled(values: readonly string[]): Record<string, string> {
  return Object.fromEntries(values.map(value => [value, value]));
}

/**
 * The `range_step` id that carries a state's bounds. The names are the device's own
 * (capture-verified across 25 models); a state not listed here declares no range.
 *
 * `volume` is listed, but the entry is the FALLBACK: on a device that declares a display scale,
 * `volumePresentation` overrides it, because the bounds then follow the scale the receiver is
 * showing and no single `range_step` id can express that. A speaker, soundbar or CD receiver
 * declares no display scale and keeps the raw step range read from here.
 */
const RANGE_BY_STATE: Readonly<Record<string, string>> = {
  volume: "volume",
  "sound.bass": "tone_control",
  "sound.treble": "tone_control",
  subwooferVolume: "subwoofer_volume",
  "sound.dialogueLevel": "dialogue_level",
  "sound.dialogueLift": "dialogue_lift",
  "sound.dtsDialogueControl": "dts_dialogue_control",
  "sound.balance": "balance",
  "sound.equalizer.low": "equalizer",
  "sound.equalizer.mid": "equalizer",
  "sound.equalizer.high": "equalizer",
};

/** One `range_step` entry as a zone declares it. */
type DeclaredRange = NonNullable<YxcZone["ranges"]>[string];

/**
 * How a zone's DISPLAYED volume relates to the raw step count `setVolume` takes.
 *
 * The relation is affine, never a plain ratio: `shown = displayMin + (raw − rawMin) · slope`,
 * with the slope read from the two DECLARED STEPS. The declared ENDS do not describe the same
 * thing — every capture declares raw 0…161 in steps of 1 against a display span of 97 in steps
 * of 0.5, and a slope taken from those ends (0.6025) puts raw 66 at −40.7 dB while the device
 * reports −47.5. The step slope (0.5) is exact on all ten distinct raw/displayed pairs in the
 * bundled captures — seven models, raw 1…121, −80.0…−20.0 dB — and reproduces the declared
 * display MINIMUM at `rawMin` (raw 1 → −80.0, so raw 0 → −80.5, the declared floor).
 *
 * @param zone the zone whose declared ranges are read
 * @param mode the display mode the zone reports right now, if any
 * @returns the scale, or undefined while the zone declares no raw range, no display scale, or
 *   declares both and has not said which one it is on
 */
export function volumeScaleOf(zone: YxcZone, mode: string | undefined): VolumeScale | undefined {
  const raw = zone.ranges?.volume;
  const display = declaredDisplayRange(zone, mode);
  if (!raw || !display || raw.step === 0) {
    return undefined;
  }
  return {
    rawMin: raw.min,
    rawMax: raw.max,
    rawStep: raw.step,
    displayMin: display.range.min,
    displayStep: display.range.step,
    displayPerRawStep: display.range.step / raw.step,
  };
}

/** A zone's volume scale: the raw steps the device takes, and what they read as on its display. */
export interface VolumeScale {
  /** The quietest raw step count `setVolume` accepts, as the zone declares it. */
  rawMin: number;
  /** The loudest raw step count `setVolume` accepts, as the zone declares it. */
  rawMax: number;
  /** The grid the raw step count moves on. */
  rawStep: number;
  /** The displayed value at `rawMin`. */
  displayMin: number;
  /** The grid the displayed value moves on. */
  displayStep: number;
  /** How far one raw step moves the displayed value. */
  displayPerRawStep: number;
}

/**
 * The displayed value a raw step count reads as on a zone's scale.
 *
 * @param scale the zone's scale
 * @param raw the raw step count the device reported
 * @returns the value as the receiver displays it
 */
export function shownVolumeFor(scale: VolumeScale, raw: number): number {
  const shown = scale.displayMin + (raw - scale.rawMin) * scale.displayPerRawStep;
  // The device's own grid, so a floating-point remainder never reaches the datapoint.
  return Math.round(shown / scale.displayStep) * scale.displayStep;
}

/**
 * The raw step count a displayed value has to be sent as.
 *
 * NOT held inside the declared raw range. The zone declares two things that disagree about the
 * top — raw `0…161` in steps of 1 reaches 0.0 dB, while the decibel scale declares `…16.5`, which
 * would sit at raw 194 — and no capture in the bundle comes near either end (the loudest is raw
 * 121), so which is the real ceiling is not something the adapter knows. The datapoint's bounds
 * are the scale's own declared min and max; a value inside them is sent as asked, and if the
 * receiver will not take it, its refusal is already logged (`assertOk`).
 *
 * @param scale the zone's scale
 * @param shown the value as the datapoint carries it
 * @returns the raw step count to send
 */
export function rawVolumeFor(scale: VolumeScale, shown: number): number {
  // `displayPerRawStep` is per raw UNIT, so the division already yields raw units — snapping them
  // onto the declared grid is a rounding, not a second multiplication. Multiplying by `rawStep`
  // here counted it twice and was invisible on every captured device, all of which count in ones.
  const units = (shown - scale.displayMin) / scale.displayPerRawStep;
  return scale.rawMin + Math.round(units / scale.rawStep) * scale.rawStep;
}

/**
 * The display scale a zone is on: the one it reports, or the only one it declares.
 *
 * @param zone the zone whose declared ranges are read
 * @param mode the display mode the zone reports right now, if any
 * @returns the settled scale, or undefined when the zone declares both and reports neither
 */
function declaredDisplayRange(
  zone: YxcZone,
  mode: string | undefined,
): { kind: "db" | "numeric"; range: DeclaredRange } | undefined {
  const db = zone.ranges?.actual_volume_db;
  const numeric = zone.ranges?.actual_volume_numeric;
  // A zone that declares ONE scale can only display that one — its status does not have to say so
  // (the RX-A2070 declares `actual_volume_db` for every zone and answers a status for main only).
  const onlyScale = db && !numeric ? "db" : numeric && !db ? "numeric" : undefined;
  const shown = mode === "db" || mode === "numeric" ? mode : onlyScale;
  if (shown === "db" && db) {
    return { kind: "db", range: db };
  }
  if (shown === "numeric" && numeric) {
    return { kind: "numeric", range: numeric };
  }
  return undefined;
}

/**
 * The presentation of `volume` for the scale the device says it is DISPLAYING.
 *
 * `actual_volume.value` arrives in the form named by `actual_volume.mode` — a device set to its
 * numeric scale reports 36 where the decibel scale would read -44.5. Declaring the datapoint as dB
 * regardless was wrong on both counts: the unit lied, and js-controller warned on every poll because
 * the value sat outside the decibel bounds (measured on an RX-V6A, 2026-09-09).
 *
 * A zone that declares one scale is on that one; a zone that declares both and reports neither gets
 * the envelope of the two without a unit — never an assumed dB.
 *
 * @param zone the zone whose declared ranges are read
 * @param mode the display mode the zone reports right now, if any
 * @returns unit, explanation key and the matching bounds
 */
export function volumePresentation(
  zone: YxcZone,
  mode: string | undefined,
): { unit: string; descKey: I18nKey; range: DeclaredRange | undefined } | undefined {
  const db = zone.ranges?.actual_volume_db;
  const numeric = zone.ranges?.actual_volume_numeric;
  // A device that declares no display scale at all (speakers, soundbars, CD receivers) keeps its
  // own step scale and the bounds RANGE_BY_STATE reads for it — there is nothing to follow here.
  if (!db && !numeric) {
    return undefined;
  }
  const settled = declaredDisplayRange(zone, mode);
  if (settled) {
    // The zone's OWN declared min, max and step, as it sent them — per zone, because zones differ
    // (an RX-V685 declares 16.5 dB for main and 10.0 for zone 2). Deriving the top from the
    // declared RAW range instead would narrow the datapoint below what the device says its scale
    // reaches, on evidence that does not exist. See {@link rawVolumeFor} for the send path.
    return settled.kind === "db"
      ? { unit: "dB", descKey: "descVolumeDb", range: settled.range }
      : { unit: "", descKey: "descVolumeNumeric", range: settled.range };
  }
  // Both scales declared and none reported: the envelope of the two. Every value the device can
  // send lies inside it, and — unlike leaving the bounds out — it REPLACES what an existing
  // installation stored, because `extendObject` merges and a field the new picture drops survives.
  const dbBounds = db;
  const numericBounds = numeric;
  return {
    unit: "",
    descKey: "descVolumeNumeric",
    range:
      dbBounds && numericBounds
        ? {
            min: Math.min(dbBounds.min, numericBounds.min),
            max: Math.max(dbBounds.max, numericBounds.max),
            step: Math.min(dbBounds.step, numericBounds.step),
          }
        : undefined,
  };
}

/**
 * The network player's playback error codes, worded as YXC Basic Rev 1.00 §10.3 / Rev 1.10 §11.3
 * word them — the device's own vocabulary, shown as it is (like the speaker patterns).
 */
export const NETUSB_PLAY_ERRORS: Record<number, string> = {
  0: "No Error",
  1: "Access Error",
  2: "Playback Unavailable",
  3: "Skip Limit Reached",
  4: "Invalid Session",
  5: "High-Resolution File Not Playable at MusicCast Leaf",
  6: "User Uncredentialed",
  7: "Track Restricted by Right Holders",
  8: "Sample Restricted by Right Holders",
  9: "Genre Restricted by Streaming Credentials",
  10: "Application Restricted by Streaming Credentials",
  11: "Intent Restricted by Streaming Credentials",
  100: "Multiple Errors",
};

/**
 * A dropdown of device ids, each labelled with the name the user gave it where there is one.
 *
 * @param ids the device's ids, in its order
 * @param labels id → name (getNameText), if known
 * @returns the states map
 */
function labelled(
  ids: readonly string[],
  labels: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  return Object.fromEntries(ids.map(id => [id, labels?.[id] ?? id]));
}

/**
 * Whether a catalog entry has a copy in this zone: the device-global entries (under `multiroom.`)
 * exist once, on the main zone — never as a per-zone copy.
 *
 * @param entry the catalog entry
 * @param zoneId the zone (`main`, `zone2`, …)
 * @returns whether the zone carries the entry at all
 */
function belongsToZone(entry: (typeof YXC_AMP_CATALOG)[number], zoneId: string): boolean {
  return zoneId === "main" || !entry.state.startsWith("multiroom.");
}

/**
 * Whether the device's getFeatures declares what the entry needs: the zone function, an input,
 * or a system function (`always` needs nothing).
 *
 * @param entry the catalog entry
 * @param zone the zone as getFeatures declares it
 * @param capabilities the parsed YXC capabilities
 * @returns whether the declaration carries the entry
 */
function declares(
  entry: (typeof YXC_AMP_CATALOG)[number],
  zone: YxcCapabilities["zones"][number],
  capabilities: YxcCapabilities,
): boolean {
  if (entry.create.kind === "always") {
    return true;
  }
  if (entry.create.kind === "input") {
    return zone.inputs.length > 0;
  }
  if (entry.create.kind === "systemFunc") {
    return capabilities.systemFuncs?.includes(entry.create.func) ?? false;
  }
  return zone.funcs.includes(entry.create.func);
}

/** The RDS block of a tuner (YXC Basic §6.2 `rds`) — created only where the tuner declares `rds`. */
const RDS_STATES: Array<{ id: string; nameKey: I18nKey; descKey: I18nKey }> = [
  { id: "tuner.rdsText", nameKey: "rdsText", descKey: "descRdsText" },
  { id: "tuner.rdsTextB", nameKey: "rdsTextB", descKey: "descRdsTextB" },
  { id: "tuner.rdsService", nameKey: "rdsStation", descKey: "descRdsStation" },
  { id: "tuner.rdsProgramType", nameKey: "rdsProgrammeType", descKey: "descRdsProgramType" },
];

/** The ids of {@link RDS_STATES}. */
const RDS_IDS = RDS_STATES.map(state => state.id);

/**
 * The datapoints this device's getFeatures proves absent — a zone's catalog entry whose function the
 * zone does not declare (a zone's maximum volume without `volume`), the RDS and DAB states of a tuner
 * that does not declare them, and the clock format without `format`. getFeatures does not depend
 * on standby, so an earlier version's copy of such a datapoint is proven absent on the first start
 * (audit 2026-09-24: the upgrade from 2.12.0 left both behind).
 *
 * @param capabilities the parsed YXC capabilities
 * @returns the device-relative ids (this transport's own spelling)
 */
export function yxcDeclaredAbsent(capabilities: YxcCapabilities): string[] {
  const absent: string[] = [];
  // What the tuner and clock blocks prove absent — datapoints an earlier version created on every tuner
  // or clock (audit 2026-09-29, C42).
  const tunerFuncs = capabilities.tuner?.funcs ?? [];
  if (capabilities.tuner && !tunerFuncs.includes("rds")) {
    absent.push(...RDS_IDS);
  }
  if (capabilities.tuner?.bands.includes("dab")) {
    absent.push(...DAB_FIELDS.filter(f => f.requires && !tunerFuncs.includes(f.requires)).map(f => f.id));
  }
  if (capabilities.clock && !capabilities.clock.funcs.includes("format")) {
    absent.push("clock.format");
  }
  for (const zoneDef of ZONES) {
    const zone = capabilities.zones.find(z => z.id === zoneDef.id);
    if (!zone) {
      continue;
    }
    for (const entry of YXC_AMP_CATALOG) {
      if (belongsToZone(entry, zoneDef.id) && !declares(entry, zone, capabilities)) {
        absent.push(`${zoneDef.prefix}${entry.state}`);
      }
    }
  }
  return absent;
}

/**
 * Turn YXC capabilities into the unified object tree: main's functions as
 * top-level states, each additional zone as a channel with its own states. An
 * input state is added when the zone offers inputs. Player sources (netusb, cd)
 * and the tuner get their own channel. Only reported functions are created,
 * parents before children. States and their common come from {@link YXC_AMP_CATALOG}.
 *
 * @param capabilities the parsed YXC capabilities
 * @param current the string values each zone reports right now (zone id → state id → value), so
 *   a reported value is always in its dropdown even where the device's own list omits it
 * @returns the object definitions to create
 */
export function mapYxcToObjects(
  capabilities: YxcCapabilities,
  current?: Readonly<Record<string, Readonly<Record<string, string>>>>,
): ObjectDef[] {
  const objects: ObjectDef[] = [];
  const channels = new Set<string>();
  for (const zoneDef of ZONES) {
    const zone = capabilities.zones.find(z => z.id === zoneDef.id);
    if (!zone) {
      continue;
    }
    const entries = YXC_AMP_CATALOG.filter(
      entry => belongsToZone(entry, zoneDef.id) && declares(entry, zone, capabilities),
    );
    // A zone needs an advertised function or an input to exist — the "always" status
    // fields and the device-wide entries alone do not create a zone.
    if (!entries.some(entry => entry.create.kind !== "always" && entry.create.kind !== "systemFunc")) {
      continue;
    }
    // Every parent — the zone channel included — is created by the per-state loop and
    // named from the shared CHANNEL_NAME_KEYS table (a zone exists only with an entry).
    for (const entry of entries) {
      const fullId = `${zoneDef.prefix}${entry.state}`;
      objects.push(...parentChannels(fullId, channels));
      const keyed = keyedCommon(entry.common);
      const common: ObjectDef["common"] = { ...keyed, role: zoneRole(keyed.role, zoneDef.prefix) };
      // The device declares the bounds of its own numeric controls in `range_step`; whatever
      // it says wins over anything the catalog could guess. Only `volume` used to be read
      // (audit 2026-09-06) — bass, treble, subwoofer trim, dialogue level/lift, DTS dialogue
      // control, balance and the equalizer bands stood there as numbers without a slider.
      let range: DeclaredRange | undefined;
      // `volume` shows what the receiver's own display shows. `actual_volume.value` arrives in the
      // form named by `actual_volume.mode`, so unit and bounds follow that mode; the NAME stays
      // "Volume" either way. A device without a declared display scale falls through to its own
      // step scale below, unchanged.
      const shown =
        entry.state === "volume" ? volumePresentation(zone, current?.[zone.id]?.actualVolumeMode) : undefined;
      if (shown) {
        common.unit = shown.unit;
        common.desc = tName(shown.descKey);
        range = shown.range;
      } else if (entry.state === "advanced.maxVolume") {
        // `max_volume` arrives in raw steps (YXC Basic §5.1); the controller shows it on the scale the
        // zone's volume is shown on, so 161 next to a volume of −80.5…16.5 dB reads 0.0 dB (audit
        // 2026-09-29, C40). Unit only: the maximum's own range is not declared.
        const scale = volumePresentation(zone, current?.[zone.id]?.actualVolumeMode);
        if (scale) {
          common.unit = scale.unit;
        }
      } else {
        const rangeId = RANGE_BY_STATE[entry.state];
        range = rangeId ? zone.ranges?.[rangeId] : undefined;
      }
      if (range) {
        common.min = range.min;
        common.max = range.max;
        common.step = range.step;
      }
      // The device's own allowed-value lists (getFeatures) become dropdowns — DECLARED, so the
      // coordinator puts them on a YNCA-owned datapoint too, through the dictionary (#619):
      // the zone's inputs on the input state, sound_program_list & co on their states. What the
      // zone REPORTS right now is always selectable as well: the RX-A2070 capture lists only
      // "manual" as tone-control mode and answers "auto" — a device contradicting itself must
      // not leave the admin with a raw value nobody can pick again.
      let declared = false;
      // The value stays the device's id; the label is the name the user gave it in the MusicCast app
      // (getNameText) — an input list read "hdmi1, hdmi2, …" where the app says "Apple TV" (C24). An input
      // the app names nothing keeps its classic spelling (`net_radio` → "NET RADIO"), never the bare id.
      const labels =
        entry.state === "input"
          ? { ...MUSICCAST_INPUT_NAMES, ...capabilities.names?.inputs }
          : entry.state === "soundProgram"
            ? capabilities.names?.soundPrograms
            : undefined;
      if (entry.state === "input" && zone.inputs.length > 0) {
        common.states = labelled(zone.inputs, labels);
        declared = true;
      }
      const valueList = zone.valueLists?.[entry.state];
      if (valueList) {
        common.states = labelled(valueList, labels);
        declared = true;
      }
      const reported = current?.[zone.id]?.[entry.state];
      if (common.states && typeof reported === "string" && reported.length > 0 && !(reported in common.states)) {
        common.states = { ...common.states, [reported]: labels?.[reported] ?? reported };
      }
      objects.push({ id: fullId, type: "state", common, ...(declared ? { declaredStates: true } : {}) });
    }
    const zoneChannelHelper = (id: string, common: ObjectDef["common"]): void => {
      if (!channels.has(id)) {
        channels.add(id);
        objects.push({ id, type: "channel", common });
      }
    };
    // Scene recall (#615): the zone declares `scene` + scene_num — per zone, so a
    // Zone-2 scene is first-class (the RX-V6A declares 8 for main AND zone2).
    if (zone.funcs.includes("scene") && zone.sceneNum && zone.sceneNum > 0) {
      zoneChannelHelper(`${zoneDef.prefix}scene`, channelCommon("scene"));
      objects.push({
        id: `${zoneDef.prefix}scene.recall`,
        type: "state",
        common: {
          name: tName("recallScene"),
          desc: tName("descRecallScene"),
          type: "number",
          role: "level",
          read: true,
          write: true,
          min: 1,
          max: zone.sceneNum,
          step: 1,
        },
      });
    }
    // The on-screen remote (cursor pad + menu keys) — declared as zone functions
    // `cursor`/`menu`. The words come from the zone's own `cursor_list`/`menu_list` where the
    // firmware declares them (declared); a zone that declares none keeps the shared vocabulary,
    // which is the MAXIMUM any MusicCast device accepts (device-verified endpoints).
    if (zone.funcs.includes("cursor") || zone.funcs.includes("menu")) {
      zoneChannelHelper(`${zoneDef.prefix}remote`, channelCommon("remote"));
      const wordsFor = (
        id: "remote.cursor" | "remote.menu",
        fallback: readonly string[],
      ): { states: Record<string, string>; declared: boolean } => {
        const declaredWords = zone.valueLists?.[id];
        return declaredWords
          ? { states: selfMap(declaredWords), declared: true }
          : { states: selfMap([...fallback]), declared: false };
      };
      if (zone.funcs.includes("cursor")) {
        const words = wordsFor("remote.cursor", YXC_CURSOR_VALUES);
        objects.push({
          id: `${zoneDef.prefix}remote.cursor`,
          type: "state",
          common: {
            name: tName("cursorPad"),
            desc: tName("descCursorPad"),
            type: "string",
            role: "state",
            read: false,
            write: true,
            states: words.states,
          },
          ...(words.declared ? { declaredStates: true } : {}),
        });
      }
      if (zone.funcs.includes("menu")) {
        const words = wordsFor("remote.menu", YXC_MENU_VALUES);
        objects.push({
          id: `${zoneDef.prefix}remote.menu`,
          type: "state",
          common: {
            name: tName("menuKey"),
            desc: tName("descMenuKey"),
            type: "string",
            role: "state",
            read: false,
            write: true,
            states: words.states,
          },
          ...(words.declared ? { declaredStates: true } : {}),
        });
      }
    }
    // The audio-signal info (own endpoint, declared as `signal_info`): what the zone
    // currently decodes — format, sampling rate, bit depth, bitrate.
    if (zone.funcs.includes("signal_info")) {
      zoneChannelHelper(`${zoneDef.prefix}sound`, channelCommon("sound"));
      zoneChannelHelper(`${zoneDef.prefix}sound.signal`, channelCommon("signal"));
      const signal = (
        id: string,
        name: ioBroker.StringOrTranslated,
        type: "string" | "number",
        role: "text" | "value",
        desc?: ioBroker.StringOrTranslated,
      ): void => {
        objects.push({
          id: `${zoneDef.prefix}sound.signal.${id}`,
          type: "state",
          common: { name, ...(desc ? { desc } : {}), type, role, read: true, write: false },
        });
      };
      signal("format", tName("audioSignalFormat"), "string", "text");
      signal("sampling", tName("audioSamplingRate"), "string", "text");
      signal("bits", tName("audioBitDepth"), "string", "text");
      signal("bitrate", tName("audioBitrate"), "number", "value", tName("descAudioBitrate"));
    }
  }
  if (capabilities.media.includes("netusb") || capabilities.media.includes("cd")) {
    // ONE "now playing" block per zone (v2.0.0): the controller feeds it from
    // whichever source the zone is listening to (netusb or cd) and clears it on a
    // source switch. The source folders below keep only their genuinely own states.
    // setRepeat/setShuffle exist from API 1.19 on the network player (aiomusiccast, Home Assistant; C37).
    const settableModes =
      capabilities.media.includes("netusb") && capabilities.apiVersion !== undefined && capabilities.apiVersion >= 1.19;
    pushPlayerBlock(objects, "player", settableModes);
    for (const zone of capabilities.zones) {
      if (zone.id !== "main") {
        pushPlayerBlock(objects, `${zonePrefix(zone.id)}player`, settableModes);
      }
    }
  }
  if (capabilities.media.includes("netusb")) {
    objects.push({ id: "player.netPlayer", type: "channel", common: channelCommon("netPlayer") });
    objects.push({
      id: "player.netPlayer.preset",
      type: "state",
      common: {
        name: tName("recallPreset"),
        desc: tName("descRecallPreset"),
        type: "number",
        role: "level",
        read: true,
        write: true,
        min: 1,
        ...(capabilities.netusbSlots?.presets !== undefined ? { max: capabilities.netusbSlots.presets } : {}),
      },
    });
    // The favourites and recently-played lists (names included) plus the recall-by-number
    // for recents — the musiccast adapter's selection surface, on our tree.
    objects.push({
      id: "player.netPlayer.presets",
      type: "state",
      common: {
        name: tName("favouritesStoredPresets"),
        desc: tName("descFavouritesStoredPresets"),
        type: "string",
        role: "json",
        read: true,
        write: false,
      },
    });
    objects.push({
      id: "player.netPlayer.recent",
      type: "state",
      common: {
        name: tName("recentlyPlayed"),
        desc: tName("descRecentlyPlayed"),
        type: "string",
        role: "json",
        read: true,
        write: false,
      },
    });
    // Store and clear a favourite, jump within the track (YXC Basic Rev 1.10 §7.11/§7.12/§7.4; C38).
    const favourites = { min: 1, max: capabilities.netusbSlots?.presets };
    objects.push(actionState("player.netPlayer.presetSave", "storeFavourite", "descStoreFavourite", favourites));
    objects.push(actionState("player.netPlayer.presetClear", "clearFavourite", "descClearFavourite", favourites));
    const jump = actionState("player.netPlayer.playPosition", "jumpToPosition", "descJumpToPosition", { min: 0 });
    objects.push({ ...jump, common: { ...jump.common, unit: "s" } });
    objects.push({
      id: "player.netPlayer.recallRecent",
      type: "state",
      common: {
        name: tName("recallRecentlyPlayedNumber"),
        desc: tName("descRecallRecentlyPlayedNumber"),
        type: "number",
        role: "level",
        read: true,
        write: true,
        min: 1,
        ...(capabilities.netusbSlots?.recent !== undefined ? { max: capabilities.netusbSlots.recent } : {}),
      },
    });
    // What the network player reports about the current playback — carried by the push only (YXC
    // Basic §10.3/§11.3), seeded to "no error / no message" at every connect (audit 2026-09-24, C18).
    objects.push({
      id: "player.netPlayer.playError",
      type: "state",
      common: {
        name: tName("playbackError"),
        desc: tName("descPlaybackError"),
        type: "number",
        role: "value",
        read: true,
        write: false,
        states: NETUSB_PLAY_ERRORS,
      },
    });
    // The error codes in words — every one of them when the device reports several at once (C40).
    objects.push({
      id: "player.netPlayer.playErrorText",
      type: "state",
      common: {
        name: tName("playbackErrorText"),
        desc: tName("descPlaybackErrorText"),
        type: "string",
        role: "text",
        read: true,
        write: false,
      },
    });
    objects.push({
      id: "player.netPlayer.playMessage",
      type: "state",
      common: {
        name: tName("playbackMessage"),
        desc: tName("descPlaybackMessage"),
        type: "string",
        role: "text",
        read: true,
        write: false,
      },
    });
    // MusicCast playlists and the play queue — declared in the netusb func_list.
    // Read-only surfaces: no write path for them is documented anywhere, and blind
    // writes are exactly what this adapter no longer does.
    if (capabilities.netusbFuncs?.includes("mc_playlist")) {
      objects.push({
        id: "player.netPlayer.playlists",
        type: "state",
        common: {
          name: tName("musiccastPlaylists"),
          desc: tName("descMusiccastPlaylists"),
          type: "string",
          role: "json",
          read: true,
          write: false,
        },
      });
    }
    if (capabilities.netusbFuncs?.includes("play_queue")) {
      objects.push({
        id: "player.netPlayer.queue",
        type: "state",
        common: {
          name: tName("playQueue"),
          desc: tName("descPlayQueue"),
          type: "string",
          role: "json",
          read: true,
          write: false,
        },
      });
      // Its length and position as values of their own — the list shows the first eight (C30).
      for (const [id, nameKey, descKey] of [
        ["player.netPlayer.queueLength", "queueLength", "descQueueLength"],
        ["player.netPlayer.queuePosition", "queuePosition", "descQueuePosition"],
      ] as const) {
        objects.push({
          id,
          type: "state",
          common: {
            name: tName(nameKey),
            desc: tName(descKey),
            type: "number",
            role: "value",
            read: true,
            write: false,
          },
        });
      }
    }
  }
  if (capabilities.media.includes("cd")) {
    // Drive-own states only — what the disc is PLAYING shows in the flat block above.
    objects.push({ id: "player.cd", type: "channel", common: channelCommon("cd") });
    objects.push(actionState("player.cd.trackSelect", "playTrackNumber", "descPlayTrackNumber", { min: 1, max: 512 }));
    objects.push({
      id: "player.cd.tray",
      type: "state",
      common: {
        name: tName("toggleTray"),
        desc: tName("descToggleTray"),
        type: "boolean",
        role: "button",
        read: false,
        write: true,
      },
    });
    objects.push({
      id: "player.cd.trackNumber",
      type: "state",
      // YXC Basic §8.1: -1 while no track plays — shown as 0, no track number (audit 2026-09-29, C40).
      common: {
        name: tName("trackNumber"),
        desc: tName("descTrackNumber"),
        type: "number",
        role: "value",
        min: 0,
        read: true,
        write: false,
      },
    });
    objects.push({
      id: "player.cd.totalTracks",
      type: "state",
      common: { name: tName("totalTracks"), type: "number", role: "value", read: true, write: false },
    });
    objects.push({
      id: "player.cd.discTime",
      type: "state",
      common: { name: tName("discTime"), type: "number", unit: "s", role: "value", read: true, write: false },
    });
    objects.push({
      id: "player.cd.deviceStatus",
      type: "state",
      common: {
        name: tName("driveStatus"),
        desc: tName("descDriveStatus"),
        type: "string",
        role: "state",
        read: true,
        write: false,
      },
    });
  }
  if (capabilities.media.includes("tuner")) {
    objects.push({ id: "tuner", type: "channel", common: channelCommon("tuner") });
    const bandCommon: ObjectDef["common"] = {
      name: tName("band"),
      type: "string",
      role: "state",
      read: true,
      write: true,
    };
    const bands = capabilities.tuner?.bands ?? [];
    const tunerFuncs = capabilities.tuner?.funcs ?? [];
    if (bands.length > 0) {
      bandCommon.states = selfMap(bands);
    }
    objects.push({ id: "tuner.band", type: "state", common: bandCommon });
    // Frequency in kHz — FM/AM/DAB all report kHz in getPlayInfo (FM 100900 =
    // 100.9 MHz, AM 1080, DAB 180064), verified against real device captures. The bounds are
    // the ENVELOPE of the ranges the device declares per band (AM 531 kHz … FM 108000 kHz):
    // one datapoint serves every band, so it can carry the outer limits but no single step
    // (FM steps 50 kHz, 200 in the US; AM 9 or 10).
    //
    // ⚠️ The envelope needs a range for EVERY band the device says it has. A DAB receiver
    // declares `func_list: [fm, rds, dab]` and a `range_step` for `fm` alone — measured on all
    // three DAB captures (RX-A2070, RX-V6A, CD-NT670D) — and then reports 180064 kHz from the
    // DAB band into this one datapoint. Taking the FM envelope there narrowed the datapoint
    // below what the device itself sends, and js-controller warned on every poll. An incomplete
    // declaration is no declaration: the datapoint stays unbounded rather than carry a limit the
    // device contradicts (same rule as `volume` — the declared range is taken, never derived).
    const frequencyCommon: ObjectDef["common"] = {
      name: tName("frequency"),
      type: "number",
      unit: "kHz",
      role: "level",
      read: true,
      write: true,
    };
    const declaredRanges = capabilities.tuner?.ranges ?? {};
    const bandRanges = bands.map(band => declaredRanges[band]);
    if (bands.length > 0 && bandRanges.every(range => range !== undefined)) {
      frequencyCommon.min = Math.min(...bandRanges.map(range => range.min));
      frequencyCommon.max = Math.max(...bandRanges.map(range => range.max));
    }
    objects.push({ id: "tuner.frequency", type: "state", common: frequencyCommon });
    // RDS only where the tuner declares it (YXC Basic §4.2 tuner func_list `rds`; §6.2 "Available only
    // when RDS is valid") — an ISX-18D has none, and its four RDS datapoints stood empty (audit
    // 2026-09-29, C42).
    if (tunerFuncs.includes("rds")) {
      for (const rds of RDS_STATES) {
        objects.push({
          id: rds.id,
          type: "state",
          common: {
            name: tName(rds.nameKey),
            desc: tName(rds.descKey),
            type: "string",
            role: "text",
            read: true,
            write: false,
          },
        });
      }
    }
    // The stored-station surface: recall by number (writable), the active slot read back
    // from play info, up/down stepping, and the stored lists (with what the device knows
    // about each slot) as JSON — the selection surface the musiccast adapter offered.
    const presetCommon: ObjectDef["common"] = {
      name: tName("presetRecallByNumber"),
      desc: tName("descPresetRecallByNumber"),
      type: "number",
      role: "level",
      read: true,
      write: true,
      min: 0,
    };
    if (capabilities.tuner?.presetNum) {
      presetCommon.max = capabilities.tuner.presetNum;
    }
    objects.push({ id: "tuner.preset", type: "state", common: presetCommon });
    const stations = { min: 1, max: capabilities.tuner?.presetNum };
    objects.push(actionState("tuner.presetSave", "storeStationPreset", "descStoreStationPreset", stations));
    objects.push(actionState("tuner.presetClear", "clearStationPreset", "descClearStationPreset", stations));
    objects.push(actionState("tuner.searchUp", "searchNextStation", "descSearchNextStation"));
    objects.push(actionState("tuner.searchDown", "searchPreviousStation", "descSearchPreviousStation"));
    // `switchPreset` exists from API 1.17 on (YXC Basic §6.6); an older device refused every press.
    if (capabilities.apiVersion === undefined || capabilities.apiVersion >= 1.17) {
      objects.push({
        id: "tuner.presetUp",
        type: "state",
        common: { name: tName("nextPreset"), type: "boolean", role: "button", read: false, write: true },
      });
      objects.push({
        id: "tuner.presetDown",
        type: "state",
        common: { name: tName("previousPreset"), type: "boolean", role: "button", read: false, write: true },
      });
    }
    objects.push({
      id: "tuner.presets",
      type: "state",
      common: {
        name: tName("storedPresets"),
        desc: tName("descStoredPresets"),
        type: "string",
        role: "json",
        read: true,
        write: false,
      },
    });
    objects.push({
      id: "tuner.tuned",
      type: "state",
      common: {
        name: tName("tuned"),
        desc: tName("descTunedToAStation"),
        type: "boolean",
        role: "indicator",
        read: true,
        write: false,
      },
    });
    objects.push({
      id: "tuner.audioMode",
      type: "state",
      common: {
        name: tName("audioMode"),
        desc: tName("descAudioMode"),
        type: "string",
        role: "state",
        read: true,
        write: false,
        // YXC Basic §6.2 `audio_mode`; none on AM.
        states: selfLabelled(["mono", "stereo"]),
      },
    });
    if (bands.includes("dab")) {
      objects.push({ id: "tuner.dab", type: "channel", common: channelCommon("dab") });
      for (const field of DAB_FIELDS) {
        if (field.requires && !tunerFuncs.includes(field.requires)) {
          continue;
        }
        objects.push({
          id: field.id,
          type: "state",
          common: {
            name: tName(field.nameKey),
            ...(field.descKey ? { desc: tName(field.descKey) } : {}),
            type: field.type,
            role: field.role ?? (field.type === "boolean" ? "indicator" : field.type === "number" ? "value" : "text"),
            ...(field.unit ? { unit: field.unit } : {}),
            ...(field.min !== undefined ? { min: field.min } : {}),
            ...(field.max !== undefined ? { max: field.max } : {}),
            ...(field.states ? { states: selfLabelled(field.states) } : {}),
            read: true,
            write: false,
          },
        });
      }
      // A DAB station is chosen by service, not by frequency (YXC Basic §6.15; audit 2026-09-24, C17).
      objects.push({
        id: "tuner.dab.serviceUp",
        type: "state",
        common: { name: tName("nextDabService"), type: "boolean", role: "button", read: false, write: true },
      });
      objects.push({
        id: "tuner.dab.serviceDown",
        type: "state",
        common: { name: tName("previousDabService"), type: "boolean", role: "button", read: false, write: true },
      });
    }
  }
  if (capabilities.clock) {
    // The clock/alarm block of the desk-audio/clock models. The switches, the volume, the mode and each
    // day's enable/time/beep are written through the specification's setters (YXC Basic Rev 1.10
    // §9.2/§9.4/§9.5; audit 2026-09-29, C38); the playback choice of an alarm stays read-only.
    objects.push({ id: "clock", type: "channel", common: channelCommon("clock") });
    objects.push({
      id: "clock.autoSync",
      type: "state",
      common: {
        name: tName("automaticTimeSync"),
        desc: tName("descAutomaticTimeSync"),
        type: "boolean",
        role: "switch",
        read: true,
        // setAutoSync: "Available only when date_and_time exists in clock - func_list" (§9.2).
        write: capabilities.clock.funcs.includes("date_and_time"),
      },
    });
    // Only where the clock block declares it (YXC Basic §4.2 clock func_list) — a WX-021 has no format
    // setting, and the datapoint stood empty for good (audit 2026-09-29, C42).
    if (capabilities.clock.funcs.includes("format")) {
      objects.push({
        id: "clock.format",
        type: "state",
        common: {
          name: tName("clockFormat"),
          desc: tName("descClockFormat"),
          type: "string",
          role: "state",
          read: true,
          write: true,
          states: { "12h": "12h", "24h": "24h" },
        },
      });
    }
    objects.push({ id: "clock.alarm", type: "channel", common: channelCommon("alarm") });
    objects.push({
      id: "clock.alarm.on",
      type: "state",
      common: { name: tName("alarmArmed"), type: "boolean", role: "switch", read: true, write: true },
    });
    const volumeCommon: ObjectDef["common"] = {
      name: tName("alarmVolume"),
      type: "number",
      role: "level",
      read: true,
      write: true,
    };
    if (capabilities.clock.alarmVolumeRange) {
      volumeCommon.min = capabilities.clock.alarmVolumeRange.min;
      volumeCommon.max = capabilities.clock.alarmVolumeRange.max;
      volumeCommon.step = capabilities.clock.alarmVolumeRange.step;
    }
    objects.push({ id: "clock.alarm.volume", type: "state", common: volumeCommon });
    objects.push({
      id: "clock.alarm.fadeInterval",
      type: "state",
      common: {
        name: tName("fadeInTime"),
        desc: tName("descFadeInTime"),
        type: "number",
        unit: "s",
        role: "value",
        read: true,
        write: false,
      },
    });
    objects.push({
      id: "clock.alarm.fadeType",
      type: "state",
      common: {
        name: tName("fadeType"),
        desc: tName("descFadeType"),
        type: "number",
        role: "value",
        read: true,
        write: false,
      },
    });
    objects.push({
      id: "clock.alarm.mode",
      type: "state",
      common: {
        name: tName("alarmMode"),
        type: "string",
        role: "state",
        read: true,
        write: true,
        states: Object.fromEntries(capabilities.clock.alarmModes.map(mode => [mode, mode])),
      },
    });
    // YXC Basic §9.1: `alarm.repeat` — whether the one-day alarm repeats; not snooze, which the clock
    // block declares on its own (audit 2026-09-29, C35).
    objects.push({
      id: "clock.alarm.repeat",
      type: "state",
      common: {
        name: tName("alarmRepeat"),
        desc: tName("descAlarmRepeat"),
        type: "boolean",
        role: "switch",
        read: true,
        write: true,
      },
    });
    const snooze = capabilities.clock.funcs.includes("snooze");
    const detailChannels = ["oneday", ...(capabilities.clock.alarmModes.includes("weekly") ? ALARM_DAYS : [])];
    for (const channel of detailChannels) {
      // The weekday channels are named by the device; only the fixed one-day channel translates.
      const label: ioBroker.StringOrTranslated =
        channel === "oneday" ? tName("oneDayAlarm") : channel.charAt(0).toUpperCase() + channel.slice(1);
      objects.push({ id: `clock.alarm.${channel}`, type: "channel", common: { name: label } });
      const detail = (
        id: string,
        name: ioBroker.StringOrTranslated,
        type: "boolean" | "number" | "string",
        role: string,
        write = false,
      ): void => {
        objects.push({
          id: `clock.alarm.${channel}.${id}`,
          type: "state",
          common: { name, type, role, read: true, write },
        });
      };
      detail("enable", tName("enabled"), "boolean", "switch", true);
      detail("time", tName("alarmTime"), "string", "text", true);
      detail("beep", tName("beep"), "boolean", "switch", true);
      detail("playbackType", tName("playbackType"), "string", "state");
      detail("resumeInput", tName("resumeInput"), "string", "state");
      detail("presetType", tName("presetType"), "string", "state");
      detail("presetNumber", tName("presetNumber"), "number", "value");
      // YXC Basic §9.1: `preset.netusb_info` (input, text) and `preset.tuner_info` (band, frequency in kHz)
      // (audit 2026-09-29, C34).
      detail("presetInput", tName("presetSource"), "string", "state");
      detail("presetName", tName("presetName"), "string", "text");
      detail("presetBand", tName("presetBand"), "string", "state");
      objects.push({
        id: `clock.alarm.${channel}.presetFrequency`,
        type: "state",
        common: {
          name: tName("presetFrequency"),
          desc: tName("descPresetFrequency"),
          type: "number",
          unit: "kHz",
          role: "value",
          read: true,
          write: false,
        },
      });
      if (snooze) {
        objects.push({
          id: `clock.alarm.${channel}.snooze`,
          type: "state",
          common: {
            name: tName("snooze"),
            desc: tName("descSnooze"),
            type: "boolean",
            role: "indicator",
            read: true,
            write: false,
          },
        });
      }
    }
  }
  if (capabilities.hasDistribution) {
    // The MusicCast-Link states live in their own folder so the tree itself tells the
    // scope: directly under multiroom = all zones of this device, group = linked devices.
    // Both channels already exist: the main zone's always-created
    // multiroom.group.streamingEnabled state brought them in through the parent loop.
    const distState = (
      id: string,
      name: ioBroker.StringOrTranslated,
      role: string,
      desc?: ioBroker.StringOrTranslated,
      values?: readonly string[],
    ): void => {
      objects.push({
        id: `multiroom.group.${id}`,
        type: "state",
        common: {
          name,
          ...(desc ? { desc } : {}),
          type: "string",
          role,
          read: true,
          write: false,
          ...(values ? { states: selfLabelled(values) } : {}),
        },
      });
    };
    // YXC Advanced §5.1: `role` server / client / none, `server_zone` main to zone4.
    distState("role", tName("roleServerClient"), "state", tName("descRoleServerClient"), ["server", "client", "none"]);
    distState("id", tName("groupID"), "text", tName("descGroupID"));
    // YXC Advanced §5.1 — reported by the server from API 2.00 on; building a group can take up to
    // three minutes (§9.1.8-3), and this is how long (audit 2026-09-24, C7).
    objects.push({
      id: "multiroom.group.status",
      type: "state",
      common: {
        name: tName("groupStatus"),
        desc: tName("descGroupStatus"),
        type: "string",
        role: "state",
        read: true,
        write: false,
        states: { building: "building", working: "working", deleting: "deleting" },
      },
    });
    // Writable (YXC Advanced §5.6, POST `setGroupName`); the device keeps it in volatile memory only.
    objects.push({
      id: "multiroom.group.name",
      type: "state",
      common: {
        name: tName("groupName"),
        desc: tName("descGroupName"),
        type: "string",
        role: "text",
        read: true,
        write: true,
      },
    });
    distState("serverZone", tName("serverZoneFeedsTheGroup"), "state", undefined, ["main", "zone2", "zone3", "zone4"]);
    distState("linkedDevices", tName("linkedDevices"), "json", tName("descLinkedDevices"));
    objects.push({
      id: "multiroom.group.leave",
      type: "state",
      common: {
        name: tName("leaveGroup"),
        desc: tName("descLeaveGroup"),
        type: "boolean",
        role: "button",
        read: false,
        write: true,
      },
    });
    objects.push({
      id: "multiroom.group.linkDevice",
      type: "state",
      common: {
        name: tName("linkADeviceItsIP"),
        desc: tName("descLinkADeviceItsIP"),
        type: "string",
        role: "text",
        read: false,
        write: true,
      },
    });
  }
  return objects;
}
