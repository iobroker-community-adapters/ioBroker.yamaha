import { readDiscovered, writeDiscovered, type DiscoveredStoreDeps } from "./discovered-store";

function fakeDeps(overrides: Partial<DiscoveredStoreDeps> = {}): DiscoveredStoreDeps & { written: string[] } {
  const written: string[] = [];
  return {
    read: async () => undefined,
    write: async content => void written.push(content),
    log: { debug: () => {} },
    written,
    ...overrides,
  };
}

describe("readDiscovered", () => {
  test("returns [] when the store file does not exist", async () => {
    expect(await readDiscovered(fakeDeps({ read: async () => undefined }))).toEqual([]);
  });

  test("returns [] on corrupt JSON", async () => {
    expect(await readDiscovered(fakeDeps({ read: async () => "{not json" }))).toEqual([]);
  });

  test("returns the stored records", async () => {
    const raw = JSON.stringify([{ id: "Living", ip: "1.1.1.1" }]);
    expect(await readDiscovered(fakeDeps({ read: async () => raw }))).toEqual([{ id: "Living", ip: "1.1.1.1" }]);
  });

  test("returns [] when the content is not an array", async () => {
    expect(await readDiscovered(fakeDeps({ read: async () => '{"id":"x","ip":"y"}' }))).toEqual([]);
  });

  test("drops entries without a string id and ip", async () => {
    const raw = JSON.stringify([{ id: "Living", ip: "1.1.1.1" }, { id: "NoIp" }, { ip: "2.2.2.2" }, 42]);
    expect(await readDiscovered(fakeDeps({ read: async () => raw }))).toEqual([{ id: "Living", ip: "1.1.1.1" }]);
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
      write: async () => {
        throw new Error("disk full");
      },
    });
    await expect(writeDiscovered(deps, [{ id: "Living", ip: "1.1.1.1" }])).resolves.toBeUndefined();
  });
});
