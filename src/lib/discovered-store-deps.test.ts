import { vi } from "vitest";

/**
 * The store's file access. Both the adapter's auto-discovery AND the device
 * manager's delete-of-discovered build their deps here — a diverging path would
 * silently resurrect a deleted device on the next start, which is why the path is
 * pinned by a test rather than left to two call sites.
 */
const fsMock = vi.hoisted(() => ({
  files: new Map<string, string>(),
  mkdirs: [] as string[],
  readError: null as Error | null,
  /** Every step of a write, in order — the atomic replace is temporary file, flush, close, rename. */
  steps: [] as string[],
  /** When set, the flush of the temporary file fails (a disk that is full). */
  syncError: null as Error | null,
}));
/**
 * An fs error as node raises it: the reason in `code`.
 *
 * @param code the error code
 * @returns the error
 */
function fsError(code: string): Error {
  return Object.assign(new Error(`${code}: test`), { code });
}
vi.mock("node:fs/promises", () => ({
  readFile: (path: string) => {
    if (fsMock.readError) {
      return Promise.reject(fsMock.readError);
    }
    const content = fsMock.files.get(path);
    if (content === undefined) {
      return Promise.reject(fsError("ENOENT"));
    }
    return Promise.resolve(content);
  },
  open: (path: string) => {
    fsMock.steps.push(`open ${path}`);
    let content = "";
    return Promise.resolve({
      writeFile: (text: string) => {
        content = text;
        return Promise.resolve();
      },
      sync: () => {
        fsMock.steps.push("sync");
        return fsMock.syncError ? Promise.reject(fsMock.syncError) : Promise.resolve();
      },
      close: () => {
        fsMock.steps.push("close");
        fsMock.files.set(path, content);
        return Promise.resolve();
      },
    });
  },
  rename: (from: string, to: string) => {
    fsMock.steps.push(`rename ${from} -> ${to}`);
    const content = fsMock.files.get(from);
    fsMock.files.delete(from);
    if (content !== undefined) {
      fsMock.files.set(to, content);
    }
    return Promise.resolve();
  },
  mkdir: (path: string) => {
    fsMock.mkdirs.push(path);
    return Promise.resolve();
  },
}));
vi.mock("@iobroker/adapter-core", () => ({
  getAbsoluteInstanceDataDir: (adapter: { namespace: string }) => `/opt/iobroker/iobroker-data/${adapter.namespace}`,
}));

import { join } from "node:path";
import { discoveredStoreDeps, excludedStoreDeps, ignoredStoreDeps } from "./discovered-store-deps";

/**
 * The data directory as the module under test builds it. Spelled with `join` because
 * that is what the source uses: on Windows it produces backslashes, and a hard-coded
 * slash path would fail there while the adapter itself is perfectly fine.
 */
const dataDir = join("/opt/iobroker/iobroker-data/yamaha.0");

const adapter = { namespace: "yamaha.0", log: { debug: vi.fn() } } as unknown as ioBroker.Adapter;

beforeEach(() => {
  fsMock.files.clear();
  fsMock.mkdirs.length = 0;
  fsMock.readError = null;
  fsMock.steps.length = 0;
  fsMock.syncError = null;
});

describe("discoveredStoreDeps", () => {
  it("reads and writes the same file in the instance data directory", async () => {
    const deps = discoveredStoreDeps(adapter);
    await deps.write('[{"id":"RX-V685","ip":"192.168.1.20"}]');
    // The write must create the directory: on a fresh instance it does not exist
    // yet, and an ENOENT here would lose every discovery result silently.
    expect(fsMock.mkdirs).toEqual([dataDir]);
    await expect(deps.read()).resolves.toBe('[{"id":"RX-V685","ip":"192.168.1.20"}]');
    expect([...fsMock.files.keys()]).toEqual([join(dataDir, "discovered.json")]);
  });

  it("reports no content instead of throwing when the file is not there yet", async () => {
    // The very first start has no file. A throw would abort onReady before any
    // device is set up.
    await expect(discoveredStoreDeps(adapter).read()).resolves.toBeUndefined();
  });

  // Review 2026-10-05, A2: EACCES (a backup restored as root), EIO or a directory in the file's place read as "no file",
  // and the start cleanup deleted every remembered device's tree.
  it("rejects every other read failure — an unreadable store is not an empty one", async () => {
    for (const code of ["EACCES", "EIO", "EISDIR"]) {
      fsMock.readError = fsError(code);
      await expect(discoveredStoreDeps(adapter).read()).rejects.toThrow(code);
    }
  });

  // Review 2026-10-05, A2: writeFile truncates first — a power cut between the truncate and the write left a 0-byte store.
  it("replaces the file in one step: temporary file, flushed, then renamed over it", async () => {
    const path = join(dataDir, "discovered.json");
    fsMock.files.set(path, "[]");
    await discoveredStoreDeps(adapter).write('[{"id":"wx","ip":"10.0.0.6"}]');
    expect(fsMock.steps).toEqual([`open ${path}.tmp`, "sync", "close", `rename ${path}.tmp -> ${path}`]);
    expect(fsMock.files.get(path)).toBe('[{"id":"wx","ip":"10.0.0.6"}]');
    expect(fsMock.files.has(`${path}.tmp`)).toBe(false);
  });

  it("a write that fails before the rename leaves the stored file as it was", async () => {
    const path = join(dataDir, "discovered.json");
    fsMock.files.set(path, '[{"id":"kept","ip":"10.0.0.5"}]');
    fsMock.syncError = fsError("ENOSPC");
    await expect(discoveredStoreDeps(adapter).write("[]")).rejects.toThrow("ENOSPC");
    expect(fsMock.steps).not.toContain(`rename ${path}.tmp -> ${path}`);
    expect(fsMock.files.get(path)).toBe('[{"id":"kept","ip":"10.0.0.5"}]');
  });

  it("logs through the adapter", () => {
    discoveredStoreDeps(adapter).log.debug("hello");
    expect(adapter.log.debug).toHaveBeenCalledWith("hello");
  });
});

describe("ignoredStoreDeps and excludedStoreDeps", () => {
  it("keep their own files next to the discovery store — the id list stays readable by 2.11.0", async () => {
    await ignoredStoreDeps(adapter).write('["RX-V685"]');
    await excludedStoreDeps(adapter).write('[{"id":"RX-V685","ip":"192.168.1.20"}]');
    expect([...fsMock.files.keys()]).toEqual([join(dataDir, "ignored.json"), join(dataDir, "excluded.json")]);
    await expect(ignoredStoreDeps(adapter).read()).resolves.toBe('["RX-V685"]');
    await expect(excludedStoreDeps(adapter).read()).resolves.toBe('[{"id":"RX-V685","ip":"192.168.1.20"}]');
  });
});
