/**
 * Datapoint groups: the thematic buckets that are both the object-tree structure and the
 * admin on/off switches. Every state id maps to exactly one group by its (zone-stripped) first
 * path segment (its channel). A disabled group's objects are never created and any existing ones
 * are pruned, the same way beszel gates its metric categories. `amp` is the always-on core — no
 * switch exists for it, exactly like beszel's unconditional `info.online`/`info.status`.
 *
 * `groupOf` recognises both today's flat channels (`spotify`, `dist`, `dab`) and the grouped
 * form the restructure introduces (`player.spotify`, `multiroom`, `tuner.dab`), so the switches
 * work before and after the tree is regrouped.
 */

/** The switchable groups. `amp` is the amplifier core and can never be turned off. */
export type GroupId = "amp" | "player" | "tuner" | "zones" | "multiroom" | "hdmi" | "scene" | "sound" | "advanced";

/** The groups a user can switch off, in display order (amp is always on and not listed here). */
export const SWITCHABLE_GROUPS: readonly GroupId[] = [
  "player",
  "tuner",
  "zones",
  "multiroom",
  "hdmi",
  "scene",
  "sound",
  "advanced",
];

/**
 * The player-source channels (YNCA sources + YXC netusb/cd), collected under the "player" group.
 * These are the ~18 near-identical media sources that make the flat tree hard to read.
 */
const PLAYER_CHANNELS = new Set<string>([
  "netRadio",
  "server",
  "usb",
  "spotify",
  "deezer",
  "tidal",
  "napster",
  "pandora",
  "rhapsody",
  "sirius",
  "airplay",
  "bluetooth",
  "pc",
  "musicCastLink",
  "ipod",
  "ipodUsb",
  "netPlayer",
  "cd",
]);

/**
 * The sound-processing and tone-tuning ids that are bare (no shared prefix segment) in the
 * canonical tree — the ID_DRIFT-resolved `bass`/`treble` included, since owner-policy strips
 * their `sound.` prefix. `sound.headphoneBass`/`sound.headphoneTreble` keep their prefix and are
 * matched by the `sound` segment check instead.
 */
const SOUND_IDS = new Set<string>([
  "bass",
  "treble",
  "straight",
  "enhancer",
  "pureDirect",
  "direct",
  "adaptiveDrc",
  "surroundAI",
  "surroundDecoder",
  "cinemaDsp3d",
  "extraBass",
  "subwooferTrim",
  "balance",
  "dialogueLevel",
  "dialogueLift",
  "dtsDialogueControl",
  "monaural",
  "surround3d",
  "adaptiveDspLevel",
  "audioSelect",
  "linkControl",
  "linkAudioDelay",
  "linkAudioQuality",
  "contentsDisplay",
  "equalizerLow",
  "equalizerMid",
  "equalizerHigh",
]);

/** The bare setup/configuration ids — one-time-setup datapoints, not everyday zone controls. */
const ADVANCED_IDS = new Set<string>(["maxVolume", "speakerA", "speakerB"]);

/**
 * The datapoint group a state id belongs to, decided by its (zone-stripped) first path segment.
 * HDMI routing and lip-sync are an HDMI concern on every zone, so they are matched before the
 * zone check strips them into the `zones` group. Anything not matched — the amplifier core
 * (power, volume, input, sleep …), `info.*` — is the always-on `amp` group.
 *
 * @param stateId the device-relative state id (e.g. "spotify.playback", "player.spotify.playback")
 * @returns the group the state belongs to
 */
export function groupOf(stateId: string): GroupId {
  const zone = /^zone[234]\./.exec(stateId)?.[0] ?? "";
  const rest = stateId.slice(zone.length);
  const seg = rest.includes(".") ? rest.slice(0, rest.indexOf(".")) : rest;

  if (seg === "hdmi" || seg === "lipSync") {
    return "hdmi";
  }
  if (seg === "player" || PLAYER_CHANNELS.has(seg)) {
    return "player";
  }
  if (seg === "tuner" || seg === "dab") {
    return "tuner";
  }
  if (zone || seg === "zoneB" || seg === "masterPower") {
    return "zones";
  }
  if (seg === "multiroom" || seg === "dist" || seg === "distributionEnable" || seg === "party" || seg === "partyMute") {
    return "multiroom";
  }
  if (seg === "scene") {
    return "scene";
  }
  if (seg === "sound" || SOUND_IDS.has(seg)) {
    return "sound";
  }
  if (seg === "initialVolume" || seg === "speakers" || seg === "inputNames" || ADVANCED_IDS.has(seg)) {
    return "advanced";
  }
  return "amp";
}

/**
 * Whether a state's group is switched on. The amplifier core is always on; every other group is
 * on unless its `group_<id>` flag is explicitly false — default-on, so a fresh install and every
 * existing install keep all groups until the user turns one off.
 *
 * @param stateId the device-relative state id
 * @param config the adapter native config (carries `group_player`, `group_tuner`, … booleans)
 * @returns true if the state's group is enabled
 */
export function isGroupEnabled(stateId: string, config: Record<string, unknown>): boolean {
  const group = groupOf(stateId);
  if (group === "amp") {
    return true;
  }
  return config[`group_${group}`] !== false;
}
