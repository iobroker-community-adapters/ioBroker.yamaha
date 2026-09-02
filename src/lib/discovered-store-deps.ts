import * as utils from "@iobroker/adapter-core";
import { readFile, writeFile, mkdir } from "node:fs/promises";
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
      } catch {
        return undefined;
      }
    },
    write: async content => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
    },
    log: { debug: message => adapter.log.debug(message) },
  };
}
