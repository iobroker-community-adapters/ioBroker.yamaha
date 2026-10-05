import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

const dirs = vi.hoisted(() => ({ dataDir: "" }));
vi.mock("@iobroker/adapter-core", () => ({ getAbsoluteInstanceDataDir: () => dirs.dataDir }));

import { DeviceStores, deviceStoresOf, rememberedDevices, type StoreName, type StoreSnapshot } from "./device-stores";
import { isExcluded, type DiscoveredStoreDeps } from "./discovered-store";

/** One in-memory file: its content (undefined = missing), every write, and an optional read failure. */
interface MemoryFile extends DiscoveredStoreDeps {
  content: string | undefined;
  writes: string[];
  readFails?: Error;
  writeFails?: Error;
}

function memoryFile(content?: unknown): MemoryFile {
  const file: MemoryFile = {
    content: content === undefined ? undefined : typeof content === "string" ? content : JSON.stringify(content),
    writes: [],
    read: () => (file.readFails ? Promise.reject(file.readFails) : Promise.resolve(file.content)),
    write: text => {
      if (file.writeFails) {
        return Promise.reject(file.writeFails);
      }
      file.content = text;
      file.writes.push(text);
      return Promise.resolve();
    },
    log: { debug: () => undefined },
  };
  return file;
}

function owner(files: Partial<Record<StoreName, MemoryFile>> = {}): {
  stores: DeviceStores;
  files: Record<StoreName, MemoryFile>;
  log: { debug: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
} {
  const all = {
    discovered: files.discovered ?? memoryFile(),
    excluded: files.excluded ?? memoryFile(),
    ignored: files.ignored ?? memoryFile(),
  };
  const log = { debug: vi.fn(), warn: vi.fn() };
  return { stores: new DeviceStores(all, log), files: all, log };
}

describe("DeviceStores — the one owner of the three lists (review 2026-10-05, A2/A28/A31)", () => {
  test("reads the three lists and names the ones it could not read", async () => {
    const { stores } = owner({
      discovered: memoryFile([{ id: "wx-030-2b3c", ip: "10.0.0.5" }]),
      excluded: memoryFile("{broken"),
      ignored: memoryFile(["Old"]),
    });
    const now = await stores.read();
    expect(now.discovered).toEqual([{ id: "wx-030-2b3c", ip: "10.0.0.5" }]);
    expect(now.excluded).toEqual([]);
    expect(now.ignored).toEqual(["Old"]);
    expect([...now.unreadable]).toEqual(["excluded"]);
  });

  test("writes the exclusions first — a search running meanwhile must already read them", async () => {
    const order: string[] = [];
    const { stores, files } = owner({ discovered: memoryFile([{ id: "a", ip: "1.1.1.1" }]) });
    for (const name of ["discovered", "excluded", "ignored"] as const) {
      const write = files[name].write;
      files[name].write = text => {
        order.push(name);
        return write(text);
      };
    }
    const writes = await stores.update(now => ({
      discovered: [],
      excluded: [...now.excluded, { id: "a", ip: "1.1.1.1" }],
      ignored: ["x"],
    }));
    expect(order).toEqual(["excluded", "ignored", "discovered"]);
    expect(writes).toEqual({ excluded: "written", ignored: "written", discovered: "written" });
  });

  test("writes nothing that did not change", async () => {
    const { stores, files } = owner({ discovered: memoryFile([{ id: "a", ip: "1.1.1.1" }]) });
    const writes = await stores.update(now => ({ discovered: [...now.discovered] }));
    expect(writes).toEqual({ discovered: "unchanged" });
    expect(files.discovered.writes).toEqual([]);
  });

  // A2 case b: the search paths read the store unchecked and overwrote a broken file with what one search found — a
  // device in deep standby lost its record, and the next start cleanup its tree.
  test("never writes over a list it could not read; the later lists of the same change are skipped", async () => {
    const { stores, files, log } = owner({
      discovered: memoryFile([{ id: "a", ip: "1.1.1.1" }]),
      excluded: memoryFile(""),
    });
    const writes = await stores.update(now => ({
      excluded: [...now.excluded, { id: "a", ip: "1.1.1.1" }],
      discovered: [],
    }));
    expect(writes).toEqual({ excluded: "refused", discovered: "skipped" });
    expect(files.excluded.content).toBe("");
    expect(files.discovered.writes).toEqual([]);
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("excluded.json: not written"));
  });

  test("a failed write is reported, and the rest of the change is not written", async () => {
    const { stores, files } = owner({ discovered: memoryFile([{ id: "a", ip: "1.1.1.1" }]) });
    files.excluded.writeFails = new Error("ENOSPC");
    const writes = await stores.update(() => ({ excluded: [{ id: "a" }], discovered: [] }));
    expect(writes).toEqual({ excluded: "failed", discovered: "skipped" });
    expect(files.discovered.content).toBe(JSON.stringify([{ id: "a", ip: "1.1.1.1" }]));
  });

  // A31: six writers read, changed and wrote discovered.json each on their own — a delete that fell between a search's
  // read and its write came back with the search's write.
  test("changes run one after the other, each on what the one before left", async () => {
    const { stores, files } = owner({
      discovered: memoryFile([
        { id: "a", ip: "1.1.1.1" },
        { id: "b", ip: "1.1.1.2" },
      ]),
    });
    let releaseRead: () => void = () => undefined;
    const realRead = files.discovered.read;
    let stalled = false;
    // The first read takes what the file holds NOW and hands it over only later — a search's merge that read the
    // store and is still busy when the user deletes a device.
    files.discovered.read = () => {
      if (stalled) {
        return realRead();
      }
      stalled = true;
      const content = realRead();
      return new Promise(resolve => {
        releaseRead = () => resolve(content);
      });
    };
    const search = stores.update(now => ({ discovered: [...now.discovered, { id: "c", ip: "1.1.1.3" }] }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(stalled).toBe(true);
    // … while the user deletes "a".
    const removal = stores.update(now => ({ discovered: now.discovered.filter(device => device.id !== "a") }));
    await new Promise(resolve => setTimeout(resolve, 0));
    releaseRead();
    await Promise.all([search, removal]);
    expect(JSON.parse(files.discovered.content ?? "[]")).toEqual([
      { id: "b", ip: "1.1.1.2" },
      { id: "c", ip: "1.1.1.3" },
    ]);
  });

  test("a change that throws rejects its caller and leaves the chain usable", async () => {
    const { stores } = owner();
    await expect(
      stores.update(() => {
        throw new Error("bug");
      }),
    ).rejects.toThrow("bug");
    await expect(stores.read()).resolves.toMatchObject({ discovered: [] });
  });

  test("says once per outage that a list cannot be read, then at debug, and again after it recovered", async () => {
    const excluded = memoryFile("{broken");
    const { stores, log } = owner({ excluded });
    await stores.read();
    await stores.read();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatch(/^excluded\.json cannot be read \(.+\) — it is kept as it is/);
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("excluded.json cannot be read"));
    excluded.content = "[]";
    await stores.read();
    excluded.content = "";
    await stores.read();
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});

describe("rememberedDevices — the exclusion filter every path applies (review 2026-10-05, A31)", () => {
  const snapshot = (over: Partial<StoreSnapshot>): StoreSnapshot => ({
    discovered: [],
    excluded: [],
    ignored: [],
    unreadable: new Set(),
    ...over,
  });

  test("a record that is also excluded — a delete whose store write failed — is not remembered", () => {
    const now = snapshot({
      discovered: [
        { id: "rx-v685", ip: "192.168.1.20" },
        { id: "wx-021", ip: "192.168.1.21" },
        { id: "Old", ip: "192.168.1.22" },
      ],
      excluded: [{ id: "rx-v685", ip: "192.168.1.20" }],
      ignored: ["Old"],
    });
    expect(rememberedDevices(now).map(device => device.id)).toEqual(["wx-021"]);
  });
});

describe("the owner over the instance data directory, on a real file system", () => {
  const adapter = { namespace: "yamaha.0", log: { debug: vi.fn(), warn: vi.fn() } } as unknown as ioBroker.Adapter;

  beforeEach(() => {
    dirs.dataDir = mkdtempSync(join(tmpdir(), "yamaha-stores-"));
  });
  afterEach(() => {
    rmSync(dirs.dataDir, { recursive: true, force: true });
  });

  // Proof test shell-store / store-readable (EISDIR): read as a READABLE empty store before the fix.
  test("a directory in the file's place is an unreadable store, and nothing is written over it", async () => {
    mkdirSync(join(dirs.dataDir, "discovered.json"));
    const stores = deviceStoresOf(adapter);
    const now = await stores.read();
    expect(now.unreadable.has("discovered")).toBe(true);
    await expect(stores.update(() => ({ discovered: [{ id: "x", ip: "1.1.1.1" }] }))).resolves.toEqual({
      discovered: "refused",
    });
  });

  // Proof test store-readable (0-byte): the power cut between the truncate and the write of the old writer.
  test("a 0-byte file is an unreadable store", async () => {
    writeFileSync(join(dirs.dataDir, "discovered.json"), "");
    const now = await deviceStoresOf(adapter).read();
    expect(now.unreadable.has("discovered")).toBe(true);
  });

  // Proof test store-readable (A28): a cut-off excluded.json read as [], and the next delete wrote one entry over all
  // the earlier ones — those devices came back with the next search (Y-13).
  test("a cut-off excluded.json is kept: the next delete cannot write over the earlier ones", async () => {
    const path = join(dirs.dataDir, "excluded.json");
    const broken = '[{"id":"rx-v6a-2b3c","identity":{"serial":"0A1B2B3C"}},{"id":"wx-0';
    writeFileSync(path, broken);
    const stores = deviceStoresOf(adapter);
    const writes = await stores.update(now => ({ excluded: [...now.excluded, { id: "wx-030-f504" }] }));
    expect(writes.excluded).toBe("refused");
    expect(readFileSync(path, "utf8")).toBe(broken);
  });

  test("a readable store is replaced whole, and reads back what was written", async () => {
    const stores = deviceStoresOf(adapter);
    await stores.update(() => ({ excluded: [{ id: "rx-v6a-2b3c", identity: { serial: "0A1B2B3C" } }] }));
    const now = await stores.read();
    expect(now.unreadable.size).toBe(0);
    expect(isExcluded(now.ignored, now.excluded, { id: "x", ip: "10.0.0.5", identity: { serial: "0A1B2B3C" } })).toBe(
      true,
    );
  });
});
