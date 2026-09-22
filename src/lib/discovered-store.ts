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

/**
 * Read the device ids the user removed from the auto-discovered list.
 *
 * Deleting a discovered device only ever emptied the remembered list, so the next network
 * search found the receiver again and put it straight back — the delete button was undone by
 * the adapter itself. The ids kept here are skipped by every following search.
 *
 * @param deps file access and logger
 * @returns the ignored device ids (empty when none/unreadable)
 */
export async function readIgnored(deps: DiscoveredStoreDeps): Promise<string[]> {
  try {
    const raw = await deps.read();
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch (e) {
    deps.log.debug(`ignored store: read failed, starting empty (${errorMessage(e)})`);
    return [];
  }
}

/**
 * Persist the ignored device ids. A write failure is logged and swallowed for the same reason
 * as the discovered store's: it costs the exclusion until the next successful run, it must not
 * break startup or the delete action.
 *
 * @param deps file access and logger
 * @param ids the device ids to keep out of auto-discovery
 */
export async function writeIgnored(deps: DiscoveredStoreDeps, ids: readonly string[]): Promise<void> {
  try {
    await deps.write(JSON.stringify([...new Set(ids)]));
  } catch (e) {
    deps.log.debug(`ignored store: write failed (${errorMessage(e)})`);
  }
}

/** One device the user deleted from the card list — kept out of every following search. */
export interface ExcludedEntry {
  /** The object-tree id the card had. */
  id: string;
  /** The address it had when it was deleted (matched only while no identity is known). */
  ip?: string;
  /** The device's serial/MAC when known — the match that survives a rename and a new address. */
  identity?: { serial?: string; mac?: string };
}

/**
 * Same physical device: an equal serial or an equal MAC, both sides set. (Moves to
 * `device-identity.ts` once that module exists — kept local so this store has no dependency.)
 *
 * @param a one identity
 * @param b the other
 * @returns whether they name the same device
 */
function sameDevice(a?: ExcludedEntry["identity"], b?: ExcludedEntry["identity"]): boolean {
  if (!a || !b) {
    return false;
  }
  return (!!a.serial && a.serial === b.serial) || (!!a.mac && a.mac === b.mac);
}

/**
 * A stored exclusion is usable only with a string id.
 *
 * @param entry a parsed store entry
 * @returns whether it is an exclusion entry
 */
function isExcludedEntry(entry: unknown): entry is ExcludedEntry {
  const candidate = entry as Partial<ExcludedEntry> | null;
  return typeof candidate?.id === "string";
}

/**
 * Read the exclusion entries. They live NEXT to `ignored.json` (a plain id list), not inside
 * it: the 2.11.0 reader keeps only strings, so objects in that file would vanish on a rollback
 * and every deleted device would come back.
 *
 * @param deps file access and logger
 * @returns the entries (empty when none/unreadable)
 */
export async function readExcluded(deps: DiscoveredStoreDeps): Promise<ExcludedEntry[]> {
  try {
    const raw = await deps.read();
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isExcludedEntry) : [];
  } catch (e) {
    deps.log.debug(`excluded store: read failed, starting empty (${errorMessage(e)})`);
    return [];
  }
}

/**
 * Persist the exclusion entries, one per id (the later entry wins). A write failure is logged
 * and swallowed for the same reason as the id list's: it must not break the delete action.
 *
 * @param deps file access and logger
 * @param entries the entries to keep out of auto-discovery
 */
export async function writeExcluded(deps: DiscoveredStoreDeps, entries: readonly ExcludedEntry[]): Promise<void> {
  const byId = new Map<string, ExcludedEntry>();
  for (const entry of entries) {
    byId.set(entry.id, entry);
  }
  try {
    await deps.write(JSON.stringify([...byId.values()]));
  } catch (e) {
    deps.log.debug(`excluded store: write failed (${errorMessage(e)})`);
  }
}

/**
 * Whether a found device is one the user deleted. Three matches, strongest first: the device's
 * identity, the id, and — only for an entry that never learned an identity — the address it
 * was deleted at. An entry WITH identity does not match by address: that address is free for
 * the next device that gets it.
 *
 * @param ignoredIds the plain id list (`ignored.json`)
 * @param excluded the exclusion entries (`excluded.json`)
 * @param candidate the found device
 * @param candidate.id its object-tree id (derived from the name it advertises)
 * @param candidate.ip the address it answered at
 * @param candidate.identity its serial/MAC when the description carried one
 * @returns whether the candidate stays out
 */
export function isExcluded(
  ignoredIds: readonly string[],
  excluded: readonly ExcludedEntry[],
  candidate: { id: string; ip: string; identity?: ExcludedEntry["identity"] },
): boolean {
  if (ignoredIds.includes(candidate.id)) {
    return true;
  }
  return excluded.some(entry => {
    if (entry.id === candidate.id) {
      return true;
    }
    if (entry.identity) {
      return sameDevice(entry.identity, candidate.identity);
    }
    return entry.ip !== undefined && entry.ip === candidate.ip;
  });
}
