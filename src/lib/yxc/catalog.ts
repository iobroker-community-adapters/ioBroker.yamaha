import type { ObjectDef } from "../catalog/types";
import type { I18nKey } from "../i18n";
import type { YxcClientLike } from "./client-contract";

/**
 * The single source for YXC (MusicCast) amplifier states: one entry per unified
 * state carries BOTH its ioBroker object (`common`) AND its getStatus read + write
 * mapping — replacing the former `YXC_STATES` (object-mapper) / `YXC_STATE_MAPPINGS`
 * (command-mapper) pair that had to be kept in sync by hand. The object-mapper reads
 * `create`/`common`, the command-mapper reads `read`/`fromStatus`/`write`.
 *
 * Value types are verified against the bundled device captures
 * (`yamaha-yxc-nodejs/lib/data/*.json`): e.g. `adaptive_drc`/`extra_bass` are real
 * booleans, `sleep` is minutes, `link_control`/`surr_decoder_type` are strings.
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
   * feature key; `always` = a core status field created for every active zone;
   * `input` = only if the zone offers inputs (from input_list, not func_list).
   */
  create: { kind: "func"; func: string } | { kind: "always" } | { kind: "input" };
  /** Where to read the value in a getStatus response: a flat field or a nested path. */
  read: { field: string } | { path: string[] };
  /** Convert a raw getStatus value into the typed state value. */
  fromStatus: (value: unknown) => boolean | number | string;
  /**
   * Write mapping — absent means the state is read-only (no library setter). The entry
   * calls the client DIRECTLY (value coercion inline), so there is no method-name string
   * to keep in sync with a dispatch switch and no "unknown command" runtime path.
   */
  write?: { apply: (client: YxcClientLike, value: unknown, zone: string) => Promise<unknown> };
}

const bool = (value: unknown): boolean => Boolean(value);
const num = (value: unknown): number => Number(value);
const str = (value: unknown): string => String(value);

/** The unified YXC amplifier catalog — object + read/write mapping in one list. */
export const YXC_AMP_CATALOG: YxcAmpEntry[] = [
  {
    state: "power",
    common: { nameKey: "power", type: "boolean", role: "switch.power", read: true, write: true },
    create: { kind: "func", func: "power" },
    read: { field: "power" },
    fromStatus: value => value === "on",
    write: { apply: (c, v, z) => c.power(Boolean(v), z) },
  },
  {
    state: "volume",
    common: { nameKey: "volume", type: "number", role: "level.volume", read: true, write: true },
    create: { kind: "func", func: "volume" },
    read: { field: "volume" },
    fromStatus: num,
    write: { apply: (c, v, z) => c.setVolumeTo(Number(v), z) },
  },
  {
    state: "mute",
    common: { nameKey: "mute", type: "boolean", role: "media.mute", read: true, write: true },
    create: { kind: "func", func: "mute" },
    read: { field: "mute" },
    fromStatus: bool,
    write: { apply: (c, v, z) => c.mute(Boolean(v), z) },
  },
  {
    state: "input",
    common: { nameKey: "input", type: "string", role: "media.input", read: true, write: true },
    create: { kind: "input" },
    read: { field: "input" },
    fromStatus: str,
    write: { apply: (c, v, z) => c.setInput(String(v), z) },
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
    fromStatus: str,
    write: { apply: (c, v, z) => c.setSound(String(v), z) },
  },
  {
    state: "sound.enhancer",
    common: { nameKey: "enhancer", descKey: "descEnhancer", type: "boolean", role: "switch", read: true, write: true },
    create: { kind: "func", func: "enhancer" },
    read: { field: "enhancer" },
    fromStatus: bool,
    write: { apply: (c, v, z) => c.setEnhancer(Boolean(v), z) },
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
    fromStatus: bool,
    write: { apply: (c, v, z) => c.setPureDirect(Boolean(v), z) },
  },
  {
    state: "subwooferVolume",
    common: {
      nameKey: "subwooferTrim",
      descKey: "descSubwooferTrim",
      type: "number",
      unit: "dB",
      role: "level",
      read: true,
      write: true,
    },
    create: { kind: "func", func: "subwoofer_volume" },
    read: { field: "subwoofer_volume" },
    fromStatus: num,
    write: { apply: (c, v, z) => c.setSubwooferVolumeTo(Number(v), z) },
  },
  {
    state: "sound.bass",
    common: { nameKey: "bass", type: "number", unit: "dB", role: "level", read: true, write: true },
    create: { kind: "func", func: "tone_control" },
    read: { path: ["tone_control", "bass"] },
    fromStatus: num,
    write: { apply: (c, v, z) => c.setBassTo(Number(v), z) },
  },
  {
    state: "sound.toneMode",
    common: {
      nameKey: "toneControlMode",
      descKey: "descToneControlMode",
      type: "string",
      role: "state",
      read: true,
      write: false,
    },
    create: { kind: "func", func: "tone_control" },
    read: { path: ["tone_control", "mode"] },
    fromStatus: str,
  },
  {
    state: "sound.treble",
    common: { nameKey: "treble", type: "number", unit: "dB", role: "level", read: true, write: true },
    create: { kind: "func", func: "tone_control" },
    read: { path: ["tone_control", "treble"] },
    fromStatus: num,
    write: { apply: (c, v, z) => c.setTrebleTo(Number(v), z) },
  },
  {
    state: "sleep",
    common: { nameKey: "sleepTimer", type: "number", unit: "min", role: "level", read: true, write: true },
    create: { kind: "func", func: "sleep" },
    read: { field: "sleep" },
    fromStatus: num,
    write: { apply: (c, v, z) => c.sleep(Number(v), z) },
  },
  {
    state: "sound.dialogueLevel",
    common: {
      nameKey: "dialogueLevel",
      descKey: "descDialogueLevel",
      type: "number",
      role: "value",
      read: true,
      write: false,
    },
    create: { kind: "func", func: "dialogue_level" },
    read: { field: "dialogue_level" },
    fromStatus: num,
  },
  {
    state: "actualVolume",
    common: {
      nameKey: "volumeDB",
      descKey: "descVolumeDB",
      type: "number",
      unit: "dB",
      role: "value",
      read: true,
      write: false,
    },
    create: { kind: "func", func: "actual_volume" },
    read: { path: ["actual_volume", "value"] },
    fromStatus: num,
  },
  {
    state: "actualVolumeMode",
    common: {
      nameKey: "volumeDisplayMode",
      descKey: "descVolumeDisplayMode",
      type: "string",
      role: "state",
      read: true,
      write: false,
    },
    create: { kind: "func", func: "actual_volume" },
    read: { path: ["actual_volume", "mode"] },
    fromStatus: str,
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
    fromStatus: bool,
  },
  {
    state: "sound.surroundDecoder",
    common: {
      nameKey: "surroundDecoder",
      descKey: "descSurroundDecoder",
      type: "string",
      role: "text",
      read: true,
      write: false,
    },
    create: { kind: "func", func: "surr_decoder_type" },
    read: { field: "surr_decoder_type" },
    fromStatus: str,
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
    fromStatus: str,
  },
  {
    state: "sound.linkControl",
    common: {
      nameKey: "linkControl",
      descKey: "descLinkControl",
      type: "string",
      role: "text",
      read: true,
      write: false,
    },
    create: { kind: "func", func: "link_control" },
    read: { field: "link_control" },
    fromStatus: str,
  },
  {
    state: "sound.linkAudioDelay",
    common: {
      nameKey: "linkAudioDelay",
      descKey: "descLinkAudioDelay",
      type: "string",
      role: "text",
      read: true,
      write: false,
    },
    create: { kind: "func", func: "link_audio_delay" },
    read: { field: "link_audio_delay" },
    fromStatus: str,
  },
  {
    state: "sound.linkAudioQuality",
    common: {
      nameKey: "linkAudioQuality",
      descKey: "descLinkAudioQuality",
      type: "string",
      role: "text",
      read: true,
      write: false,
    },
    create: { kind: "func", func: "link_audio_quality" },
    read: { field: "link_audio_quality" },
    fromStatus: str,
  },
  {
    state: "sound.direct",
    common: { nameKey: "direct", descKey: "descDirect", type: "boolean", role: "switch", read: true, write: true },
    create: { kind: "func", func: "direct" },
    read: { field: "direct" },
    fromStatus: bool,
    write: { apply: (c, v, z) => c.setDirect(Boolean(v), z) },
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
    fromStatus: bool,
    write: { apply: (c, v, z) => c.setClearVoice(Boolean(v), z) },
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
    fromStatus: bool,
    write: { apply: (c, v, z) => c.setBassExtension(Boolean(v), z) },
  },
  {
    state: "sound.balance",
    common: { nameKey: "balance", type: "number", role: "level", read: true, write: true },
    create: { kind: "func", func: "balance" },
    read: { field: "balance" },
    fromStatus: num,
    write: { apply: (c, v, z) => c.setBalance(Number(v), z) },
  },
  {
    state: "sound.adaptiveDrc",
    common: {
      nameKey: "adaptiveDRC",
      descKey: "descAdaptiveDRC",
      type: "boolean",
      role: "indicator",
      read: true,
      write: false,
    },
    create: { kind: "func", func: "adaptive_drc" },
    read: { field: "adaptive_drc" },
    fromStatus: bool,
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
    fromStatus: bool,
  },
  {
    state: "sound.extraBass",
    common: {
      nameKey: "extraBass",
      descKey: "descExtraBass",
      type: "boolean",
      role: "indicator",
      read: true,
      write: false,
    },
    create: { kind: "func", func: "extra_bass" },
    read: { field: "extra_bass" },
    fromStatus: bool,
  },
  {
    state: "sound.monaural",
    common: { nameKey: "monaural", type: "boolean", role: "indicator", read: true, write: false },
    create: { kind: "func", func: "mono" },
    read: { field: "mono" },
    fromStatus: bool,
  },
  {
    state: "sound.surround3d",
    common: {
      nameKey: "surround3D",
      descKey: "descSurround3D",
      type: "boolean",
      role: "indicator",
      read: true,
      write: false,
    },
    create: { kind: "func", func: "surround_3d" },
    read: { field: "surround_3d" },
    fromStatus: bool,
  },
  {
    state: "sound.dialogueLift",
    common: {
      nameKey: "dialogueLift",
      descKey: "descDialogueLift",
      type: "number",
      role: "value",
      read: true,
      write: false,
      min: 0,
      max: 5,
      step: 1,
    },
    create: { kind: "func", func: "dialogue_lift" },
    read: { field: "dialogue_lift" },
    fromStatus: num,
  },
  {
    state: "sound.dtsDialogueControl",
    common: {
      nameKey: "dtsDialogueControl",
      descKey: "descDtsDialogueControl",
      type: "number",
      role: "value",
      read: true,
      write: false,
    },
    create: { kind: "func", func: "dts_dialogue_control" },
    read: { field: "dts_dialogue_control" },
    fromStatus: num,
  },
  {
    state: "sound.equalizer.mode",
    common: {
      nameKey: "equalizerMode",
      descKey: "descEqualizerMode",
      type: "string",
      role: "state",
      read: true,
      write: false,
    },
    create: { kind: "func", func: "equalizer" },
    read: { path: ["equalizer", "mode"] },
    fromStatus: str,
  },
  {
    state: "sound.equalizer.low",
    common: { nameKey: "equalizerLow", type: "number", unit: "dB", role: "level", read: true, write: true },
    create: { kind: "func", func: "equalizer" },
    read: { path: ["equalizer", "low"] },
    fromStatus: num,
  },
  {
    state: "sound.equalizer.mid",
    common: { nameKey: "equalizerMid", type: "number", unit: "dB", role: "level", read: true, write: true },
    create: { kind: "func", func: "equalizer" },
    read: { path: ["equalizer", "mid"] },
    fromStatus: num,
  },
  {
    state: "sound.equalizer.high",
    common: { nameKey: "equalizerHigh", type: "number", unit: "dB", role: "level", read: true, write: true },
    create: { kind: "func", func: "equalizer" },
    read: { path: ["equalizer", "high"] },
    fromStatus: num,
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
    create: { kind: "always" },
    read: { field: "max_volume" },
    fromStatus: num,
  },
  {
    state: "inputText",
    common: { nameKey: "inputNameDisplay", type: "string", role: "text", read: true, write: false },
    create: { kind: "always" },
    read: { field: "input_text" },
    fromStatus: str,
  },
  // The two device-global entries: their id starts with "multiroom." (no zone prefix ever
  // applies), so the mapper and the status parser emit them for the main zone only.
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
    fromStatus: bool,
  },
  {
    state: "multiroom.partyEnable",
    common: {
      nameKey: "partyModeAllZones",
      descKey: "descPartyModeAllZones",
      type: "boolean",
      role: "switch",
      read: true,
      write: true,
    },
    create: { kind: "always" },
    read: { field: "party_enable" },
    fromStatus: bool,
    write: { apply: (c, v) => c.setPartyMode(Boolean(v)) },
  },
];
