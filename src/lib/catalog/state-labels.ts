import { tIn, type I18nKey } from "../i18n";
import type { ObjectDef } from "./types";
import { ZONE_PREFIX } from "./zones";

/**
 * The words the adapter shows for a value — ONE table for all three transports, applied where every object is
 * written (`main.ts`, after the coordinator picked the owner). The transports keep declaring WHICH values a
 * datapoint takes (the keys of `common.states`, the device's own words or the spec's ids); what a value is
 * CALLED is said here, in the system language (fleet rule "readable values", round 59: a label is more than its
 * key, and a plain string in the reader's language — `{ Off: "Off" }` is the deprecated array form, and an
 * English-only label stays English for every user).
 *
 * Only the adapter's own vocabulary is here. What the DEVICE or the user names — input names, scene titles,
 * Yamaha's DSP programs, Dolby/DTS decoders, brands — keeps the device's text; `test/readable-values.json`
 * says why for each.
 */

/** A label: its translation key, with the values of its placeholders where it has them. */
type Label = I18nKey | readonly [I18nKey, ...(string | number)[]];

/**
 * Minutes, for the sleep timer's steps.
 *
 * @param n the minutes
 * @returns the label
 */
function minutes(n: number): Label {
  return ["labelMinutes", n];
}

const SLEEP: Readonly<Record<string, Label>> = {
  // YNCA and XML name the steps (`Off`, `30 min`; the 2008 XML dialect `30`), MusicCast counts minutes (`0`).
  Off: "labelSleepOff",
  0: "labelSleepOff",
  "30 min": minutes(30),
  "60 min": minutes(60),
  "90 min": minutes(90),
  "120 min": minutes(120),
  30: minutes(30),
  60: minutes(60),
  90: minutes(90),
  120: minutes(120),
};

const MUTE_LEVEL: Readonly<Record<string, Label>> = {
  Off: "labelNotMuted",
  On: "labelMuted",
  "Att -20 dB": "labelMuteMinus20",
  "Att -40 dB": "labelMuteMinus40",
};

const TONE_MODE: Readonly<Record<string, Label>> = {
  manual: "labelManual",
  auto: "labelAutomatic",
  bypass: "labelBypass",
};

const REMOTE_CURSOR: Readonly<Record<string, Label>> = {
  up: "labelUp",
  down: "labelDown",
  left: "labelLeft",
  right: "labelRight",
  select: "labelSelect",
  return: "labelBack",
  home: "labelHome",
};

const REMOTE_MENU: Readonly<Record<string, Label>> = {
  on_screen: "labelOnScreenMenu",
  top_menu: "labelTopMenu",
  menu: "labelMenu",
  option: "labelOptions",
  display: "labelDisplay",
  help: "labelHelp",
  home: "labelHome",
  red: "labelRed",
  green: "labelGreen",
  yellow: "labelYellow",
  blue: "labelBlue",
  mode: "labelMode",
};

const TUNER_BAND: Readonly<Record<string, Label>> = {
  // YNCA and XML spell the bands in capitals, MusicCast in lower case (YXC Basic §6.1).
  AM: "labelBandAm",
  FM: "labelBandFm",
  DAB: "labelBandDab",
  am: "labelBandAm",
  fm: "labelBandFm",
  dab: "labelBandDab",
};

/**
 * Labels by datapoint — the id relative to the device, a zone's folder left off (`multiroom.zone2.sleep` is
 * `sleep`) — then by value. A value missing here keeps the label its transport gave it.
 *
 * A switch has no value list, so it has no entry here: `power` and `mute` are booleans on all three protocols.
 * Their entries labelled the device-description words XML put on its booleans by mistake (review 2026-10-05,
 * A19), which made the same datapoint a dropdown on one protocol and a switch on the others.
 */
export const STATE_LABELS: Readonly<Record<string, Readonly<Record<string, Label>>>> = {
  muteLevel: MUTE_LEVEL,
  sleep: SLEEP,
  volumeOutput: { Variable: "labelVariableLevel", Fixed: "labelFixedLevel" },
  "player.playback": { 0: "labelPaused", 1: "labelPlaying", 2: "labelStopped" },
  "player.repeat": { 0: "labelRepeatOff", 1: "labelRepeatOne", 2: "labelRepeatAll" },
  "player.airplay.volumeInterlock": {
    Off: "labelInterlockOff",
    Limited: "labelInterlockLimited",
    Full: "labelInterlockFull",
  },
  // The browse sources are the transport-neutral keys of the drivers' source tables (browse/sources.test.ts
  // holds them together); the services keep their brand.
  "player.browse.source": { netRadio: "labelNetRadio", server: "labelMediaServer" },
  // YXC Basic §7.2 `play_error`, by code.
  "player.netPlayer.playError": {
    0: "labelPlayError0",
    1: "labelPlayError1",
    2: "labelPlayError2",
    3: "labelPlayError3",
    4: "labelPlayError4",
    5: "labelPlayError5",
    6: "labelPlayError6",
    7: "labelPlayError7",
    8: "labelPlayError8",
    9: "labelPlayError9",
    10: "labelPlayError10",
    11: "labelPlayError11",
    100: "labelPlayError100",
  },
  "remote.cursor": REMOTE_CURSOR,
  "remote.menu": REMOTE_MENU,
  "sound.adaptiveDrc": { Off: "labelSwitchedOff", Auto: "labelAutomatic" },
  "sound.audioSelect": {
    auto: "labelAutomatic",
    hdmi: "labelHdmi",
    coax_opt: "labelCoaxOpt",
    analog: "labelAnalog",
    unavailable: "labelUnavailable",
  },
  "sound.equalizer.mode": TONE_MODE,
  "sound.linkAudioDelay": {
    audio_sync: "labelAudioSync",
    lip_sync: "labelLipSync",
    balanced: "labelBalanced",
    audio_sync_on: "labelAudioSyncOn",
    audio_sync_off: "labelAudioSyncOff",
  },
  "sound.linkAudioQuality": { compressed: "labelCompressed", uncompressed: "labelUncompressed" },
  "sound.linkControl": { speed: "labelLinkSpeed", standard: "labelLinkStandard", stability: "labelLinkStability" },
  // The decoders are trademarks (Dolby, DTS) and keep their names; only the automatic choice is a word.
  "sound.surroundDecoder": { Auto: "labelAutomatic" },
  "sound.toneMode": TONE_MODE,
  "hdmi.standbyThrough": { off: "labelSwitchedOff", on: "labelSwitchedOn", auto: "labelAutomatic" },
  "advanced.trigger1Manual": { Lo: "labelLow", Hi: "labelHigh" },
  "advanced.trigger2Manual": { Lo: "labelLow", Hi: "labelHigh" },
  "multiroom.group.role": { server: "labelGroupServer", client: "labelGroupClient", none: "labelGroupNone" },
  "multiroom.group.serverZone": {
    main: "labelMainZone",
    zone2: ["labelZoneNumber", 2],
    zone3: ["labelZoneNumber", 3],
    zone4: ["labelZoneNumber", 4],
  },
  "multiroom.group.status": {
    building: "labelGroupBuilding",
    working: "labelGroupWorking",
    deleting: "labelGroupDeleting",
  },
  "tuner.band": TUNER_BAND,
  "tuner.audioMode": { mono: "labelMono", stereo: "labelStereo" },
  "tuner.dab.category": { primary: "labelDabPrimary", secondary: "labelDabSecondary" },
  "tuner.dab.status": {
    not_ready: "labelDabNotReady",
    initial_scan: "labelDabInitialScan",
    tune_aid: "labelDabTuneAid",
    ready: "labelDabReady",
  },
};

/**
 * The datapoint's value list with the adapter's words in the system language.
 *
 * @param relativeId the id relative to the device
 * @param def the object definition to write
 * @param language the system language
 * @returns the definition with its labels, the same object when nothing is labelled
 */
export function withValueLabels(relativeId: string, def: ObjectDef, language: string): ObjectDef {
  const states = def.type === "state" ? def.common.states : undefined;
  // A zone folder carries the main zone's datapoints (zones 2 to 4 and Zone B).
  const template = relativeId.replace(ZONE_PREFIX, "");
  const labels = Object.hasOwn(STATE_LABELS, template) ? STATE_LABELS[template] : undefined;
  if (!labels || !states || typeof states !== "object" || Array.isArray(states)) {
    return def;
  }
  const named: Record<string, string> = {};
  for (const [value, shown] of Object.entries(states)) {
    // Own keys only: a value the device declares is its word, and an inherited name (`toString`) is no label —
    // it threw on the spread below (review 2026-10-05, A35).
    const label = Object.hasOwn(labels, value) ? labels[value] : undefined;
    named[value] =
      label === undefined ? shown : typeof label === "string" ? tIn(language, label) : tIn(language, ...label);
  }
  return { ...def, common: { ...def.common, states: named } };
}
