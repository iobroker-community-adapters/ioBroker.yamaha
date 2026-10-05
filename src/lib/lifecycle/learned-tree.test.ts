import { emptyLearnedTree, hasLearned, parseLearnedTree, readInDue } from "./learned-tree";
import type { Transport } from "../catalog/owner-policy";

describe("learned tree — what a receiver serves over which transport, kept (2026-10-02)", () => {
  test("a stored tree is read back field by field; anything unknown is dropped", () => {
    expect(
      parseLearnedTree({
        shared: { volume: ["yxc", "ynca", "nonsense", "ynca"], sleep: [], input: "ynca" },
        transports: ["ynca", "yxc", 3],
        settledVersion: "3.2.0",
        firmware: { ynca: "1.80", yxc: "", xml: 2 },
        extra: true,
      }),
    ).toEqual({
      shared: { volume: ["yxc", "ynca"] },
      transports: ["ynca", "yxc"],
      settledVersion: "3.2.0",
      firmware: { ynca: "1.80" },
    });
  });

  test("a read-in a firmware update opened is read back as one, across a restart (review 2026-10-05, A54)", () => {
    expect(parseLearnedTree({ firmware: { yxc: "2.51" }, firmwareUpdate: true }).firmwareUpdate).toBe(true);
    expect(parseLearnedTree({ firmware: { yxc: "2.51" }, firmwareUpdate: "yes" }).firmwareUpdate).toBeUndefined();
  });

  test("the read-in completes once: open, every known transport live, every read from a switched-on receiver", () => {
    const tree = { ...emptyLearnedTree(), transports: ["ynca", "yxc"] as Transport[] };
    const on = { transport: "ynca" as const, readComplete: () => true };
    const yxc = { transport: "yxc" as const };
    expect(readInDue(tree, "3.2.0", [on, yxc], 0)).toBe(true);
    expect(readInDue({ ...tree, settledVersion: "3.2.0" }, "3.2.0", [on, yxc], 0)).toBe(false);
    expect(readInDue(tree, undefined, [on, yxc], 0)).toBe(false);
    expect(readInDue(tree, "3.2.0", [on], 0)).toBe(false);
    expect(readInDue(tree, "3.2.0", [on, yxc], 1)).toBe(false);
    expect(readInDue(tree, "3.2.0", [{ transport: "ynca", readComplete: () => false }, yxc], 0)).toBe(false);
    expect(readInDue(tree, "3.2.0", [], 0)).toBe(false);
  });

  test("nothing usable stored is an empty tree", () => {
    expect(parseLearnedTree(undefined)).toEqual(emptyLearnedTree());
    expect(parseLearnedTree(null)).toEqual(emptyLearnedTree());
    expect(parseLearnedTree({ shared: null, firmware: null })).toEqual(emptyLearnedTree());
    expect(parseLearnedTree("tree")).toEqual(emptyLearnedTree());
    expect(parseLearnedTree([])).toEqual(emptyLearnedTree());
  });

  test("an empty tree has learned nothing; any one field is something learned", () => {
    expect(hasLearned(emptyLearnedTree())).toBe(false);
    expect(hasLearned({ ...emptyLearnedTree(), shared: { volume: ["yxc", "ynca"] } })).toBe(true);
    expect(hasLearned({ ...emptyLearnedTree(), transports: ["ynca"] })).toBe(true);
    expect(hasLearned({ ...emptyLearnedTree(), settledVersion: "3.2.0" })).toBe(true);
    expect(hasLearned({ ...emptyLearnedTree(), firmware: { xml: "1.0" } })).toBe(true);
  });
});
