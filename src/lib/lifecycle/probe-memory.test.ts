import { ProbeMemory, memorySchemaOf } from "./probe-memory";
import { DISCOVERY_SCHEMA } from "./discovery-schema";

describe("ProbeMemory", () => {
  test("asks once and reuses the answer on every later attempt", async () => {
    const memory = new ProbeMemory();
    let asked = 0;
    const probe = (): Promise<string> => {
      asked++;
      return Promise.resolve("answer");
    };
    expect(await memory.once("k", probe)).toBe("answer");
    expect(await memory.once("k", probe)).toBe("answer");
    expect(await memory.once("k", probe)).toBe("answer");
    expect(asked).toBe(1);
  });

  test("remembers undefined too — a device that reports no name is not re-asked forever", async () => {
    const memory = new ProbeMemory();
    let asked = 0;
    const probe = (): Promise<string | undefined> => {
      asked++;
      return Promise.resolve(undefined);
    };
    await memory.once("name", probe);
    await memory.once("name", probe);
    expect(asked).toBe(1);
  });

  test("keeps different keys apart and forgets everything on clear", async () => {
    const memory = new ProbeMemory();
    expect(await memory.once("a", () => Promise.resolve(1))).toBe(1);
    expect(await memory.once("b", () => Promise.resolve(2))).toBe(2);
    memory.clear();
    expect(await memory.once("a", () => Promise.resolve(99))).toBe(99);
  });

  test("a failing probe is not remembered, so the next attempt tries again", async () => {
    const memory = new ProbeMemory();
    await expect(memory.once("k", () => Promise.reject(new Error("device offline")))).rejects.toThrow("device offline");
    expect(await memory.once("k", () => Promise.resolve("later"))).toBe("later");
  });
});

describe("ProbeMemory persistence (the fast-restart layer)", () => {
  test("starts from the persisted entries and persists every change as a snapshot", async () => {
    const snapshots: Array<Record<string, unknown>> = [];
    const memory = new ProbeMemory({ __schema: DISCOVERY_SCHEMA, a: 1 }, entries => snapshots.push(entries));
    expect(memory.remembered("a")).toBe(1);
    memory.set("b", "x");
    expect(snapshots).toEqual([{ __schema: DISCOVERY_SCHEMA, a: 1, b: "x" }]);
    // once() with a remembered key does not persist again…
    await memory.once("b", () => Promise.resolve("ignored"));
    expect(snapshots).toHaveLength(1);
    // …a fresh probe does.
    await memory.once("c", () => Promise.resolve(true));
    expect(snapshots[1]).toEqual({ __schema: DISCOVERY_SCHEMA, a: 1, b: "x", c: true });
  });

  test("drop removes matching keys and persists the reduced snapshot once", () => {
    const snapshots: Array<Record<string, unknown>> = [];
    const memory = new ProbeMemory({ __schema: DISCOVERY_SCHEMA, xmlModel: "RX", xmlTuner: "<x/>", features: {} }, e =>
      snapshots.push(e),
    );
    memory.drop(key => key.startsWith("xml"));
    expect(memory.remembered("xmlModel")).toBeUndefined();
    expect(memory.remembered("features")).toEqual({});
    expect(snapshots).toEqual([{ __schema: DISCOVERY_SCHEMA, features: {} }]);
    // Dropping nothing persists nothing.
    memory.drop(key => key.startsWith("xml"));
    expect(snapshots).toHaveLength(1);
  });
});

describe("ProbeMemory knows the discovery logic it was learned by (DISCOVERY_SCHEMA, 2.6.0)", () => {
  test("a memory learned under another discovery schema is not loaded", () => {
    const memory = new ProbeMemory({ __schema: 0, features: { zones: [] } }, undefined, 1);
    expect(memory.remembered("features")).toBeUndefined();
  });

  test("a memory of the current schema is loaded, and every persisted snapshot carries the schema", () => {
    const persisted: Array<Record<string, unknown>> = [];
    const memory = new ProbeMemory({ __schema: 1, name: "Living" }, entries => persisted.push(entries), 1);
    expect(memory.remembered("name")).toBe("Living");
    memory.set("model", "RX-V6A");
    expect(persisted.at(-1)).toEqual({ __schema: 1, name: "Living", model: "RX-V6A" });
    // The schema field is bookkeeping, never a remembered answer.
    expect(memory.remembered("__schema")).toBeUndefined();
  });

  test("a legacy memory without a schema field counts as schema 0 — re-learned under the first schema", () => {
    expect(new ProbeMemory({ name: "Living" }, undefined, 1).remembered("name")).toBeUndefined();
  });

  test("the default schema is the adapter's current one", () => {
    const persisted: Array<Record<string, unknown>> = [];
    new ProbeMemory(undefined, entries => persisted.push(entries)).set("k", 1);
    expect(persisted.at(-1)).toEqual({ __schema: DISCOVERY_SCHEMA, k: 1 });
    expect(memorySchemaOf({ __schema: 3 })).toBe(3);
    expect(memorySchemaOf({})).toBe(0);
    expect(memorySchemaOf({ __schema: "x" })).toBe(0);
  });
});
