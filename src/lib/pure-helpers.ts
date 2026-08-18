import type { DeviceRecord } from "./types";
import type { DiscoveredDevice } from "./discovery";

interface ConfiguredDevice {
  name?: string;
  ip: string;
}

/**
 * True when a raw config row carries a non-empty ip (the name is optional — a row
 * with an ip but no name is valid and falls back to the ip as its id, so a device
 * is never silently dropped just because its name was left blank).
 *
 * @param entry a raw config row from the admin device table
 * @returns whether the row is a valid configured device
 */
function isConfiguredDevice(entry: unknown): entry is ConfiguredDevice {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const candidate = entry as { name?: unknown; ip?: unknown };
  return (
    typeof candidate.ip === "string" &&
    candidate.ip.length > 0 &&
    (candidate.name === undefined || typeof candidate.name === "string")
  );
}

/**
 * Make a string safe for use as an ioBroker object id segment.
 *
 * @param raw the raw string (e.g. a device name)
 * @returns the string with id-unsafe characters replaced by underscores
 */
export function sanitizeId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9\-_]/g, "_");
}

/**
 * Strip the adapter namespace (e.g. `yamaha.0`) from a full state id, leaving the
 * device-relative path (e.g. `living.power`).
 *
 * @param fullId the full state id
 * @param namespace the adapter namespace
 * @returns the id relative to the adapter instance
 */
export function stripNamespace(fullId: string, namespace: string): string {
  return fullId.slice(namespace.length + 1);
}

/**
 * Turn the admin device table (untrusted native config) into device records.
 * Invalid rows are dropped, as are rows whose id collides with the adapter's own
 * reserved `info` branch or with an id already taken — two names that sanitise to
 * the same id (e.g. "Living Room" and "Living.Room") would otherwise share one
 * object tree.
 *
 * @param raw the raw `native.devices` value
 * @returns validated, de-duplicated device records
 */
export function parseDevices(raw: unknown): DeviceRecord[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const records: DeviceRecord[] = [];
  const taken = new Set<string>(["info"]); // reserved: the adapter's own info channel
  for (const entry of raw) {
    if (!isConfiguredDevice(entry)) {
      continue;
    }
    // Fall back to the ip as the id when the name is blank, so the device still appears
    // instead of vanishing silently.
    const id = sanitizeId(entry.name && entry.name.length > 0 ? entry.name : entry.ip);
    if (taken.has(id)) {
      continue;
    }
    taken.add(id);
    records.push({ id, ip: entry.ip });
  }
  return records;
}

/**
 * Merge freshly discovered devices into the set already known from earlier runs
 * (the auto-discovery standby protection). A known device is kept even when this
 * run's scan did not find it — a receiver in deep standby answers no SSDP, and its
 * object tree must survive. New addresses are added; a discovered device is turned
 * into a record via its friendly name (or its ip when it advertises none), and one
 * whose id would collide with an already-kept device is skipped. De-duplicated by ip.
 *
 * @param known the device records remembered from earlier runs
 * @param found the devices discovered this run
 * @returns the merged records, de-duplicated by ip
 */
export function mergeDiscovered(known: DeviceRecord[], found: DiscoveredDevice[]): DeviceRecord[] {
  const byIp = new Map<string, DeviceRecord>();
  const takenIds = new Set<string>(["info"]); // reserved: the adapter's own info channel
  for (const device of known) {
    if (byIp.has(device.ip) || takenIds.has(device.id)) {
      continue;
    }
    byIp.set(device.ip, device);
    takenIds.add(device.id);
  }
  for (const device of found) {
    if (byIp.has(device.ip)) {
      continue;
    }
    const id = sanitizeId(device.name || device.ip);
    if (takenIds.has(id)) {
      continue;
    }
    takenIds.add(id);
    byIp.set(device.ip, { id, ip: device.ip });
  }
  return [...byIp.values()];
}

/**
 * From all object ids under the instance, pick the stale ones to delete on start:
 * everything that does not belong to a configured device and is outside the
 * adapter's own `info` branch. Removes the previous adapter's whole object tree
 * and any device dropped from the config. Keyed on the configured device ids
 * (not on what was created this run), so it works with the async connect where a
 * device's tree may only appear later — a configured device's subtree is kept
 * regardless of whether it has connected yet. Deepest first, so children go
 * before their parents.
 *
 * @param existing all object ids currently under the instance
 * @param deviceIds the ids of the currently configured devices
 * @param namespace the adapter namespace (e.g. `yamaha.0`)
 * @returns the stale ids to delete, deepest first
 */
export function staleObjects(existing: string[], deviceIds: Set<string>, namespace: string): string[] {
  // No configured devices → never wipe the whole tree (a user who cleared the
  // device table by accident would otherwise lose every object in one pass).
  if (deviceIds.size === 0) {
    return [];
  }
  const isKept = (fullId: string): boolean => {
    const top = stripNamespace(fullId, namespace).split(".")[0];
    return top === "info" || deviceIds.has(top);
  };
  return existing.filter(id => !isKept(id)).sort((a, b) => b.length - a.length);
}

/**
 * Relative state ids an earlier version created under a different path and that this
 * version has renamed or moved. On start-up the old object is deleted so it does not
 * linger orphaned beside the new one — {@link staleObjects} only removes whole
 * non-configured device trees, not renamed states inside a device that is kept.
 */
export const RENAMED_STATE_IDS = [
  "hdmiOut",
  "directMode",
  "masterPower",
  "party",
  "partyMute",
  "distributionEnable",
  "partyEnable",
  "remoteCode",
];

/**
 * Old channel prefixes whose whole subtree this version moved out — the `system`
 * grab-bag is gone (model/firmware → info, HDMI outputs → hdmi, speaker patterns →
 * speakers, input names → inputNames, master power → multiroom.masterPower). The channel and
 * every state under it are removed.
 */
export const RENAMED_CHANNELS = [
  // pre-0.11 system folder
  "system",
  // v0.18.1 multiroom regroup: zone2/3/4, zoneB, flat multiroom states moved under multiroom/.
  "zone2",
  "zone3",
  "zone4",
  "zoneB",
  // Regrouping: media sources moved under player/, DAB under tuner/, dist → multiroom. The old
  // flat channels (and their whole subtree) are deleted so the new grouped ones do not sit
  // beside orphaned copies on an upgraded instance.
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
  "dab",
  "dist",
  // Sound/Advanced regroup: DSP/tone-tuning states moved under sound.*, setup-only states
  // (+ the speakers/initialVolume/inputNames subtrees, already dotted before) under advanced.*.
  // {@link renamedObjectIds} also checks these against a stripped zone2/3/4 prefix, so one
  // entry here catches a MAIN state and its zoned copies (e.g. "straight" and "zone2.straight").
  "straight",
  "enhancer",
  "pureDirect",
  "direct",
  "adaptiveDrc",
  "surroundAI",
  "surroundDecoder",
  "cinemaDsp3d",
  "extraBass",
  "bass",
  "treble",
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
  "clearVoice",
  "bassExtension",
  "ypaoVolume",
  "maxVolume",
  "speakerA",
  "speakerB",
  "speakers",
  "initialVolume",
  "inputNames",
];

/**
 * The full ids of renamed old states (and old channel subtrees) that still exist
 * under a configured device, to be deleted on start-up so no orphan lingers beside
 * the new object. Deepest first, so children go before their parents.
 *
 * @param existing all object ids currently under the instance
 * @param deviceIds the ids of the currently configured devices
 * @param namespace the adapter namespace (e.g. `yamaha.0`)
 * @returns the full old ids to delete, deepest first
 */
export function renamedObjectIds(existing: string[], deviceIds: Set<string>, namespace: string): string[] {
  const stale: string[] = [];
  for (const deviceId of deviceIds) {
    const base = `${namespace}.${deviceId}.`;
    for (const full of existing) {
      if (!full.startsWith(base)) {
        continue;
      }
      const rel = full.slice(base.length);
      // Strip an optional zone2/3/4 prefix before matching too, so one RENAMED_CHANNELS entry
      // (e.g. "straight") catches both the MAIN state and its zoned copies ("zone2.straight").
      const zone = /^zone[234]\./.exec(rel)?.[0] ?? "";
      const template = rel.slice(zone.length);
      const renamedState = RENAMED_STATE_IDS.includes(rel) || RENAMED_STATE_IDS.includes(template);
      const underRenamedChannel = RENAMED_CHANNELS.some(
        ch => rel === ch || rel.startsWith(`${ch}.`) || template === ch || template.startsWith(`${ch}.`),
      );
      if (renamedState || underRenamedChannel) {
        stale.push(full);
      }
    }
  }
  return stale.sort((a, b) => b.length - a.length);
}

/**
 * The device row to carry over from the previous adapter's single-device config,
 * or undefined if nothing needs migrating. The old yamaha stored one receiver as
 * `config.ip` (older installs: `config.IP`); the new adapter uses a `devices`
 * table. Only migrates when the table is still empty, so it runs once.
 *
 * @param config the instance's native config
 * @returns the row to add to the devices table, or undefined
 */
export function legacyDeviceRow(config: Record<string, unknown>): { name: string; ip: string } | undefined {
  if (Array.isArray(config.devices) && config.devices.length > 0) {
    return undefined;
  }
  const ip =
    typeof config.ip === "string" && config.ip
      ? config.ip
      : typeof config.IP === "string" && config.IP
        ? config.IP
        : undefined;
  return ip ? { name: ip, ip } : undefined;
}
