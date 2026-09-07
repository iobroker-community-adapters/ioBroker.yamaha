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
 * - A ZONE datapoint (`multiroom.zoneN.<theme>.…`) hangs on TWO switches: multiroom, because the
 *   zones are what that switch is about, and its own theme. `groupsOf` says so; `groupOf` reports
 *   the theme with the zone prefix stripped. Device-wide multiroom states (masterPower, party,
 *   the MusicCast link, Zone B) are multiroom's own and carry no second group.
 *
 * Legacy flat pre-v0.15.0 ids need no handling here: the start-up cleanup deletes them via
 * `RENAMED_CHANNELS` before anything queries them.
 */

import { ZONE_PREFIX } from "./owner-policy";

/** The switchable groups. `amp` is the amplifier core and can never be turned off. */
export type GroupId = "amp" | "player" | "tuner" | "multiroom" | "hdmi" | "scene" | "sound" | "advanced" | "clock";

/** The groups a user can switch off, in display order (amp is always on and not listed here). */
export const SWITCHABLE_GROUPS: readonly GroupId[] = [
  "player",
  "tuner",
  "multiroom",
  "hdmi",
  "scene",
  "sound",
  "advanced",
  "clock",
];

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
  const template = stateId.replace(ZONE_PREFIX, "");
  const seg = template.includes(".") ? template.slice(0, template.indexOf(".")) : template;

  if (seg === "multiroom") {
    return "multiroom";
  }
  if (seg === "hdmi") {
    return "hdmi";
  }
  if (seg === "player" || seg === "remote") {
    return "player";
  }
  if (seg === "tuner") {
    return "tuner";
  }
  if (seg === "sound") {
    return "sound";
  }
  if (seg === "advanced") {
    return "advanced";
  }
  if (seg === "scene") {
    return "scene";
  }
  if (seg === "clock") {
    return "clock";
  }
  return "amp";
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
export function isGroupEnabled(stateId: string, config: Record<string, unknown>): boolean {
  // ALL of them: a zone's sound datapoint needs Multiroom AND Sound to be on.
  return groupsOf(stateId).every(group => group === "amp" || config[`group_${group}`] !== false);
}
