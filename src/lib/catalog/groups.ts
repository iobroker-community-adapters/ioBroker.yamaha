/**
 * Datapoint groups: the thematic buckets that are both the object-tree structure and the
 * admin on/off switches. Every state id maps to exactly one group by its (zone-stripped) first
 * path segment (its channel). A disabled group's objects are never created and any existing ones
 * are pruned, the same way beszel gates its metric categories. `amp` is the always-on core — no
 * switch exists for it, exactly like beszel's unconditional `info.online`/`info.status`.
 *
 * Every group is a real channel prefix in the tree (`player.*`, `tuner.*`, `hdmi.*`,
 * `multiroom.*`, `scene.*`, `sound.*`, `advanced.*`) — the toggle and the folder a datapoint
 * visually sits in are the same thing, never decoupled. Zone 2/3/4, Zone B, masterPower, party
 * and distribution all live under `multiroom.*`. Legacy flat pre-v0.15.0 ids need no handling
 * here: the start-up cleanup deletes them via `RENAMED_CHANNELS` before anything queries them.
 */

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
 * The datapoint group a state id belongs to, decided by its first path segment. Every group is a
 * real folder prefix in the tree, so the first segment of the id determines the group directly:
 * `multiroom.*` (including zones, masterPower, party), `player.*`, `tuner.*`, `hdmi.*`, `sound.*`,
 * `advanced.*`, `scene.*`. Anything not matched — the amplifier core (power, volume, input,
 * sleep …), `info.*` — is the always-on `amp` group.
 *
 * @param stateId the device-relative state id (e.g. "multiroom.zone2.power", "player.spotify.playback")
 * @returns the group the state belongs to
 */
export function groupOf(stateId: string): GroupId {
  const seg = stateId.includes(".") ? stateId.slice(0, stateId.indexOf(".")) : stateId;

  if (seg === "multiroom") {
    return "multiroom";
  }
  if (seg === "hdmi") {
    return "hdmi";
  }
  if (seg === "player") {
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
