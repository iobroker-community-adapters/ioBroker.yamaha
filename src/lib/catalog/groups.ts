/**
 * Datapoint groups: the thematic buckets that are both the object-tree structure and the
 * admin on/off switches. Every state id maps to exactly one group by its first path segment
 * (its channel). A disabled group's objects are never created and any existing ones are pruned,
 * the same way beszel gates its metric categories.
 *
 * `groupOf` recognises both today's flat channels (`spotify`, `dist`, `dab`) and the grouped
 * form the restructure introduces (`player.spotify`, `multiroom`, `tuner.dab`), so the switches
 * work before and after the tree is regrouped.
 */

/** The switchable groups. `amp` is the amplifier core and can never be turned off. */
export type GroupId = "amp" | "player" | "tuner" | "zones" | "multiroom" | "hdmi" | "scene";

/** The groups a user can switch off, in display order (amp is always on and not listed here). */
export const SWITCHABLE_GROUPS: readonly GroupId[] = [
  "player",
  "tuner",
  "zones",
  "multiroom",
  "hdmi",
  "scene",
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
 * The datapoint group a state id belongs to, decided by its first path segment (channel).
 * Anything not matched — the amplifier core (power, volume, input …), `sound.*`, `info.*` — is
 * the always-on `amp` group.
 *
 * @param stateId the device-relative state id (e.g. "spotify.playback", "player.spotify.playback")
 * @returns the group the state belongs to
 */
export function groupOf(stateId: string): GroupId {
  const seg = stateId.includes(".") ? stateId.slice(0, stateId.indexOf(".")) : stateId;
  if (seg === "player" || PLAYER_CHANNELS.has(seg)) {
    return "player";
  }
  if (seg === "tuner" || seg === "dab") {
    return "tuner";
  }
  if (seg === "zone2" || seg === "zone3" || seg === "zone4") {
    return "zones";
  }
  if (seg === "multiroom" || seg === "dist") {
    return "multiroom";
  }
  if (seg === "hdmi") {
    return "hdmi";
  }
  if (seg === "scene") {
    return "scene";
  }
  return "amp";
}
