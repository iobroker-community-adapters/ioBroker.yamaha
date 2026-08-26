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
