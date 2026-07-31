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
      records.push({ id: entry.name, ip: entry.ip, protocols: new Set() });
    }
  }
  return records;
}
