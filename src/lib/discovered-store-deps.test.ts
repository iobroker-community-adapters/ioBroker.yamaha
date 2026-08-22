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
}));
vi.mock("node:fs/promises", () => ({
  readFile: async (path: string) => {
    if (fsMock.readError) {
      throw fsMock.readError;
    }
    const content = fsMock.files.get(path);
    if (content === undefined) {
      throw new Error("ENOENT");
    }
    return content;
  },
  writeFile: async (path: string, content: string) => {
    fsMock.files.set(path, content);
  },
  mkdir: async (path: string) => {
    fsMock.mkdirs.push(path);
  },
}));
vi.mock("@iobroker/adapter-core", () => ({
  getAbsoluteInstanceDataDir: (adapter: { namespace: string }) => `/opt/iobroker/iobroker-data/${adapter.namespace}`,
}));

import { discoveredStoreDeps } from "./discovered-store-deps";

const adapter = { namespace: "yamaha.0", log: { debug: vi.fn() } } as unknown as ioBroker.Adapter;

beforeEach(() => {
  fsMock.files.clear();
  fsMock.mkdirs.length = 0;
  fsMock.readError = null;
});

describe("discoveredStoreDeps", () => {
  it("reads and writes the same file in the instance data directory", async () => {
    const deps = discoveredStoreDeps(adapter);
    await deps.write('[{"id":"RX-V685","ip":"192.168.1.20"}]');
    // The write must create the directory: on a fresh instance it does not exist
    // yet, and an ENOENT here would lose every discovery result silently.
    expect(fsMock.mkdirs).toEqual(["/opt/iobroker/iobroker-data/yamaha.0"]);
    await expect(deps.read()).resolves.toBe('[{"id":"RX-V685","ip":"192.168.1.20"}]');
    expect([...fsMock.files.keys()]).toEqual(["/opt/iobroker/iobroker-data/yamaha.0/discovered.json"]);
  });

  it("reports no content instead of throwing when the file is not there yet", async () => {
    // The very first start has no file. A throw would abort onReady before any
    // device is set up.
    await expect(discoveredStoreDeps(adapter).read()).resolves.toBeUndefined();
    fsMock.readError = new Error("EACCES");
    await expect(discoveredStoreDeps(adapter).read()).resolves.toBeUndefined();
  });

  it("logs through the adapter", () => {
    discoveredStoreDeps(adapter).log.debug("hello");
    expect(adapter.log.debug).toHaveBeenCalledWith("hello");
  });
});
