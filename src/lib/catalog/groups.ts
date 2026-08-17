/**
 * Datapoint groups: the thematic buckets that are both the object-tree structure and the
 * admin on/off switches. Every state id maps to exactly one group by its (zone-stripped) first
 * path segment (its channel). A disabled group's objects are never created and any existing ones
 * are pruned, the same way beszel gates its metric categories. `amp` is the always-on core — no
 * switch exists for it, exactly like beszel's unconditional `info.online`/`info.status`.
 *
 * Every group is a real channel prefix in the tree (`player.*`, `tuner.*`, `hdmi.*`,
 * `multiroom.*`, `scene.*`, `sound.*`, `advanced.*`) — the toggle and the folder a datapoint
 * visually sits in are the same thing, never decoupled. Zone 2/3/4, Zone B and masterPower belong
 * to the `multiroom` group — their objects live in `zone2/`…`zone4/` folders but are switched as a
 * unit with the rest of multiroom. `groupOf` also recognises the handful of legacy flat
 * player-source channel names (`spotify`, `netRadio`, …) kept for pre-v0.15.0 upgraders whose
 * objects have not been pruned/recreated yet.
 */

/** The switchable groups. `amp` is the amplifier core and can never be turned off. */
export type GroupId = "amp" | "player" | "tuner" | "multiroom" | "hdmi" | "scene" | "sound" | "advanced";

/** The groups a user can switch off, in display order (amp is always on and not listed here). */
export const SWITCHABLE_GROUPS: readonly GroupId[] = [
  "player",
  "tuner",
  "multiroom",
  "hdmi",
  "scene",
  "sound",
  "advanced",
];

/**
 * The player-source channels (YNCA sources + YXC netusb/cd), collected under the "player" group.
 * These are the ~18 near-identical media sources that made the flat tree hard to read before the
 * v0.15.0 regroup; kept here only so an un-migrated pre-v0.15.0 object still resolves correctly
 * until it is pruned.
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
 * The datapoint group a state id belongs to, decided by its (zone-stripped) first path segment.
 * HDMI routing and lip-sync, and the sound/advanced buckets, are topic concerns on every zone —
 * every catalog gives them a `sound.`/`advanced.`/`hdmi.` id regardless of which zone they're on,
 * so they are matched before the zone check would otherwise fold them into the `zones` group. A
 * bare `zone2`/`zone3`/`zone4` (the zone's own channel object, no further segment) is matched
 * directly — it never reaches the zone-prefix strip below, which only fires on a *dotted* child
 * id. Anything not matched — the amplifier core (power, volume, input, sleep …), `info.*` — is
 * the always-on `amp` group.
 *
 * @param stateId the device-relative state id (e.g. "spotify.playback", "player.spotify.playback")
 * @returns the group the state belongs to
 */
export function groupOf(stateId: string): GroupId {
  if (stateId === "zone2" || stateId === "zone3" || stateId === "zone4") {
    return "multiroom";
  }
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
  if (seg === "sound") {
    return "sound";
  }
  if (seg === "advanced") {
    return "advanced";
  }
  if (zone || seg === "zoneB" || seg === "masterPower") {
    return "multiroom";
  }
  if (seg === "multiroom" || seg === "dist" || seg === "distributionEnable" || seg === "party" || seg === "partyMute") {
    return "multiroom";
  }
  if (seg === "scene") {
    return "scene";
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
