import {
  isExcluded,
  readDiscovered,
  readExcluded,
  readIgnored,
  readJsonList,
  writeDiscovered,
  writeExcluded,
  writeIgnored,
  type DiscoveredStoreDeps,
} from "./discovered-store";

function fakeDeps(overrides: Partial<DiscoveredStoreDeps> = {}): DiscoveredStoreDeps & { written: string[] } {
  const written: string[] = [];
  return {
    read: () => Promise.resolve(undefined),
    write: content => Promise.resolve(void written.push(content)),
    log: { debug: () => {} },
    written,
    ...overrides,
  };
}

const isString = (entry: unknown): entry is string => typeof entry === "string";

// Review 2026-10-05, A2/A28: every read error and a 0-byte file read as an EMPTY, readable store — and the start cleanup
// deleted the trees of every remembered device, a broken excluded.json undid every earlier delete on the next write.
describe("readJsonList — only a missing file is an empty list", () => {
  test("a missing file is an empty, readable list", async () => {
    await expect(readJsonList(fakeDeps(), isString)).resolves.toEqual({ items: [], readable: true });
  });

  test("a file that cannot be read (EACCES, EIO, EISDIR) is unreadable, not empty", async () => {
    const deps = fakeDeps({
      read: () => Promise.reject(Object.assign(new Error("permission denied"), { code: "EACCES" })),
    });
    await expect(readJsonList(deps, isString)).resolves.toEqual({
      items: [],
      readable: false,
      problem: "permission denied",
    });
  });

  test("an empty file is a write cut off, not an empty list", async () => {
    for (const raw of ["", "  \n"]) {
      await expect(readJsonList(fakeDeps({ read: () => Promise.resolve(raw) }), isString)).resolves.toEqual({
        items: [],
        readable: false,
        problem: "the file is empty",
      });
    }
  });

  test("a truncated or garbled file is unreadable", async () => {
    const read = await readJsonList(
      fakeDeps({ read: () => Promise.resolve('[{"id":"rx-v6a-2b3c","ip":"10.0.0.5"},{"id":"wx-0') }),
      isString,
    );
    expect(read.readable).toBe(false);
    expect(read.items).toEqual([]);
  });

  test("a file that holds no list is unreadable", async () => {
    await expect(readJsonList(fakeDeps({ read: () => Promise.resolve('{"id":"x"}') }), isString)).resolves.toEqual({
      items: [],
      readable: false,
      problem: "the file holds no list",
    });
  });

  test("a list keeps its usable entries and is readable", async () => {
    await expect(
      readJsonList(fakeDeps({ read: () => Promise.resolve('["a", 1, null, "b"]') }), isString),
    ).resolves.toEqual({ items: ["a", "b"], readable: true });
  });
});

describe("readDiscovered", () => {
  test("returns [] when the store file does not exist, and says nothing about it", async () => {
    const unreadable = vi.fn();
    expect(await readDiscovered(fakeDeps({ read: () => Promise.resolve(undefined) }), unreadable)).toEqual([]);
    expect(unreadable).not.toHaveBeenCalled();
  });

  test("returns [] on corrupt JSON — and tells the caller it could not be read", async () => {
    const unreadable = vi.fn();
    expect(await readDiscovered(fakeDeps({ read: () => Promise.resolve("{not json") }), unreadable)).toEqual([]);
    expect(unreadable).toHaveBeenCalledTimes(1);
  });

  test("returns the stored records", async () => {
    const raw = JSON.stringify([{ id: "Living", ip: "1.1.1.1" }]);
    expect(await readDiscovered(fakeDeps({ read: () => Promise.resolve(raw) }))).toEqual([
      { id: "Living", ip: "1.1.1.1" },
    ]);
  });

  test("returns [] when the content is not an array", async () => {
    expect(await readDiscovered(fakeDeps({ read: () => Promise.resolve('{"id":"x","ip":"y"}') }))).toEqual([]);
  });

  test("drops entries without a string id and ip", async () => {
    const raw = JSON.stringify([{ id: "Living", ip: "1.1.1.1" }, { id: "NoIp" }, { ip: "2.2.2.2" }, 42]);
    expect(await readDiscovered(fakeDeps({ read: () => Promise.resolve(raw) }))).toEqual([
      { id: "Living", ip: "1.1.1.1" },
    ]);
  });
});

describe("writeDiscovered", () => {
  test("writes the records as JSON and says so", async () => {
    const deps = fakeDeps();
    await expect(writeDiscovered(deps, [{ id: "Living", ip: "1.1.1.1" }])).resolves.toBe(true);
    expect(deps.written).toEqual([JSON.stringify([{ id: "Living", ip: "1.1.1.1" }])]);
  });

  test("swallows a write failure and reports it", async () => {
    const deps = fakeDeps({
      write: () => {
        return Promise.reject(new Error("disk full"));
      },
    });
    await expect(writeDiscovered(deps, [{ id: "Living", ip: "1.1.1.1" }])).resolves.toBe(false);
  });
});

// The 2.x id list (`ignored.json`): read for the exclusions 2.x left behind and shrunk when the user
// admits one again (a delete writes `excluded.json` since 2.12.0). Both halves used to be
// replaced by a mock in each of their two callers, so nothing ever ran this code.
describe("readIgnored", () => {
  test("returns the stored ids", async () => {
    const raw = JSON.stringify(["Living", "Kitchen"]);
    expect(await readIgnored(fakeDeps({ read: () => Promise.resolve(raw) }))).toEqual(["Living", "Kitchen"]);
  });

  test("returns [] when the store file does not exist", async () => {
    expect(await readIgnored(fakeDeps({ read: () => Promise.resolve(undefined) }))).toEqual([]);
  });

  test("returns [] on corrupt JSON, and tells the caller", async () => {
    const unreadable = vi.fn();
    expect(await readIgnored(fakeDeps({ read: () => Promise.resolve("[not json") }), unreadable)).toEqual([]);
    expect(unreadable).toHaveBeenCalledTimes(1);
  });

  test("returns [] when the read itself fails, and tells the caller why", async () => {
    const unreadable = vi.fn();
    const deps = fakeDeps({ read: () => Promise.reject(new Error("permission denied")) });
    expect(await readIgnored(deps, unreadable)).toEqual([]);
    expect(unreadable).toHaveBeenCalledWith("permission denied");
  });

  test("returns [] when the content is not an array", async () => {
    expect(await readIgnored(fakeDeps({ read: () => Promise.resolve('{"id":"Living"}') }))).toEqual([]);
  });

  test("drops entries that are not strings", async () => {
    const raw = JSON.stringify(["Living", 42, null, { id: "Kitchen" }, "Bath"]);
    expect(await readIgnored(fakeDeps({ read: () => Promise.resolve(raw) }))).toEqual(["Living", "Bath"]);
  });
});

describe("writeIgnored", () => {
  test("writes the ids as JSON", async () => {
    const deps = fakeDeps();
    await expect(writeIgnored(deps, ["Living", "Kitchen"])).resolves.toBe(true);
    expect(deps.written).toEqual([JSON.stringify(["Living", "Kitchen"])]);
  });

  test("stores each id once — a rewrite never duplicates an entry", async () => {
    const deps = fakeDeps();
    await writeIgnored(deps, ["Living", "Kitchen", "Living"]);
    expect(deps.written).toEqual([JSON.stringify(["Living", "Kitchen"])]);
  });

  test("swallows a write failure and reports it", async () => {
    const deps = fakeDeps({ write: () => Promise.reject(new Error("disk full")) });
    await expect(writeIgnored(deps, ["Living"])).resolves.toBe(false);
  });
});

describe("readExcluded", () => {
  test("reads the stored entries", async () => {
    const deps = fakeDeps({ read: () => Promise.resolve(JSON.stringify([{ id: "RX-V685", ip: "192.168.1.20" }])) });
    await expect(readExcluded(deps)).resolves.toEqual([{ id: "RX-V685", ip: "192.168.1.20" }]);
  });

  test("starts empty on a missing, corrupt or non-list file — the last two told as unreadable", async () => {
    const unreadable = vi.fn();
    await expect(readExcluded(fakeDeps(), unreadable)).resolves.toEqual([]);
    expect(unreadable).not.toHaveBeenCalled();
    await expect(readExcluded(fakeDeps({ read: () => Promise.resolve("{nope") }), unreadable)).resolves.toEqual([]);
    await expect(readExcluded(fakeDeps({ read: () => Promise.resolve('{"id":"x"}') }), unreadable)).resolves.toEqual(
      [],
    );
    expect(unreadable).toHaveBeenCalledTimes(2);
  });

  test("starts empty when the read itself rejects, and tells the caller", async () => {
    const unreadable = vi.fn();
    await expect(
      readExcluded(fakeDeps({ read: () => Promise.reject(new Error("EACCES")) }), unreadable),
    ).resolves.toEqual([]);
    expect(unreadable).toHaveBeenCalledWith("EACCES");
  });

  test("drops entries without a string id", async () => {
    const deps = fakeDeps({
      read: () => Promise.resolve(JSON.stringify([{ ip: "1.2.3.4" }, { id: 5 }, { id: "ok" }])),
    });
    await expect(readExcluded(deps)).resolves.toEqual([{ id: "ok" }]);
  });
});

describe("writeExcluded", () => {
  test("stores each id once, the later entry wins", async () => {
    const deps = fakeDeps();
    await writeExcluded(deps, [
      { id: "a", ip: "1.1.1.1" },
      { id: "a", ip: "2.2.2.2" },
    ]);
    expect(deps.written).toEqual([JSON.stringify([{ id: "a", ip: "2.2.2.2" }])]);
  });

  test("swallows a write failure and reports it", async () => {
    const deps = fakeDeps({ write: () => Promise.reject(new Error("disk")) });
    await expect(writeExcluded(deps, [{ id: "a" }])).resolves.toBe(false);
  });
});

describe("isExcluded", () => {
  test("matches the legacy id list", () => {
    expect(isExcluded(["RX-V685"], [], { id: "RX-V685", ip: "1.1.1.1" })).toBe(true);
  });

  test("matches an entry by id", () => {
    expect(isExcluded([], [{ id: "RX-V685" }], { id: "RX-V685", ip: "1.1.1.1" })).toBe(true);
  });

  test("matches an entry WITHOUT identity by its address", () => {
    expect(isExcluded([], [{ id: "Kitchen", ip: "1.1.1.1" }], { id: "Yamaha_RX-V6a", ip: "1.1.1.1" })).toBe(true);
  });

  test("matches an entry WITH identity by the identity, whatever the address", () => {
    const entry = { id: "Kitchen", ip: "1.1.1.1", identity: { serial: "0E897553" } };
    expect(isExcluded([], [entry], { id: "Other", ip: "9.9.9.9", identity: { serial: "0E897553" } })).toBe(true);
  });

  test("does not match by address once the entry carries an identity", () => {
    const entry = { id: "Kitchen", ip: "1.1.1.1", identity: { serial: "0E897553" } };
    expect(isExcluded([], [entry], { id: "Other", ip: "1.1.1.1", identity: { serial: "0B587073" } })).toBe(false);
  });

  test("is false for a stranger", () => {
    expect(isExcluded(["a"], [{ id: "b", ip: "2.2.2.2" }], { id: "c", ip: "3.3.3.3" })).toBe(false);
  });
});
