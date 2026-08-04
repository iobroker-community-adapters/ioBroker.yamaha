import type { StateValue } from "../types";

/** A YXC amplifier command: a YamahaYXC method with its target zone and value. */
export interface YxcCommand {
  /** The YamahaYXC method to call (`power`, `setVolumeTo`, `mute`, `setInput`, `setSound`). */
  method: string;
  /** The target zone (`main`, `zone2`, …). */
  zone: string;
  /** The value to pass to the method. */
  value: boolean | number | string;
}

interface YxcStateMapping {
  /** Flat field name carrying this state in a getStatus response. */
  statusField?: string;
  /** Nested field path (e.g. `["tone_control","bass"]`) — used instead of statusField. */
  path?: string[];
  /** YamahaYXC method for a write to this state; absent means the state is read-only. */
  method?: string;
  /** Convert a written state value into the YamahaYXC argument; absent means read-only. */
  toYxc?: (value: unknown) => boolean | number | string;
  /** Convert a getStatus field value into the typed state value. */
  fromStatus: (value: unknown) => boolean | number | string;
}

/**
 * Read a mapping's raw getStatus value — flat via statusField or nested via path.
 *
 * @param status the getStatus response object
 * @param mapping the state mapping
 * @returns the raw value, or undefined if the field is absent
 */
function readStatusField(status: Record<string, unknown>, mapping: YxcStateMapping): unknown {
  if (mapping.path) {
    let value: unknown = status;
    for (const key of mapping.path) {
      if (typeof value !== "object" || value === null) {
        return undefined;
      }
      value = (value as Record<string, unknown>)[key];
    }
    return value;
  }
  return mapping.statusField !== undefined ? status[mapping.statusField] : undefined;
}

/**
 * Unified state name → YXC getStatus field, write method, and value conversions.
 * `sound_program` (getStatus) maps to the unified `soundProgram` state and the
 * `setSound` method — the method name is `setSound`, not `setSoundProgram`.
 */
const YXC_STATE_MAPPINGS: Record<string, YxcStateMapping> = {
  power: { statusField: "power", method: "power", toYxc: value => Boolean(value), fromStatus: value => value === "on" },
  volume: {
    statusField: "volume",
    method: "setVolumeTo",
    toYxc: value => Number(value),
    fromStatus: value => Number(value),
  },
  mute: { statusField: "mute", method: "mute", toYxc: value => Boolean(value), fromStatus: value => Boolean(value) },
  input: {
    statusField: "input",
    method: "setInput",
    toYxc: value => String(value),
    fromStatus: value => String(value),
  },
  soundProgram: {
    statusField: "sound_program",
    method: "setSound",
    toYxc: value => String(value),
    fromStatus: value => String(value),
  },
  enhancer: {
    statusField: "enhancer",
    method: "setEnhancer",
    toYxc: value => Boolean(value),
    fromStatus: value => Boolean(value),
  },
  pureDirect: {
    statusField: "pure_direct",
    method: "setPureDirect",
    toYxc: value => Boolean(value),
    fromStatus: value => Boolean(value),
  },
  subwooferVolume: {
    statusField: "subwoofer_volume",
    method: "setSubwooferVolumeTo",
    toYxc: value => Number(value),
    fromStatus: value => Number(value),
  },
  bass: {
    path: ["tone_control", "bass"],
    method: "setBassTo",
    toYxc: value => Number(value),
    fromStatus: value => Number(value),
  },
  treble: {
    path: ["tone_control", "treble"],
    method: "setTrebleTo",
    toYxc: value => Number(value),
    fromStatus: value => Number(value),
  },
  sleep: { statusField: "sleep", method: "sleep", toYxc: value => Number(value), fromStatus: value => Number(value) },
  dialogueLevel: { statusField: "dialogue_level", fromStatus: value => Number(value) },
  actualVolume: { path: ["actual_volume", "value"], fromStatus: value => Number(value) },
  contentsDisplay: { statusField: "contents_display", fromStatus: value => Boolean(value) },
  surroundDecoder: { statusField: "surr_decoder_type", fromStatus: value => String(value) },
  audioSelect: { statusField: "audio_select", fromStatus: value => String(value) },
  linkControl: { statusField: "link_control", fromStatus: value => String(value) },
  linkAudioDelay: { statusField: "link_audio_delay", fromStatus: value => String(value) },
  linkAudioQuality: { statusField: "link_audio_quality", fromStatus: value => String(value) },
  direct: {
    statusField: "direct",
    method: "setDirect",
    toYxc: value => Boolean(value),
    fromStatus: value => Boolean(value),
  },
  clearVoice: {
    statusField: "clear_voice",
    method: "setClearVoice",
    toYxc: value => Boolean(value),
    fromStatus: value => Boolean(value),
  },
  bassExtension: {
    statusField: "bass_extension",
    method: "setBassExtension",
    toYxc: value => Boolean(value),
    fromStatus: value => Boolean(value),
  },
  balance: {
    statusField: "balance",
    method: "setBalance",
    toYxc: value => Number(value),
    fromStatus: value => Number(value),
  },
  adaptiveDrc: { statusField: "adaptive_drc", fromStatus: value => Boolean(value) },
  adaptiveDspLevel: { statusField: "adaptive_dsp_level", fromStatus: value => Boolean(value) },
  extraBass: { statusField: "extra_bass", fromStatus: value => Boolean(value) },
  monaural: { statusField: "mono", fromStatus: value => Boolean(value) },
  surround3d: { statusField: "surround_3d", fromStatus: value => Boolean(value) },
  dialogueLift: { statusField: "dialogue_lift", fromStatus: value => Number(value) },
  dtsDialogueControl: { statusField: "dts_dialogue_control", fromStatus: value => Number(value) },
  equalizerLow: { path: ["equalizer", "low"], fromStatus: value => Number(value) },
  equalizerMid: { path: ["equalizer", "mid"], fromStatus: value => Number(value) },
  equalizerHigh: { path: ["equalizer", "high"], fromStatus: value => Number(value) },
};

/** Network-player transport buttons → YamahaYXC method (no zone/value). */
const NETUSB_TRANSPORT: Record<string, string> = {
  "netPlayer.play": "playNet",
  "netPlayer.pause": "pauseNet",
  "netPlayer.stop": "stopNet",
  "netPlayer.next": "nextNet",
  "netPlayer.prev": "prevNet",
};

/**
 * CD transport buttons → the YXC action word for `setCDPlayback`. Routed through
 * the one `setCDPlayback(action)` method (not the per-action `pauseCD()` helpers,
 * one of which sends the wrong command in the library).
 */
const CD_TRANSPORT: Record<string, string> = {
  "cd.play": "play",
  "cd.pause": "pause",
  "cd.stop": "stop",
  "cd.next": "next",
  "cd.prev": "previous",
};

const ZONE_PREFIX: Record<string, string> = { main: "", zone2: "zone2.", zone3: "zone3.", zone4: "zone4." };

/**
 * Parse a YXC getStatus response into unified amp state updates for a zone. Only
 * fields the response actually carries are emitted (presence-checked, so a
 * `mute: false` is kept), each prefixed for its zone.
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
  for (const [name, mapping] of Object.entries(YXC_STATE_MAPPINGS)) {
    const raw = readStatusField(status, mapping);
    if (raw !== undefined) {
      updates.push({ id: `${prefix}${name}`, value: mapping.fromStatus(raw) });
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
  let zone = "main";
  let name = stateId;
  const dot = stateId.indexOf(".");
  if (dot > 0) {
    zone = stateId.slice(0, dot);
    name = stateId.slice(dot + 1);
    if (ZONE_PREFIX[zone] === undefined || zone === "main") {
      return undefined;
    }
  }
  const mapping = YXC_STATE_MAPPINGS[name];
  if (!mapping || mapping.method === undefined || mapping.toYxc === undefined) {
    return undefined;
  }
  return { method: mapping.method, zone, value: mapping.toYxc(value) };
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
export function parseYxcPlayInfo(playInfo: unknown, prefix = "netPlayer"): StateValue[] {
  if (typeof playInfo !== "object" || playInfo === null) {
    return [];
  }
  const info = playInfo as Record<string, unknown>;
  const updates: StateValue[] = [];
  for (const field of ["playback", "artist", "album", "track"]) {
    const value = info[field];
    if (typeof value === "string") {
      updates.push({ id: `${prefix}.${field}`, value });
    }
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
