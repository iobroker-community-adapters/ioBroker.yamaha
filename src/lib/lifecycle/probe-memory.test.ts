import { ProbeMemory } from "./probe-memory";

describe("ProbeMemory", () => {
  test("asks once and reuses the answer on every later attempt", async () => {
    const memory = new ProbeMemory();
    let asked = 0;
    const probe = async (): Promise<string> => {
      asked++;
      return "answer";
    };
    expect(await memory.once("k", probe)).toBe("answer");
    expect(await memory.once("k", probe)).toBe("answer");
    expect(await memory.once("k", probe)).toBe("answer");
    expect(asked).toBe(1);
  });

  test("remembers undefined too — a device that reports no name is not re-asked forever", async () => {
    const memory = new ProbeMemory();
    let asked = 0;
    const probe = async (): Promise<string | undefined> => {
      asked++;
      return undefined;
    };
    await memory.once("name", probe);
    await memory.once("name", probe);
    expect(asked).toBe(1);
  });

  test("keeps different keys apart and forgets everything on clear", async () => {
    const memory = new ProbeMemory();
    expect(await memory.once("a", async () => 1)).toBe(1);
    expect(await memory.once("b", async () => 2)).toBe(2);
    memory.clear();
    expect(await memory.once("a", async () => 99)).toBe(99);
  });

  test("a failing probe is not remembered, so the next attempt tries again", async () => {
    const memory = new ProbeMemory();
    await expect(
      memory.once("k", () => Promise.reject(new Error("device offline"))),
    ).rejects.toThrow("device offline");
    expect(await memory.once("k", async () => "later")).toBe("later");
  });
});

describe("ProbeMemory persistence (the fast-restart layer)", () => {
  test("starts from the persisted entries and persists every change as a snapshot", async () => {
    const snapshots: Array<Record<string, unknown>> = [];
    const memory = new ProbeMemory({ a: 1 }, entries => snapshots.push(entries));
    expect(memory.remembered("a")).toBe(1);
    memory.set("b", "x");
    expect(snapshots).toEqual([{ a: 1, b: "x" }]);
    // once() with a remembered key does not persist again…
    await memory.once("b", () => Promise.resolve("ignored"));
    expect(snapshots).toHaveLength(1);
    // …a fresh probe does.
    await memory.once("c", () => Promise.resolve(true));
    expect(snapshots[1]).toEqual({ a: 1, b: "x", c: true });
  });

  test("drop removes matching keys and persists the reduced snapshot once", () => {
    const snapshots: Array<Record<string, unknown>> = [];
    const memory = new ProbeMemory({ xmlModel: "RX", xmlTuner: "<x/>", features: {} }, e => snapshots.push(e));
    memory.drop(key => key.startsWith("xml"));
    expect(memory.remembered("xmlModel")).toBeUndefined();
    expect(memory.remembered("features")).toEqual({});
    expect(snapshots).toEqual([{ features: {} }]);
    // Dropping nothing persists nothing.
    memory.drop(key => key.startsWith("xml"));
    expect(snapshots).toHaveLength(1);
  });
});
