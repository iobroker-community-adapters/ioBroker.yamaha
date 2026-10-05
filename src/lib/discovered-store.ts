import { sameDevice, type DeviceIdentity } from "./device-identity";
import type { DeviceRecord } from "./types";
import { errText } from "./err-text";

/**
 * File access for the discovered-devices store, injected so the pure logic can be
 * tested without a filesystem. In the adapter these read/write a JSON file in the
 * instance data directory.
 */
export interface DiscoveredStoreDeps {
  /**
   * Read the store file's content; resolve undefined when the file does not exist — and ONLY then: any other failure
   * rejects (an unreadable store is not an empty one, review 2026-10-05, A2).
   */
  read(): Promise<string | undefined>;
  /** Replace the store file's content (atomically). */
  write(content: string): Promise<void>;
  /** Logger for diagnostics. */
  log: { debug(message: string): void };
}

/** What one JSON list file holds — and whether it could be read at all. */
export interface ListRead<T> {
  /** The usable entries (empty when the file is missing or unreadable). */
  items: T[];
  /**
   * False when the file exists but could not be read, is empty, or holds no JSON list. Such a file is never the same as an
   * empty one: a store that cannot be read must not be the reason a remembered device's tree is deleted, nor be written
   * over with what one search found (review 2026-10-05, A2/A28).
   */
  readable: boolean;
  /** Why it could not be read, for the log line. */
  problem?: string;
}

/**
 * Read one JSON list file — the one reader of the three stores (`discovered.json`, `excluded.json`, `ignored.json`).
 * Only a missing file is an empty list. An empty file is a write that was cut off (a power cut between the truncate and
 * the write of the earlier non-atomic writer), not an empty list.
 *
 * @param deps file access
 * @param isItem whether a parsed entry is usable — the others are dropped
 * @returns the entries and whether the file could be read
 */
export async function readJsonList<T>(
  deps: Pick<DiscoveredStoreDeps, "read">,
  isItem: (entry: unknown) => entry is T,
): Promise<ListRead<T>> {
  let raw: string | undefined;
  try {
    raw = await deps.read();
  } catch (e) {
    return { items: [], readable: false, problem: errText(e) };
  }
  if (raw === undefined) {
    return { items: [], readable: true };
  }
  if (raw.trim() === "") {
    return { items: [], readable: false, problem: "the file is empty" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { items: [], readable: false, problem: errText(e) };
  }
  if (!Array.isArray(parsed)) {
    return { items: [], readable: false, problem: "the file holds no list" };
  }
  return { items: parsed.filter(isItem), readable: true };
}

/**
 * The entries of one list read, telling `unreadable` when the file could not be read. The readers keep their array result
 * (the store owner, `device-stores.ts`, learns the verdict through the callback).
 *
 * @param read what {@link readJsonList} returned
 * @param unreadable told why, when the file could not be read
 * @returns the entries
 */
function itemsOf<T>(read: ListRead<T>, unreadable?: (problem: string) => void): T[] {
  if (!read.readable) {
    unreadable?.(read.problem ?? "unreadable");
  }
  return read.items;
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
 * Read the devices remembered from earlier auto-discovery runs. A missing store is an empty list; an unreadable one is an
 * empty list too, but `unreadable` is told — never a reason to delete a remembered device's tree or to write over the file.
 *
 * @param deps file access and logger
 * @param unreadable told why, when the file exists but cannot be read
 * @returns the remembered device records (empty when none/unreadable)
 */
export async function readDiscovered(
  deps: DiscoveredStoreDeps,
  unreadable?: (problem: string) => void,
): Promise<DeviceRecord[]> {
  return itemsOf(await readJsonList(deps, isRecord), unreadable);
}

/**
 * Write one list. A failure is logged and swallowed — the caller learns it from the result.
 *
 * @param deps file access and logger
 * @param what the store's name, for the log line
 * @param content the JSON to store
 * @returns whether the file was written
 */
async function writeList(deps: DiscoveredStoreDeps, what: string, content: string): Promise<boolean> {
  try {
    await deps.write(content);
    return true;
  } catch (e) {
    deps.log.debug(`${what} store: write failed (${errText(e)})`);
    return false;
  }
}

/**
 * Persist the devices found by auto-discovery so a device in deep standby survives a restart. A write failure is logged
 * and swallowed — it costs the standby protection until the next successful write, it must not break startup.
 *
 * @param deps file access and logger
 * @param devices the device records to remember
 * @returns whether the file was written
 */
export function writeDiscovered(deps: DiscoveredStoreDeps, devices: DeviceRecord[]): Promise<boolean> {
  return writeList(deps, "discovered", JSON.stringify(devices));
}

/**
 * A stored 2.x exclusion is a plain id.
 *
 * @param entry a parsed store entry
 * @returns whether it is an id
 */
function isId(entry: unknown): entry is string {
  return typeof entry === "string";
}

/**
 * Read the device ids the user removed from the auto-discovered list under 2.x (`ignored.json`).
 *
 * A delete writes `excluded.json` (since 2.12.0); this list is read for the entries 2.x left and shrinks
 * when the user admits one of them again — nothing adds to it (audit 2026-09-29, A31: an id 3.0.0
 * wrote here never matched on a rollback, 2.x derives its ids from the name).
 *
 * @param deps file access and logger
 * @param unreadable told why, when the file exists but cannot be read
 * @returns the ignored device ids (empty when none/unreadable)
 */
export async function readIgnored(
  deps: DiscoveredStoreDeps,
  unreadable?: (problem: string) => void,
): Promise<string[]> {
  return itemsOf(await readJsonList(deps, isId), unreadable);
}

/**
 * Persist the ignored device ids, each once. A write failure is logged and swallowed: it only leaves a re-admitted id on
 * the list until the next successful write.
 *
 * @param deps file access and logger
 * @param ids the device ids to keep out of auto-discovery
 * @returns whether the file was written
 */
export function writeIgnored(deps: DiscoveredStoreDeps, ids: readonly string[]): Promise<boolean> {
  return writeList(deps, "ignored", JSON.stringify([...new Set(ids)]));
}

/** One device the user deleted from the card list — kept out of every following search. */
export interface ExcludedEntry {
  /** The object-tree id the card had. */
  id: string;
  /** The address it had when it was deleted (matched only while no identity is known). */
  ip?: string;
  /** The device's serial/MAC when known — the match that survives a rename and a new address. */
  identity?: DeviceIdentity;
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
 * Read the exclusion entries — every delete since 2.12.0 lands here. They live NEXT to `ignored.json`
 * (2.x's plain id list), not inside it: the 2.11.0 reader keeps only strings, so objects in that file
 * would vanish on a rollback. An unreadable file reads empty but tells `unreadable`: written over, every earlier delete
 * would be undone (review 2026-10-05, A28).
 *
 * @param deps file access and logger
 * @param unreadable told why, when the file exists but cannot be read
 * @returns the entries (empty when none/unreadable)
 */
export async function readExcluded(
  deps: DiscoveredStoreDeps,
  unreadable?: (problem: string) => void,
): Promise<ExcludedEntry[]> {
  return itemsOf(await readJsonList(deps, isExcludedEntry), unreadable);
}

/**
 * Persist the exclusion entries, one per id (the later entry wins). A write failure is logged and swallowed; the caller
 * learns it from the result — a delete whose exclusion was not written is no delete (Y-13).
 *
 * @param deps file access and logger
 * @param entries the entries to keep out of auto-discovery
 * @returns whether the file was written
 */
export function writeExcluded(deps: DiscoveredStoreDeps, entries: readonly ExcludedEntry[]): Promise<boolean> {
  const byId = new Map<string, ExcludedEntry>();
  for (const entry of entries) {
    byId.set(entry.id, entry);
  }
  return writeList(deps, "excluded", JSON.stringify([...byId.values()]));
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
 * @param candidate.id its object-tree id (the stored one: model and serial under the 3.0.0 rule)
 * @param candidate.ip the address it answered at
 * @param candidate.identity its serial/MAC when the description carried one
 * @returns whether the candidate stays out
 */
export function isExcluded(
  ignoredIds: readonly string[],
  excluded: readonly ExcludedEntry[],
  candidate: { id: string; ip: string; identity?: DeviceIdentity },
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
