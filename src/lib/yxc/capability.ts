/** One zone from a YXC getFeatures response. */
export interface YxcZone {
  /** Zone id (`main`, `zone2`, …). */
  id: string;
  /** Functions the zone supports (power, volume, mute, …). */
  funcs: string[];
  /** Inputs the zone offers. */
  inputs: string[];
  /**
   * EVERY range the zone declares in `range_step`, keyed by its id (`tone_control`,
   * `subwoofer_volume`, `dialogue_level`, `equalizer`, …). Only `volume` used to be read;
   * the rest was parsed and thrown away, so bass, treble, the subwoofer trim, the dialogue
   * controls, the balance and the equalizer bands reached the user as numbers with no
   * min/max/step — no slider in a visualisation, no bound in the admin, and an out-of-range
   * write went to the device unchecked (audit 2026-09-06, measured over 25 device captures:
   * 10 of 11 declared ranges were dropped).
   */
  ranges?: Record<string, { min: number; max: number; step: number }>;
  /**
   * The zone's per-device value lists from getFeatures (`sound_program_list`,
   * `surr_decoder_type_list`, …), keyed by the unified state id they belong to. They
   * become dropdowns on the states — the device itself says which values it accepts.
   */
  valueLists?: Record<string, string[]>;
  /** How many scenes the zone offers (`scene_num`, with `scene` in func_list). */
  sceneNum?: number;
}

/** The tuner block of a YXC getFeatures response, as far as the adapter uses it. */
export interface YxcTunerFeatures {
  /** The bands the tuner offers (`am`, `fm`, `dab` from func_list). */
  bands: string[];
  /** Whether presets are one shared list (`common`) or one per band (`separate`). */
  presetType: "common" | "separate";
  /** How many preset slots the device has. */
  presetNum?: number;
  /** The frequency range the device declares per band (`range_step` ids `fm`/`am`/`dab`), when any. */
  ranges?: Record<string, { min: number; max: number; step: number }>;
}

/** The clock/alarm block of a YXC getFeatures response, as far as the adapter uses it. */
export interface YxcClockFeatures {
  /** The alarm modes the device offers (`oneday`, `weekly`). */
  alarmModes: string[];
  /** The alarm volume range, if reported. */
  alarmVolumeRange?: { min: number; max: number; step: number };
}

/** A MusicCast device's capabilities from getFeatures. */
export interface YxcCapabilities {
  /** The device's zones. */
  zones: YxcZone[];
  /** Media-player sources the device offers (netusb, tuner, cd). */
  media: string[];
  /** The netusb block's declared functions (`mc_playlist`, `play_queue`, …). */
  netusbFuncs?: string[];
  /** Whether the device reports a MusicCast-Link distribution block (getFeatures `distribution`). */
  hasDistribution?: boolean;
  /** The tuner features (bands, preset mode), when the device has a tuner. */
  tuner?: YxcTunerFeatures;
  /** The clock/alarm features, when the device has the clock block. */
  clock?: YxcClockFeatures;
  /**
   * The ranges the SYSTEM block declares (`dimmer`, …) — the device-wide counterpart of a
   * zone's {@link YxcZone.ranges}, for the states that belong to the device, not to a zone.
   */
  systemRanges?: Record<string, { min: number; max: number; step: number }>;
  /** The value lists the SYSTEM block declares (`hdmi_standby_through_list`), keyed by their id. */
  systemLists?: Record<string, string[]>;
  /** The counts the SYSTEM block declares (`speaker_pattern_num`, `video_preset_num`), keyed by their id. */
  systemCounts?: Record<string, number>;
}

// Only true media-player sources — subsystems that report play info and
// transport. The `clock` block (alarm/timer) and `dist` (MusicCast link) are
// getFeatures top-level keys too, but they are not players and get no media tree.
const MEDIA_BLOCKS = ["netusb", "tuner", "cd"];

/**
 * Keep only the string entries of an unknown array.
 *
 * @param value the value to filter
 * @returns the string entries, or an empty array
 */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Every range a getFeatures `range_step` array declares, keyed by its id.
 *
 * @param rangeStep the `range_step` array
 * @returns the declared ranges (empty when the array is missing or malformed)
 */
function parseRanges(rangeStep: unknown): Record<string, { min: number; max: number; step: number }> {
  const out: Record<string, { min: number; max: number; step: number }> = {};
  if (!Array.isArray(rangeStep)) {
    return out;
  }
  for (const entry of rangeStep) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const range = entry as Record<string, unknown>;
    if (
      typeof range.id === "string" &&
      typeof range.min === "number" &&
      typeof range.max === "number" &&
      typeof range.step === "number"
    ) {
      out[range.id] = { min: range.min, max: range.max, step: range.step };
    }
  }
  return out;
}

/**
 * One id's range — {@link parseRanges} for a single lookup.
 *
 * @param rangeStep the `range_step` array
 * @param id the range id to look for
 * @returns the range, or undefined if not reported
 */
function parseRange(rangeStep: unknown, id: string): { min: number; max: number; step: number } | undefined {
  if (!Array.isArray(rangeStep)) {
    return undefined;
  }
  for (const entry of rangeStep) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const range = entry as Record<string, unknown>;
    if (
      range.id === id &&
      typeof range.min === "number" &&
      typeof range.max === "number" &&
      typeof range.step === "number"
    ) {
      return { min: range.min, max: range.max, step: range.step };
    }
  }
  return undefined;
}

/**
 * The getFeatures zone list fields that carry a zone's allowed values, mapped to the
 * unified state id whose dropdown they feed (capture-verified field names).
 */
const ZONE_VALUE_LISTS: Readonly<Record<string, string>> = {
  sound_program_list: "soundProgram",
  surr_decoder_type_list: "sound.surroundDecoder",
  tone_control_mode_list: "sound.toneMode",
  equalizer_mode_list: "sound.equalizer.mode",
  audio_select_list: "sound.audioSelect",
  actual_volume_mode_list: "actualVolumeMode",
  link_control_list: "sound.linkControl",
  link_audio_delay_list: "sound.linkAudioDelay",
  link_audio_quality_list: "sound.linkAudioQuality",
  // The on-screen remote words THIS zone accepts. Measured over 26 captures (2026-09-09): one
  // cursor list everywhere, but three menu variants — 5, 9 and 12 words (help/home/mode and the
  // four colour keys only on some models). The shared vocabulary is the maximum, the device's
  // list is the truth; before this the dropdown offered all 12 on every zone.
  cursor_list: "remote.cursor",
  menu_list: "remote.menu",
};

/**
 * Collect a zone's per-device value lists (sound programs, decoder types, …) from its
 * getFeatures entry, keyed by the unified state id they belong to.
 *
 * @param zone the raw zone object from getFeatures
 * @returns the value lists, or undefined when the zone carries none
 */
function parseValueLists(zone: Record<string, unknown>): Record<string, string[]> | undefined {
  const lists: Record<string, string[]> = {};
  for (const [field, stateId] of Object.entries(ZONE_VALUE_LISTS)) {
    const values = stringList(zone[field]);
    if (values.length > 0) {
      lists[stateId] = values;
    }
  }
  return Object.keys(lists).length > 0 ? lists : undefined;
}

/** The tuner bands the adapter knows; func_list mixes them with non-band flags. */
const TUNER_BANDS = ["am", "fm", "dab"];

/**
 * Parse the getFeatures tuner block (bands + preset mode).
 *
 * @param tuner the raw tuner object
 * @returns the tuner features, or undefined for a malformed block
 */
function parseTunerFeatures(tuner: unknown): YxcTunerFeatures | undefined {
  if (typeof tuner !== "object" || tuner === null) {
    return undefined;
  }
  const obj = tuner as Record<string, unknown>;
  const bands = stringList(obj.func_list).filter(func => TUNER_BANDS.includes(func));
  const preset = (typeof obj.preset === "object" && obj.preset !== null ? obj.preset : {}) as Record<string, unknown>;
  // The frequency range per band (`range_step` ids `fm`, `am`, `dab`): FM 87500–108000 in 50 kHz
  // steps on 13 captured tuners (87500–107900/200 on the US model), AM 531–1611/9 or 530–1710/10.
  // Parsed and dropped until 2026-09-09 — tuner.frequency stood without any bound.
  const ranges = parseRanges(obj.range_step);
  return {
    bands,
    presetType: preset.type === "common" ? "common" : "separate",
    presetNum: typeof preset.num === "number" ? preset.num : undefined,
    ...(Object.keys(ranges).length > 0 ? { ranges } : {}),
  };
}

/**
 * Parse the getFeatures clock block (alarm modes + volume range).
 *
 * @param clock the raw clock object
 * @returns the clock features, or undefined for a malformed block
 */
function parseClockFeatures(clock: unknown): YxcClockFeatures | undefined {
  if (typeof clock !== "object" || clock === null) {
    return undefined;
  }
  const obj = clock as Record<string, unknown>;
  return {
    alarmModes: stringList(obj.alarm_mode_list),
    alarmVolumeRange: parseRange(obj.range_step, "alarm_volume"),
  };
}

/**
 * Parse a YXC getFeatures response into zones (with their functions and inputs)
 * and the media blocks the device offers. Robust against a malformed response.
 *
 * @param response the getFeatures response object
 * @returns the parsed capabilities
 */
export function parseYxcFeatures(response: unknown): YxcCapabilities {
  if (typeof response !== "object" || response === null) {
    return { zones: [], media: [], hasDistribution: false };
  }
  const obj = response as Record<string, unknown>;
  const zones: YxcZone[] = [];
  if (Array.isArray(obj.zone)) {
    for (const entry of obj.zone) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const zone = entry as Record<string, unknown>;
      if (typeof zone.id === "string") {
        zones.push({
          id: zone.id,
          funcs: stringList(zone.func_list),
          inputs: stringList(zone.input_list),
          ranges: parseRanges(zone.range_step),
          valueLists: parseValueLists(zone),
          sceneNum: typeof zone.scene_num === "number" ? zone.scene_num : undefined,
        });
      }
    }
  }
  const media = MEDIA_BLOCKS.filter(block => block in obj);
  const netusb = obj.netusb;
  const system = typeof obj.system === "object" && obj.system !== null ? (obj.system as Record<string, unknown>) : {};
  const systemLists: Record<string, string[]> = {};
  const systemCounts: Record<string, number> = {};
  for (const [key, value] of Object.entries(system)) {
    // `func_list` names functions, not values — every other `*_list` is a value list.
    if (
      key !== "func_list" &&
      key.endsWith("_list") &&
      Array.isArray(value) &&
      value.every(item => typeof item === "string")
    ) {
      systemLists[key] = value;
    } else if (key.endsWith("_num") && typeof value === "number") {
      systemCounts[key] = value;
    }
  }
  return {
    systemRanges: parseRanges(system.range_step),
    ...(Object.keys(systemLists).length > 0 ? { systemLists } : {}),
    ...(Object.keys(systemCounts).length > 0 ? { systemCounts } : {}),
    zones,
    media,
    netusbFuncs:
      typeof netusb === "object" && netusb !== null
        ? stringList((netusb as Record<string, unknown>).func_list)
        : undefined,
    hasDistribution: "distribution" in obj,
    tuner: media.includes("tuner") ? parseTunerFeatures(obj.tuner) : undefined,
    clock: "clock" in obj ? parseClockFeatures(obj.clock) : undefined,
  };
}
