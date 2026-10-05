/**
 * Datapoint groups: the thematic buckets that are both the object-tree structure and the
 * admin on/off switches. A disabled group's objects are never created and any existing ones
 * are pruned, the same way beszel gates its metric categories. `amp` is the always-on core — no
 * switch exists for it, exactly like beszel's unconditional `info.online`/`info.status`.
 *
 * Every group is a real channel prefix in the tree (`player.*`, `tuner.*`, `hdmi.*`,
 * `multiroom.*`, `scene.*`, `sound.*`, `advanced.*`, `clock.*`) — the toggle and the folder a
 * datapoint visually sits in are the same thing, never decoupled. Two ids need a word:
 *
 * - `remote.*` is the ONE folder that does not carry its own name: the on-screen remote is what
 *   the menu is operated with, and on the two text protocols the browsing surface builds it — so
 *   it follows the "Playback & browsing" switch, or turning that off would leave a pad standing
 *   that nothing drives any more.
 * - A ZONE datapoint (`multiroom.zoneN.<theme>.…`, Zone B included) hangs on TWO switches: multiroom,
 *   because the zones are what that switch is about, and its own theme. `groupsOf` says so; `groupOf`
 *   reports the theme with the zone prefix stripped. Device-wide multiroom states (masterPower, party,
 *   the MusicCast link) are multiroom's own and carry no second group.
 *
 * Legacy flat pre-v0.15.0 ids need no handling here: the start-up cleanup deletes them via
 * `RENAMED_CHANNELS` before anything queries them.
 */

import { ZONE_PREFIX } from "./zones";

/**
 * The theme group of a first path segment — the ONE table behind {@link groupOf}, the group type and the switch list
 * (an if-chain of nine branches, a type and a hand-kept list before; review 2026-10-05, F). A segment not listed is
 * the always-on amplifier core.
 */
const THEME_BY_SEGMENT = {
  player: "player",
  // The on-screen remote operates the menu — see the module comment.
  remote: "player",
  tuner: "tuner",
  multiroom: "multiroom",
  hdmi: "hdmi",
  scene: "scene",
  sound: "sound",
  advanced: "advanced",
  clock: "clock",
} as const;

/** The groups. `amp` is the amplifier core and can never be turned off. */
export type GroupId = "amp" | (typeof THEME_BY_SEGMENT)[keyof typeof THEME_BY_SEGMENT];

/**
 * The groups a user can switch off (amp is always on and not listed here) — every theme of the table, so a group the
 * code knows cannot miss its switch: the manifest test holds this list against the admin page and the defaults.
 */
export const SWITCHABLE_GROUPS: readonly GroupId[] = [...new Set(Object.values(THEME_BY_SEGMENT))];

/**
 * The THEME group a state id belongs to, decided by its first path segment AFTER a zone prefix
 * is stripped: `player.*` (with the on-screen remote `remote.*`), `tuner.*`, `hdmi.*`, `sound.*`,
 * `advanced.*`, `scene.*`, `clock.*`, and `multiroom.*` for the genuinely device-wide multiroom
 * states (masterPower, party, the MusicCast link). Anything not matched — the amplifier core
 * (power, volume, input, sleep …), `info.*` — is the always-on `amp` group.
 *
 * The zone prefix is stripped ON PURPOSE: `multiroom.zone2.sound.enhancer` is a SOUND datapoint
 * that happens to live in zone 2. Reading the first segment raw made every zone datapoint a
 * multiroom one, so "Sound off" cleared the main zone and left the zones' sound datapoints
 * standing (audit 2026-09-06, measured over 25 MusicCast and 15 YNCA models: 304 playback, 57+26
 * sound, 16+20 advanced and 12 scene datapoints survived the switch that was meant to remove
 * them). That a zone datapoint ALSO follows the multiroom switch is expressed by
 * {@link groupsOf}, not by pretending its theme is multiroom.
 *
 * @param stateId the device-relative state id (e.g. "multiroom.zone2.sound.enhancer")
 * @returns the theme group the state belongs to
 */
export function groupOf(stateId: string): GroupId {
  const segment = stateId.replace(ZONE_PREFIX, "").split(".", 1)[0];
  // Own keys only: an inherited name (`constructor`) is no theme.
  return Object.hasOwn(THEME_BY_SEGMENT, segment) ? THEME_BY_SEGMENT[segment as keyof typeof THEME_BY_SEGMENT] : "amp";
}

/**
 * EVERY group a state id hangs on: its theme group, plus `multiroom` when it sits in a zone.
 *
 * A zone datapoint belongs to two things at once and both switches have to reach it — turning
 * Multiroom off removes the zones whole (that is what the switch says), and turning Sound off
 * removes the sound datapoints of every zone as well as the main one.
 *
 * @param stateId the device-relative state id
 * @returns the groups that all have to be enabled for this state to exist
 */
export function groupsOf(stateId: string): GroupId[] {
  const theme = groupOf(stateId);
  if (!ZONE_PREFIX.test(stateId) || theme === "multiroom") {
    return [theme];
  }
  return ["multiroom", theme];
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
export function isGroupEnabled(stateId: string, config: object): boolean {
  const switches = config as Record<string, unknown>;
  // ALL of them: a zone's sound datapoint needs Multiroom AND Sound to be on.
  return groupsOf(stateId).every(group => group === "amp" || switches[`group_${group}`] !== false);
}
