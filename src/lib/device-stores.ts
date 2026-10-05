import {
  isExcluded,
  readDiscovered,
  readExcluded,
  readIgnored,
  writeDiscovered,
  writeExcluded,
  writeIgnored,
  type DiscoveredStoreDeps,
  type ExcludedEntry,
} from "./discovered-store";
import { discoveredStoreDeps, excludedStoreDeps, ignoredStoreDeps } from "./discovered-store-deps";
import type { DeviceRecord } from "./types";

/**
 * The ONE owner of the three lists in the instance data directory — `discovered.json` (what the search found),
 * `excluded.json` (what the user deleted) and `ignored.json` (2.x's deletes) — for the adapter and the device manager
 * alike (review 2026-10-05, A2/A28/A31).
 *
 * Six writers used to read, change and write `discovered.json` each on its own: a delete in the device manager that fell
 * between a search's read and its write came back with the search's write. Every change now runs as one step on one
 * promise chain: the three lists are read, the change is computed on what was read, the lists are written — and the next
 * step starts only after that. A list whose file could not be read is never written over: a broken `excluded.json` read
 * as empty, and the next delete wrote one entry over all the earlier ones (Y-13).
 */

/** The three lists. */
export type StoreName = "discovered" | "excluded" | "ignored";

/** The order the lists are written in: the exclusions first — a search running meanwhile must already read them. */
const WRITE_ORDER: readonly StoreName[] = ["excluded", "ignored", "discovered"];

/** The file of each list, for the log lines. */
const FILE_OF: Readonly<Record<StoreName, string>> = {
  discovered: "discovered.json",
  excluded: "excluded.json",
  ignored: "ignored.json",
};

/** What a list that cannot be read costs until it can — said once in the warning. */
const CONSEQUENCE: Readonly<Record<StoreName, string>> = {
  discovered:
    "found devices run but are not remembered across a restart, and no remembered device's objects are removed",
  excluded: "the search adds no new device (it could be one you deleted), and no device can be deleted",
  ignored: "the search adds no new device (it could be one you deleted), and no device can be deleted",
};

/** The three lists as one read saw them. */
export interface StoreSnapshot {
  /** The devices the search found and remembers. */
  discovered: DeviceRecord[];
  /** The devices the user deleted. */
  excluded: ExcludedEntry[];
  /** The ids 2.x kept out of the search. */
  ignored: string[];
  /** The lists whose file exists but could not be read — empty here, and never written over. */
  unreadable: ReadonlySet<StoreName>;
}

/** New contents for some of the lists — a list left out stays as it is. */
export interface StoreChanges {
  /** The new `discovered.json`. */
  discovered?: DeviceRecord[];
  /** The new `excluded.json`. */
  excluded?: ExcludedEntry[];
  /** The new `ignored.json`. */
  ignored?: string[];
}

/**
 * What became of one list's change: `written`; `unchanged` (the same as stored, nothing written); `refused` (its file
 * could not be read, so it is not written over); `failed` (the write failed); `skipped` (an earlier list of the same
 * change was refused or failed — the parts of one change go together or not at all).
 */
export type ListWrite = "written" | "unchanged" | "refused" | "failed" | "skipped";

/** What became of each list a change named. */
export type StoreWrites = Partial<Record<StoreName, ListWrite>>;

/** The lines the owner writes. */
export interface StoreLog {
  /** Routine. */
  debug(message: string): void;
  /** A list that cannot be read — once per outage. */
  warn(message: string): void;
}

/**
 * The remembered devices the user did not delete — the one exclusion filter every path applies: the start, the idle
 * devices, the start cleanup, the device cards (review 2026-10-05, A31). A record that is in the store AND excluded is a
 * delete whose store write failed; it must not come back as an idle device, a card or a kept tree.
 *
 * @param now what the stores hold
 * @returns the remembered records that are not excluded
 */
export function rememberedDevices(now: StoreSnapshot): DeviceRecord[] {
  return now.discovered.filter(device => !isExcluded(now.ignored, now.excluded, device));
}

/** The owner of the three lists — see the module comment. */
export class DeviceStores {
  /** The step in flight; the next one starts behind it. */
  private chain: Promise<unknown> = Promise.resolve();
  /** The lists already warned about in this outage. */
  private readonly warned = new Set<StoreName>();

  /**
   * @param files the file access of each list
   * @param log where the owner reports
   */
  public constructor(
    private readonly files: Readonly<Record<StoreName, DiscoveredStoreDeps>>,
    private readonly log: StoreLog,
  ) {}

  /**
   * The three lists as they are now — behind every change in flight.
   *
   * @returns the snapshot
   */
  public read(): Promise<StoreSnapshot> {
    return this.queue(() => this.readAll());
  }

  /**
   * Change the lists in one step: read all three, compute the change on what was read, write what changed. The change
   * function runs once, synchronously, on the chain — it must not call the owner again (it would wait for itself).
   *
   * @param change the new contents of the lists that change, or undefined for none
   * @returns what became of each list the change named
   */
  public update(change: (now: StoreSnapshot) => StoreChanges | undefined): Promise<StoreWrites> {
    return this.queue(async () => {
      const now = await this.readAll();
      const next = change(now) ?? {};
      const writes: StoreWrites = {};
      let stopped = false;
      for (const name of WRITE_ORDER) {
        const content = next[name];
        if (content === undefined) {
          continue;
        }
        if (stopped) {
          writes[name] = "skipped";
          continue;
        }
        writes[name] = await this.writeOne(name, content, now);
        stopped = writes[name] === "refused" || writes[name] === "failed";
      }
      return writes;
    });
  }

  /**
   * Run one step behind the one in flight.
   *
   * @param run the step
   * @returns what the step returns
   */
  private queue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /**
   * Read the three lists, noting the ones that cannot be read.
   *
   * @returns the snapshot
   */
  private async readAll(): Promise<StoreSnapshot> {
    const unreadable = new Set<StoreName>();
    const note =
      (name: StoreName) =>
      (problem: string): void => {
        unreadable.add(name);
        this.reportUnreadable(name, problem);
      };
    const discovered = await readDiscovered(this.files.discovered, note("discovered"));
    const excluded = await readExcluded(this.files.excluded, note("excluded"));
    const ignored = await readIgnored(this.files.ignored, note("ignored"));
    for (const name of WRITE_ORDER) {
      if (!unreadable.has(name)) {
        this.warned.delete(name); // readable again — a new outage is warned about again
      }
    }
    return { discovered, excluded, ignored, unreadable };
  }

  /**
   * Write one list of a change.
   *
   * @param name the list
   * @param content its new content
   * @param now what the read of this step saw
   * @returns what became of it
   */
  private async writeOne(
    name: StoreName,
    content: DeviceRecord[] | ExcludedEntry[] | string[],
    now: StoreSnapshot,
  ): Promise<ListWrite> {
    if (JSON.stringify(content) === JSON.stringify(now[name])) {
      return "unchanged";
    }
    if (now.unreadable.has(name)) {
      this.log.debug(`${FILE_OF[name]}: not written — the file could not be read, and what it holds is kept`);
      return "refused";
    }
    const written =
      name === "discovered"
        ? await writeDiscovered(this.files.discovered, content as DeviceRecord[])
        : name === "excluded"
          ? await writeExcluded(this.files.excluded, content as ExcludedEntry[])
          : await writeIgnored(this.files.ignored, content as string[]);
    // A test double of the writers answers nothing — only an explicit `false` is a failed write.
    return written === false ? "failed" : "written";
  }

  /**
   * Say that a list cannot be read: once per outage at warn, then at debug.
   *
   * @param name the list
   * @param problem why
   */
  private reportUnreadable(name: StoreName, problem: string): void {
    const line = `${FILE_OF[name]} cannot be read (${problem}) — it is kept as it is and not written to; ${CONSEQUENCE[name]} until it can be read again`;
    if (this.warned.has(name)) {
      this.log.debug(line);
      return;
    }
    this.warned.add(name);
    this.log.warn(line);
  }
}

/**
 * The store owner over an adapter's instance data directory.
 *
 * @param adapter the adapter (data directory and log)
 * @returns the owner — make ONE per adapter and hand it to everything that reads or writes the lists
 */
export function deviceStoresOf(adapter: ioBroker.Adapter): DeviceStores {
  return new DeviceStores(
    {
      discovered: discoveredStoreDeps(adapter),
      excluded: excludedStoreDeps(adapter),
      ignored: ignoredStoreDeps(adapter),
    },
    adapter.log,
  );
}
