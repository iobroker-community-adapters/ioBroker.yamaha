import { emptyLearnedTree, hasLearned, parseLearnedTree } from "./learned-tree";

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
