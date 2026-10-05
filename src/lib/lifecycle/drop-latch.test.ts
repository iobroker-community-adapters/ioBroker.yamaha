import { DropLatch } from "./drop-latch";

describe("DropLatch — one drop, kept until someone listens (review 2026-10-05, E)", () => {
  test("a drop reported before registration is delivered on registration, once", () => {
    const latch = new DropLatch();
    const reason = new Error("socket closed");
    expect(latch.report(reason)).toBe(true);
    expect(latch.dropped).toBe(true);
    const seen: Array<Error | undefined> = [];
    latch.onDrop(r => seen.push(r));
    latch.onDrop(r => seen.push(r));
    expect(seen).toEqual([reason]);
  });

  test("a drop reported after registration is delivered at once; a second report counts for nothing", () => {
    const latch = new DropLatch();
    const seen: Array<Error | undefined> = [];
    latch.onDrop(r => seen.push(r));
    expect(latch.dropped).toBe(false);
    expect(latch.report()).toBe(true);
    expect(latch.report(new Error("again"))).toBe(false);
    expect(seen).toEqual([undefined]);
  });
});
