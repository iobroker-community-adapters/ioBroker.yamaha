import type { DeviceRecord } from "./types";
import { errorMessage } from "./util";

/**
 * File access for the discovered-devices store, injected so the pure logic can be
 * tested without a filesystem. In the adapter these read/write a JSON file in the
 * instance data directory.
 */
export interface DiscoveredStoreDeps {
  /** Read the store file's content, or resolve undefined when it does not exist. */
  read(): Promise<string | undefined>;
  /** Write the store file's content. */
  write(content: string): Promise<void>;
  /** Logger for diagnostics. */
  log: { debug(message: string): void };
}

/**
 * A stored entry is a device record only when both id and ip are strings.
 *
 * @param entry a parsed store entry
 * @returns whether it is a usable device record
 */
function isRecord(entry: unknown): entry is DeviceRecord {
  const candidate = entry as Partial<DeviceRecord> | null;
  return typeof candidate?.id === "string" && typeof candidate?.ip === "string";
}

/**
 * Read the devices remembered from earlier auto-discovery runs. A missing or
 * corrupt store yields an empty list rather than an error — losing the memory is
 * recoverable (the next scan refills it), a crash on start is not.
 *
 * @param deps file access and logger
 * @returns the remembered device records (empty when none/unreadable)
 */
export async function readDiscovered(deps: DiscoveredStoreDeps): Promise<DeviceRecord[]> {
  try {
    const raw = await deps.read();
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch (e) {
    deps.log.debug(`discovered store: read failed, starting empty (${errorMessage(e)})`);
    return [];
  }
}

/**
 * Persist the devices found by auto-discovery so a device in deep standby survives
 * a restart. A write failure is logged and swallowed — it only costs the standby
 * protection until the next successful run, it must not break startup.
 *
 * @param deps file access and logger
 * @param devices the device records to remember
 */
export async function writeDiscovered(deps: DiscoveredStoreDeps, devices: DeviceRecord[]): Promise<void> {
  try {
    await deps.write(JSON.stringify(devices));
  } catch (e) {
    deps.log.debug(`discovered store: write failed (${errorMessage(e)})`);
  }
}
