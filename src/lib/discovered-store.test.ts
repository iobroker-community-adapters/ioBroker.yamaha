import {
  isExcluded,
  readDiscovered,
  readExcluded,
  readIgnored,
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

describe("readDiscovered", () => {
  test("returns [] when the store file does not exist", async () => {
    expect(await readDiscovered(fakeDeps({ read: () => Promise.resolve(undefined) }))).toEqual([]);
  });

  test("returns [] on corrupt JSON", async () => {
    expect(await readDiscovered(fakeDeps({ read: () => Promise.resolve("{not json") }))).toEqual([]);
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
  test("writes the records as JSON", async () => {
    const deps = fakeDeps();
    await writeDiscovered(deps, [{ id: "Living", ip: "1.1.1.1" }]);
    expect(deps.written).toEqual([JSON.stringify([{ id: "Living", ip: "1.1.1.1" }])]);
  });

  test("swallows a write failure", async () => {
    const deps = fakeDeps({
      write: () => {
        return Promise.reject(new Error("disk full"));
      },
    });
    await expect(writeDiscovered(deps, [{ id: "Living", ip: "1.1.1.1" }])).resolves.toBeUndefined();
  });
});

// The ignored store is what makes the delete button stick: without it the next network search
// finds the receiver again and the adapter undoes the user's own delete. Both halves used to be
// replaced by a mock in each of their two callers, so nothing ever ran this code.
describe("readIgnored", () => {
  test("returns the stored ids", async () => {
    const raw = JSON.stringify(["Living", "Kitchen"]);
    expect(await readIgnored(fakeDeps({ read: () => Promise.resolve(raw) }))).toEqual(["Living", "Kitchen"]);
  });

  test("returns [] when the store file does not exist", async () => {
    expect(await readIgnored(fakeDeps({ read: () => Promise.resolve(undefined) }))).toEqual([]);
  });

  test("returns [] on corrupt JSON", async () => {
    expect(await readIgnored(fakeDeps({ read: () => Promise.resolve("[not json") }))).toEqual([]);
  });

  test("returns [] when the read itself fails", async () => {
    const deps = fakeDeps({ read: () => Promise.reject(new Error("permission denied")) });
    expect(await readIgnored(deps)).toEqual([]);
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
    await writeIgnored(deps, ["Living", "Kitchen"]);
    expect(deps.written).toEqual([JSON.stringify(["Living", "Kitchen"])]);
  });

  test("stores each id once — a device deleted twice may not grow the file forever", async () => {
    const deps = fakeDeps();
    await writeIgnored(deps, ["Living", "Kitchen", "Living"]);
    expect(deps.written).toEqual([JSON.stringify(["Living", "Kitchen"])]);
  });

  test("swallows a write failure", async () => {
    const deps = fakeDeps({ write: () => Promise.reject(new Error("disk full")) });
    await expect(writeIgnored(deps, ["Living"])).resolves.toBeUndefined();
  });
});

describe("readExcluded", () => {
  test("reads the stored entries", async () => {
    const deps = fakeDeps({ read: () => Promise.resolve(JSON.stringify([{ id: "RX-V685", ip: "192.168.1.20" }])) });
    await expect(readExcluded(deps)).resolves.toEqual([{ id: "RX-V685", ip: "192.168.1.20" }]);
  });

  test("starts empty on a missing, corrupt or non-list file", async () => {
    await expect(readExcluded(fakeDeps())).resolves.toEqual([]);
    await expect(readExcluded(fakeDeps({ read: () => Promise.resolve("{nope") }))).resolves.toEqual([]);
    await expect(readExcluded(fakeDeps({ read: () => Promise.resolve('{"id":"x"}') }))).resolves.toEqual([]);
  });

  test("starts empty when the read itself rejects", async () => {
    await expect(readExcluded(fakeDeps({ read: () => Promise.reject(new Error("EACCES")) }))).resolves.toEqual([]);
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

  test("swallows a write failure", async () => {
    const deps = fakeDeps({ write: () => Promise.reject(new Error("disk")) });
    await expect(writeExcluded(deps, [{ id: "a" }])).resolves.toBeUndefined();
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
