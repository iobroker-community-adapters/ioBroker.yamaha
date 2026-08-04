import type { DeviceRecord } from "./types";

interface ConfiguredDevice {
  name: string;
  ip: string;
}

/**
 * True when a raw config row carries a non-empty string name and ip.
 *
 * @param entry a raw config row from the admin device table
 * @returns whether the row is a valid configured device
 */
function isConfiguredDevice(entry: unknown): entry is ConfiguredDevice {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const candidate = entry as Partial<ConfiguredDevice>;
  return (
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    typeof candidate.ip === "string" &&
    candidate.ip.length > 0
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
 * Invalid rows are dropped; protocols start empty and are probed in later phases.
 *
 * @param raw the raw `native.devices` value
 * @returns validated device records
 */
export function parseDevices(raw: unknown): DeviceRecord[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const records: DeviceRecord[] = [];
  for (const entry of raw) {
    if (isConfiguredDevice(entry)) {
      records.push({ id: sanitizeId(entry.name), ip: entry.ip, protocols: new Set() });
    }
  }
  return records;
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
