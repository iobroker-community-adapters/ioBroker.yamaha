import type { ObjectDef } from "../catalog/types";
import type { I18nKey } from "../i18n";
import type { YxcClientLike } from "./client-contract";
import { readNumber, readSwitch, readWord, type YxcValue } from "./values";

/**
 * How a write of a zone datapoint reaches the device:
 * - `set`: the entry's setter, called with the value the one gate made of the written one (`gateValue`: a switch's
 *   boolean, a number on the zone's declared grid, a word) — no coercion of its own, so no `Boolean("false")`;
 * - `volume`: the datapoint carries what the receiver DISPLAYS while setVolume takes the raw step count — only the
 *   controller knows the zone's scale;
 * - `equalizer`: the device sets the three bands in one call — the controller supplies the other two.
 */
export type YxcAmpWrite =
  | { kind: "set"; apply: (client: YxcClientLike, value: YxcValue, zone: string) => Promise<unknown> }
  | { kind: "volume" }
  | { kind: "equalizer"; band: "low" | "mid" | "high" };

/**
 * The single source for YXC (MusicCast) amplifier states: one entry per unified
 * state carries BOTH its ioBroker object (`common`) AND its getStatus read + write
 * mapping — replacing the former `YXC_STATES` (object-mapper) / `YXC_STATE_MAPPINGS`
 * (command-mapper) pair that had to be kept in sync by hand. The object-mapper reads
 * `create`/`common`/`range`/`list`/`scale`, the command-mapper reads `read`/`fromStatus`/`write`.
 *
 * Value types are verified against the bundled device captures
 * (`yamaha-yxc-nodejs/lib/data/*.json`): e.g. `adaptive_drc`/`extra_bass` are real
 * booleans, `sleep` is minutes, `link_control`/`surr_decoder_type` are strings.
 *
 * What a datapoint needs from the device's declarations stands on its entry: the `range_step` id of its bounds,
 * the `*_list` field of its values, its `disable_flags` bit, the scale it is shown on. They stood in five side
 * tables keyed by id strings — a range table and a list table in two modules, the equalizer bands, the disable
 * bits in the controller and the volume special cases (review 2026-10-05, DRY).
 */
export interface YxcAmpEntry {
  /** Unified state id, relative to the zone prefix. */
  state: string;
  /**
   * ioBroker common for the object, carrying its name as a translation KEY: this catalog is a
   * module-level constant, so the object-mapper resolves the key when it creates the object.
   */
  common: Omit<ObjectDef["common"], "name"> & { nameKey: I18nKey; descKey?: I18nKey };
  /**
   * When the state is created: `func` = only if the zone's func_list advertises that
   * feature key; `always` = a core status field created for every active zone; `input` = only if
   * the zone offers inputs (from input_list, not func_list).
   */
  create: { kind: "func"; func: string } | { kind: "always" } | { kind: "input" };
  /**
   * Where to read the value in a getStatus response: a flat field, or a nested path with an
   * optional flat fallback for devices that do not report the nested one (`volume` reads the
   * displayed value where the device has one and its raw step count otherwise).
   */
  read: { field: string } | { path: string[]; fallbackField?: string };
  /** Convert a raw getStatus value into the typed state value — `null` where the answer names none. */
  fromStatus: (value: unknown) => boolean | number | string | null;
  /**
   * The `range_step` id that declares the value's bounds and step (capture-verified across 25 models): the
   * object's min/max/step, and the grid a written number is put on.
   */
  range?: string;
  /** The getFeatures field that lists the values the zone takes (`sound_program_list`) — its dropdown. */
  list?: string;
  /** The `disable_flags` bit (YXC Basic §5.1) the zone sets while it cannot operate the function. */
  disableBit?: number;
  /**
   * The scale the value is shown on: `volume` = the zone's display scale (`volumePresentation` sets unit and
   * bounds), `volumeLimit` = the unit of that scale (the maximum volume arrives in raw steps and is shown on it).
   */
  scale?: "volume" | "volumeLimit";
  /**
   * Write mapping — absent means the state is read-only (`common.write: false`). The entry
   * calls the client DIRECTLY, so there is no method-name string to keep in sync with a
   * dispatch switch and no "unknown command" runtime path.
   */
  write?: YxcAmpWrite;
}

/**
 * A switch's setter — the gate hands it a boolean.
 *
 * @param set the client call
 * @returns the write mapping
 */
const onOff = (set: (client: YxcClientLike, on: boolean, zone: string) => Promise<unknown>): YxcAmpWrite => ({
  kind: "set",
  apply: (client, value, zone) => set(client, value === true, zone),
});

/**
 * A number's setter — the gate hands it a number on the zone's grid.
 *
 * @param set the client call
 * @returns the write mapping
 */
const numeric = (set: (client: YxcClientLike, value: number, zone: string) => Promise<unknown>): YxcAmpWrite => ({
  kind: "set",
  apply: (client, value, zone) => set(client, Number(value), zone),
});

/**
 * A word's setter — the gate hands it trimmed text.
 *
 * @param set the client call
 * @returns the write mapping
 */
const word = (set: (client: YxcClientLike, value: string, zone: string) => Promise<unknown>): YxcAmpWrite => ({
  kind: "set",
  apply: (client, value, zone) => set(client, String(value), zone),
});

/**
 * MusicCast's tone/equalizer numbers are DEVICE STEPS, not decibels — measured, not assumed:
 * 19 of the bundled device captures declare `tone_control` as −12…+12 in steps of 1, which is
 * 25 steps over exactly the range the YNCA specification calls −6…+6 dB in steps of 0.5 (also
 * 25 steps). The MusicCast number is therefore half-decibels, and labelling it "dB" showed the
 * user twice the value the receiver applies. The bounds now come from the device's own
 * `range_step` (see the object mapper), so the datapoint says what the device accepts without
 * claiming a unit nobody documented. Where a receiver also speaks YNCA or XML, the owner policy
 * hands these states to the transport whose scale IS documented in decibels.
 */

/**
 * The unified YXC amplifier catalog — object + read/write mapping in one list.
 *
 * Writable where a setter is documented: YXC Basic Rev 1.10 §5 (dialogue level/lift, 3D surround,
 * tone and equalizer MODE — both parameters optional, §5.13/§5.14), YXC Advanced §4.1–4.3 (the three
 * Link settings); and the four setters Home Assistant runs through aiomusiccast although no
 * specification names them (DTS dialogue control, extra bass, adaptive DRC, surround decoder).
 * Until 2026-09-24 these stood read-only, their comments saying "no setter documented" (audit, C8).
 * Values come from the zone's own lists and `range_step`; a value the device refuses is read back.
 */
export const YXC_AMP_CATALOG: YxcAmpEntry[] = [
  {
    state: "power",
    common: { nameKey: "power", type: "boolean", role: "switch.power", read: true, write: true },
    create: { kind: "func", func: "power" },
    read: { field: "power" },
    fromStatus: value => (typeof value === "string" ? value === "on" : null),
    write: onOff((c, on, z) => c.power(on, z)),
  },
  {
    state: "volume",
    common: {
      nameKey: "volume",
      descKey: "descVolume",
      type: "number",
      role: "level.volume",
      read: true,
      write: true,
    },
    create: { kind: "func", func: "volume" },
    // The displayed value where the device reports one (`actual_volume`), the raw step count
    // otherwise. A receiver shows its own scale — decibels or plain numbers — and that is what
    // belongs in the datapoint; speakers and soundbars report no display scale and keep their
    // step count. The object's unit and bounds follow in `volumePresentation`.
    read: { path: ["actual_volume", "value"], fallbackField: "volume" },
    fromStatus: readNumber,
    // The raw step range is the FALLBACK bounds: a zone that declares a display scale is shown on it
    // (`volumePresentation`); a speaker, soundbar or CD receiver declares none and keeps its raw steps.
    range: "volume",
    scale: "volume",
    disableBit: 0b1,
    // Declarative: the value has to be translated from the displayed scale into the raw step count setVolume
    // expects, and only the controller knows the zone's scale.
    write: { kind: "volume" },
  },
  {
    state: "mute",
    common: { nameKey: "mute", type: "boolean", role: "media.mute", read: true, write: true },
    create: { kind: "func", func: "mute" },
    read: { field: "mute" },
    fromStatus: readSwitch,
    write: onOff((c, on, z) => c.mute(on, z)),
    disableBit: 0b10,
  },
  {
    state: "input",
    common: { nameKey: "input", type: "string", role: "media.input", read: true, write: true },
    create: { kind: "input" },
    read: { field: "input" },
    fromStatus: readWord,
    write: word((c, v, z) => c.setInput(v, z)),
  },
  {
    state: "soundProgram",
    common: {
      nameKey: "soundProgram",
      descKey: "descSoundProgram",
      type: "string",
      role: "state",
      read: true,
      write: true,
    },
    create: { kind: "func", func: "sound_program" },
    read: { field: "sound_program" },
    fromStatus: readWord,
    write: word((c, v, z) => c.setSound(v, z)),
    list: "sound_program_list",
  },
  {
    state: "sound.enhancer",
    common: { nameKey: "enhancer", descKey: "descEnhancer", type: "boolean", role: "switch", read: true, write: true },
    create: { kind: "func", func: "enhancer" },
    read: { field: "enhancer" },
    fromStatus: readSwitch,
    write: onOff((c, on, z) => c.setEnhancer(on, z)),
  },
  {
    state: "sound.pureDirect",
    common: {
      nameKey: "pureDirect",
      descKey: "descPureDirect",
      type: "boolean",
      role: "switch",
      read: true,
      write: true,
    },
    create: { kind: "func", func: "pure_direct" },
    read: { field: "pure_direct" },
    fromStatus: readSwitch,
    write: onOff((c, on, z) => c.setPureDirect(on, z)),
  },
  {
    state: "subwooferVolume",
    common: {
      nameKey: "subwooferTrim",
      descKey: "descSubwooferTrim",
      type: "number",
      // No unit: MusicCast counts the subwoofer trim in the device's own steps, like the tone controls
      // — "dB" claimed a scale nobody documented. Written as "" rather than left out, because an
      // existing object keeps a unit that is merely omitted (extendObject merges; audit 2026-09-24, C9).
      unit: "",
      role: "level",
      read: true,
      write: true,
    },
    create: { kind: "func", func: "subwoofer_volume" },
    read: { field: "subwoofer_volume" },
    fromStatus: readNumber,
    write: numeric((c, v, z) => c.setSubwooferVolumeTo(v, z)),
    range: "subwoofer_volume",
  },
  {
    state: "sound.bass",
    // unit "": an installation from before 2.5.0 still carries "dB" here (see subwooferVolume, C9).
    common: {
      nameKey: "bass",
      descKey: "descBass",
      type: "number",
      unit: "",
      role: "level.bass",
      read: true,
      write: true,
    },
    create: { kind: "func", func: "tone_control" },
    read: { path: ["tone_control", "bass"] },
    fromStatus: readNumber,
    write: numeric((c, v, z) => c.setBassTo(v, z)),
    range: "tone_control",
  },
  {
    state: "sound.toneMode",
    common: {
      nameKey: "toneControlMode",
      descKey: "descToneControlMode",
      type: "string",
      role: "state",
      read: true,
      write: true,
    },
    create: { kind: "func", func: "tone_control" },
    read: { path: ["tone_control", "mode"] },
    fromStatus: readWord,
    write: word((c, v, z) => c.setToneMode(v, z)),
    list: "tone_control_mode_list",
  },
  {
    state: "sound.treble",
    common: {
      nameKey: "treble",
      descKey: "descTreble",
      type: "number",
      unit: "",
      role: "level.treble",
      read: true,
      write: true,
    },
    create: { kind: "func", func: "tone_control" },
    read: { path: ["tone_control", "treble"] },
    fromStatus: readNumber,
    write: numeric((c, v, z) => c.setTrebleTo(v, z)),
    range: "tone_control",
  },
  {
    state: "sleep",
    common: {
      nameKey: "sleepTimer",
      descKey: "descSleepTimer",
      type: "number",
      unit: "min",
      role: "level.timer.sleep",
      read: true,
      write: true,
      // The five values YXC Basic §5.1/§5.4 declares, as a HINT for the dropdown — a value outside
      // them still goes to the device, which decides; a refusal is read back (audit 2026-09-24, C22).
      min: 0,
      max: 120,
      step: 30,
      states: { 0: "Off", 30: "30 min", 60: "60 min", 90: "90 min", 120: "120 min" },
    },
    create: { kind: "func", func: "sleep" },
    read: { field: "sleep" },
    fromStatus: readNumber,
    write: numeric((c, v, z) => c.sleep(v, z)),
  },
  {
    state: "sound.dialogueLevel",
    common: {
      nameKey: "dialogueLevel",
      descKey: "descDialogueLevel",
      type: "number",
      role: "level",
      read: true,
      write: true,
    },
    create: { kind: "func", func: "dialogue_level" },
    read: { field: "dialogue_level" },
    fromStatus: readNumber,
    write: numeric((c, v, z) => c.setDialogueLevel(v, z)),
    range: "dialogue_level",
  },
  {
    state: "sound.contentsDisplay",
    common: {
      nameKey: "contentsDisplay",
      descKey: "descContentsDisplay",
      type: "boolean",
      role: "indicator",
      read: true,
      write: false,
    },
    create: { kind: "func", func: "contents_display" },
    read: { field: "contents_display" },
    fromStatus: readSwitch,
  },
  {
    state: "sound.surroundDecoder",
    common: {
      nameKey: "surroundDecoder",
      descKey: "descSurroundDecoder",
      type: "string",
      role: "state",
      read: true,
      write: true,
    },
    create: { kind: "func", func: "surr_decoder_type" },
    read: { field: "surr_decoder_type" },
    fromStatus: readWord,
    write: word((c, v, z) => c.setSurroundDecoderType(v, z)),
    list: "surr_decoder_type_list",
  },
  {
    state: "sound.audioSelect",
    common: {
      nameKey: "audioSelect",
      descKey: "descAudioSelect",
      type: "string",
      role: "text",
      read: true,
      write: false,
    },
    create: { kind: "func", func: "audio_select" },
    read: { field: "audio_select" },
    fromStatus: readWord,
    list: "audio_select_list",
  },
  {
    state: "sound.linkControl",
    common: {
      nameKey: "linkControl",
      descKey: "descLinkControl",
      type: "string",
      role: "state",
      read: true,
      write: true,
    },
    create: { kind: "func", func: "link_control" },
    read: { field: "link_control" },
    fromStatus: readWord,
    write: word((c, v, z) => c.setLinkControl(v, z)),
    list: "link_control_list",
  },
  {
    state: "sound.linkAudioDelay",
    common: {
      nameKey: "linkAudioDelay",
      descKey: "descLinkAudioDelay",
      type: "string",
      role: "state",
      read: true,
      write: true,
    },
    create: { kind: "func", func: "link_audio_delay" },
    read: { field: "link_audio_delay" },
    fromStatus: readWord,
    write: word((c, v, z) => c.setLinkAudioDelay(v, z)),
    list: "link_audio_delay_list",
    disableBit: 0b100,
  },
  {
    state: "sound.linkAudioQuality",
    common: {
      nameKey: "linkAudioQuality",
      descKey: "descLinkAudioQuality",
      type: "string",
      role: "state",
      read: true,
      write: true,
    },
    create: { kind: "func", func: "link_audio_quality" },
    read: { field: "link_audio_quality" },
    fromStatus: readWord,
    write: word((c, v, z) => c.setLinkAudioQuality(v, z)),
    list: "link_audio_quality_list",
  },
  {
    state: "sound.direct",
    common: { nameKey: "direct", descKey: "descDirect", type: "boolean", role: "switch", read: true, write: true },
    create: { kind: "func", func: "direct" },
    read: { field: "direct" },
    fromStatus: readSwitch,
    write: onOff((c, on, z) => c.setDirect(on, z)),
  },
  {
    state: "sound.clearVoice",
    common: {
      nameKey: "clearVoice",
      descKey: "descClearVoice",
      type: "boolean",
      role: "switch",
      read: true,
      write: true,
    },
    create: { kind: "func", func: "clear_voice" },
    read: { field: "clear_voice" },
    fromStatus: readSwitch,
    write: onOff((c, on, z) => c.setClearVoice(on, z)),
  },
  {
    state: "sound.bassExtension",
    common: {
      nameKey: "bassExtension",
      descKey: "descBassExtension",
      type: "boolean",
      role: "switch",
      read: true,
      write: true,
    },
    create: { kind: "func", func: "bass_extension" },
    read: { field: "bass_extension" },
    fromStatus: readSwitch,
    write: onOff((c, on, z) => c.setBassExtension(on, z)),
  },
  {
    state: "sound.balance",
    common: {
      nameKey: "balance",
      descKey: "descChannelBalance",
      type: "number",
      role: "level",
      read: true,
      write: true,
    },
    create: { kind: "func", func: "balance" },
    read: { field: "balance" },
    fromStatus: readNumber,
    write: numeric((c, v, z) => c.setBalance(v, z)),
    range: "balance",
  },
  {
    state: "sound.adaptiveDrc",
    common: {
      nameKey: "adaptiveDRC",
      descKey: "descAdaptiveDRC",
      type: "boolean",
      role: "switch",
      read: true,
      write: true,
    },
    create: { kind: "func", func: "adaptive_drc" },
    read: { field: "adaptive_drc" },
    fromStatus: readSwitch,
    write: onOff((c, on, z) => c.setAdaptiveDrc(on, z)),
  },
  {
    state: "sound.adaptiveDspLevel",
    common: {
      nameKey: "adaptiveDSPLevel",
      descKey: "descAdaptiveDSPLevel",
      type: "boolean",
      role: "indicator",
      read: true,
      write: false,
    },
    create: { kind: "func", func: "adaptive_dsp_level" },
    read: { field: "adaptive_dsp_level" },
    fromStatus: readSwitch,
  },
  {
    state: "sound.extraBass",
    common: {
      nameKey: "extraBass",
      descKey: "descExtraBass",
      type: "boolean",
      role: "switch",
      read: true,
      write: true,
    },
    create: { kind: "func", func: "extra_bass" },
    read: { field: "extra_bass" },
    fromStatus: readSwitch,
    write: onOff((c, on, z) => c.setExtraBass(on, z)),
  },
  {
    state: "sound.monaural",
    common: {
      nameKey: "monaural",
      descKey: "descMonaural",
      type: "boolean",
      role: "indicator",
      read: true,
      write: false,
    },
    create: { kind: "func", func: "mono" },
    read: { field: "mono" },
    fromStatus: readSwitch,
  },
  {
    state: "sound.surround3d",
    common: {
      nameKey: "surround3D",
      descKey: "descSurround3D",
      type: "boolean",
      role: "switch",
      read: true,
      write: true,
    },
    create: { kind: "func", func: "surround_3d" },
    read: { field: "surround_3d" },
    fromStatus: readSwitch,
    write: onOff((c, on, z) => c.set3dSurround(on, z)),
  },
  {
    // Surround:AI — declared as `surround_ai` and reported in getStatus by the RX-A3080 capture
    // (the one bundled device of its class). Read-only here: no bundled reference documents a
    // MusicCast setter, so the YNCA SURROUNDAI switch stays the writable one and wins the
    // datapoint where both transports are live (owner policy). Same id as the YNCA entry —
    // one capability, one canonical id.
    state: "sound.surroundAI",
    common: {
      nameKey: "surroundAI",
      descKey: "descSurroundAI",
      type: "boolean",
      role: "indicator",
      read: true,
      write: false,
    },
    create: { kind: "func", func: "surround_ai" },
    read: { field: "surround_ai" },
    fromStatus: readSwitch,
  },
  {
    state: "sound.dialogueLift",
    common: {
      nameKey: "dialogueLift",
      descKey: "descDialogueLift",
      type: "number",
      role: "level",
      read: true,
      write: true,
    },
    create: { kind: "func", func: "dialogue_lift" },
    read: { field: "dialogue_lift" },
    fromStatus: readNumber,
    write: numeric((c, v, z) => c.setDialogueLift(v, z)),
    range: "dialogue_lift",
  },
  {
    state: "sound.dtsDialogueControl",
    common: {
      nameKey: "dtsDialogueControl",
      descKey: "descDtsDialogueControl",
      type: "number",
      role: "level",
      read: true,
      write: true,
    },
    create: { kind: "func", func: "dts_dialogue_control" },
    read: { field: "dts_dialogue_control" },
    fromStatus: readNumber,
    write: numeric((c, v, z) => c.setDtsDialogueControl(v, z)),
    range: "dts_dialogue_control",
  },
  {
    state: "sound.equalizer.mode",
    common: {
      nameKey: "equalizerMode",
      descKey: "descEqualizerMode",
      type: "string",
      role: "state",
      read: true,
      write: true,
    },
    create: { kind: "func", func: "equalizer" },
    read: { path: ["equalizer", "mode"] },
    fromStatus: readWord,
    write: word((c, v, z) => c.setEqualizerMode(v, z)),
    list: "equalizer_mode_list",
  },
  {
    state: "sound.equalizer.low",
    common: { nameKey: "equalizerLow", type: "number", role: "level", read: true, write: true },
    create: { kind: "func", func: "equalizer" },
    read: { path: ["equalizer", "low"] },
    fromStatus: readNumber,
    range: "equalizer",
    write: { kind: "equalizer", band: "low" },
  },
  {
    state: "sound.equalizer.mid",
    common: { nameKey: "equalizerMid", type: "number", role: "level", read: true, write: true },
    create: { kind: "func", func: "equalizer" },
    read: { path: ["equalizer", "mid"] },
    fromStatus: readNumber,
    range: "equalizer",
    write: { kind: "equalizer", band: "mid" },
  },
  {
    state: "sound.equalizer.high",
    common: { nameKey: "equalizerHigh", type: "number", role: "level", read: true, write: true },
    create: { kind: "func", func: "equalizer" },
    read: { path: ["equalizer", "high"] },
    fromStatus: readNumber,
    range: "equalizer",
    write: { kind: "equalizer", band: "high" },
  },
  {
    state: "advanced.maxVolume",
    common: {
      nameKey: "maximumVolume",
      descKey: "descMaximumVolume",
      type: "number",
      role: "value",
      read: true,
      write: false,
    },
    // A zone without its own volume has no maximum either (RX-A2070 zone 4 — audit 2026-09-24, C10).
    create: { kind: "func", func: "volume" },
    read: { field: "max_volume" },
    fromStatus: readNumber,
    scale: "volumeLimit",
  },
  // The device-global entry: its id starts with "multiroom." (no zone prefix ever applies),
  // so the mapper and the status parser emit it for the main zone only.
  {
    // distribution_enable says the zone MAY be used for Link streaming — proven on a live
    // device reporting true while in no group (role none) — not that it streams right now.
    state: "multiroom.group.streamingEnabled",
    common: {
      nameKey: "multiroomStreamingEnabled",
      descKey: "descMultiroomStreamingEnabled",
      type: "boolean",
      role: "indicator",
      read: true,
      write: false,
    },
    create: { kind: "always" },
    read: { field: "distribution_enable" },
    fromStatus: readSwitch,
  },
  // Party mode is NOT read here: getStatus `party_enable` and getFuncStatus `party_mode` both fed
  // `multiroom.party`, refreshed at different moments, so the value could flip between the two. The
  // system catalog's documented pair (`party_mode` / setPartyMode — pyamaha; YXC Basic Rev 1.10 does not document the pair) is
  // the one source (audit 2026-09-29, C46).
];

/**
 * The `disable_flags` bit of a zone datapoint (YXC Basic §5.1: b0 volume, b1 mute, b2 link audio delay) — what the
 * controller checks before it sends a write the zone cannot operate right now. The bits stood as a literal table in
 * the controller (review 2026-10-05, DRY).
 *
 * @param name the zone-relative datapoint (`volume`, `mute`, …)
 * @returns the bit, or undefined when the zone never disables the function
 */
export function disableBitOf(name: string): number | undefined {
  return YXC_AMP_CATALOG.find(entry => entry.state === name)?.disableBit;
}
