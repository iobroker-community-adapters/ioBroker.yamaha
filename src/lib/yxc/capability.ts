/** One zone from a YXC getFeatures response. */
export interface YxcZone {
  /** Zone id (`main`, `zone2`, …). */
  id: string;
  /** Functions the zone supports (power, volume, mute, …). */
  funcs: string[];
  /** Inputs the zone offers. */
  inputs: string[];
  /** The zone's raw volume range (min/max/step), if the device reports one. */
  volumeRange?: { min: number; max: number; step: number };
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
 * Extract one id's range from a getFeatures `range_step` array.
 *
 * @param rangeStep the `range_step` array
 * @param id the range id to look for (`volume`, `alarm_volume`, …)
 * @returns the range (min/max/step), or undefined if not reported
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
  return {
    bands,
    presetType: preset.type === "common" ? "common" : "separate",
    presetNum: typeof preset.num === "number" ? preset.num : undefined,
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
          volumeRange: parseRange(zone.range_step, "volume"),
          valueLists: parseValueLists(zone),
          sceneNum: typeof zone.scene_num === "number" ? zone.scene_num : undefined,
        });
      }
    }
  }
  const media = MEDIA_BLOCKS.filter(block => block in obj);
  const netusb = obj.netusb;
  return {
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
