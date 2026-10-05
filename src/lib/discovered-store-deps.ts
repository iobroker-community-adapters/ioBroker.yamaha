import * as utils from "@iobroker/adapter-core";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DiscoveredStoreDeps } from "./discovered-store";

/**
 * The discovered-devices store's file-access deps, bound to an adapter — a JSON file in the
 * instance data directory (no `native` write, so no restart). Shared by the adapter's
 * auto-discovery and the device-manager's delete-of-discovered, so both always target the
 * same file (a diverging path would silently resurrect a deleted device on the next start).
 *
 * @param adapter the adapter instance (for the data dir and the log)
 * @returns the store's read/write/log dependencies
 */
export function discoveredStoreDeps(adapter: ioBroker.Adapter): DiscoveredStoreDeps {
  return fileStoreDeps(adapter, "discovered.json");
}

/**
 * The ignored-devices store's file-access deps — the device ids the user deleted from the
 * auto-discovered list, so a following network search does not put them back. Its own file
 * next to the discovered one, so neither format has to migrate.
 *
 * @param adapter the adapter instance (for the data dir and the log)
 * @returns the store's read/write/log dependencies
 */
export function ignoredStoreDeps(adapter: ioBroker.Adapter): DiscoveredStoreDeps {
  return fileStoreDeps(adapter, "ignored.json");
}

/**
 * One JSON file in the instance data directory as store deps (no `native` write, so no restart).
 *
 * Only a file that is not there yet reads as "nothing stored" (`undefined`). Every other failure — EACCES after a backup
 * was restored as root, EIO, a directory in the file's place — rejects: an unreadable store is not an empty one, and the
 * start cleanup took an empty one for "no device remembered" and deleted every remembered device's tree (review
 * 2026-10-05, A2).
 *
 * @param adapter the adapter instance (for the data dir and the log)
 * @param fileName the file inside the instance data directory
 * @returns the store's read/write/log dependencies
 */
function fileStoreDeps(adapter: ioBroker.Adapter, fileName: string): DiscoveredStoreDeps {
  const path = join(utils.getAbsoluteInstanceDataDir(adapter), fileName);
  return {
    read: async () => {
      try {
        return await readFile(path, "utf8");
      } catch (e) {
        if ((e as { code?: unknown } | null)?.code === "ENOENT") {
          return undefined;
        }
        throw e;
      }
    },
    write: content => writeAtomically(path, content),
    log: { debug: message => adapter.log.debug(message) },
  };
}

/**
 * Replace a file in one step: the content goes into a temporary file beside it, is flushed to the disk, and the temporary
 * file is then renamed over the old one. `writeFile` truncates first — a power cut between the truncate and the write left
 * a 0-byte store behind (review 2026-10-05, A2). A rename within one directory replaces the file whole, so a reader sees
 * either the old content or the new one.
 *
 * @param path the file to replace
 * @param content its new content
 */
async function writeAtomically(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  const file = await open(temporary, "w");
  try {
    await file.writeFile(content, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}

/**
 * The exclusion store's file-access deps — `excluded.json` next to `ignored.json`: the entries
 * carry address and identity, which the plain id list cannot (see `readExcluded`).
 *
 * @param adapter the adapter instance (for the data dir and the log)
 * @returns the store's read/write/log dependencies
 */
export function excludedStoreDeps(adapter: ioBroker.Adapter): DiscoveredStoreDeps {
  return fileStoreDeps(adapter, "excluded.json");
}
