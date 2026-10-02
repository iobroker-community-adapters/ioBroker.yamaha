import { describe, expect, test } from "vitest";
import {
  MultiTransportHandle,
  type TransportConnection,
  type WriteOutcome,
} from "../lib/lifecycle/multi-transport-handle";
import { emptyLearnedTree, type LearnedTree } from "../lib/lifecycle/learned-tree";
import type { ObjectDef } from "../lib/catalog/types";
import type { Transport } from "../lib/catalog/owner-policy";

// Y-02: what a receiver can do is determined once and kept. A later connect of the same adapter version takes it
// from the stored tree and does not work it out again; only a different adapter version reads the receiver in anew.

const log = { debug: (): void => undefined, info: (): void => undefined, warn: (): void => undefined };

function state(id: string, extra: Record<string, unknown> = {}): ObjectDef {
  return {
    id,
    type: "state",
    common: { name: id, type: "boolean", role: "switch", read: true, write: true, ...extra },
  };
}

function connection(transport: Transport, objects: readonly ObjectDef[]): TransportConnection {
  return {
    transport,
    buildObjects: () => objects,
    seedOwned: () => undefined,
    handleWrite: (): Promise<WriteOutcome> => Promise.resolve("sent"),
    onDrop: () => undefined,
    close: () => undefined,
  };
}

interface Run {
  upserts: Array<{ id: string; settle: boolean }>;
  settled: number;
  treeWrites: LearnedTree[];
}

/**
 * One connect of the device: a fresh handle over the receiver's transports, as every reconnect builds one.
 *
 * @param store the device's stored tree, shared across connects like the capability profile
 * @param store.tree the tree itself
 * @param written the definitions written for the device, shared across connects like main.ts keeps them
 * @param adapterVersion the running adapter version
 * @returns what this connect wrote
 */
async function connect(
  store: { tree: LearnedTree },
  written: Map<string, string>,
  adapterVersion: string,
): Promise<Run> {
  const run: Run = { upserts: [], settled: 0, treeWrites: [] };
  const ynca = connection("ynca", [state("power"), state("mute"), state("main.input", { type: "string" })]);
  const yxc = connection("yxc", [state("power"), state("mute"), state("player.shuffle")]);
  const handle = new MultiTransportHandle("living", [ynca, yxc], {
    upsertObject: (id, _def, settle) => {
      run.upserts.push({ id, settle: settle === true });
      return Promise.resolve();
    },
    log,
    writtenObjects: written,
    adapterVersion,
    tree: {
      get: () => store.tree,
      set: tree => {
        store.tree = tree;
        run.treeWrites.push(tree);
      },
    },
    settleTree: () => {
      run.settled++;
      return Promise.resolve();
    },
  });
  await handle.start();
  handle.close();
  return run;
}

describe("Y-02 what a receiver can do is determined once and stored", () => {
  test("the first connect reads the receiver in and stores the result for this adapter version", async () => {
    const store = { tree: emptyLearnedTree() };
    const first = await connect(store, new Map(), "3.2.0");
    // Positive control: the read-in did run, wrote the tree and stored who serves what.
    expect(first.settled).toBe(1);
    expect(first.upserts.length).toBeGreaterThan(0);
    expect(first.upserts.every(write => write.settle)).toBe(true);
    expect(store.tree.settledVersion).toBe("3.2.0");
    expect(store.tree.transports).toEqual(["ynca", "yxc"]);
    expect(Object.keys(store.tree.shared).sort()).toEqual(["mute", "power"]);
  });

  test("every later connect of the same version takes the stored result and works nothing out again", async () => {
    const store = { tree: emptyLearnedTree() };
    const written = new Map<string, string>();
    await connect(store, written, "3.2.0");
    const stored = structuredClone(store.tree);
    for (let reconnect = 0; reconnect < 3; reconnect++) {
      const again = await connect(store, written, "3.2.0");
      expect(again.settled).toBe(0);
      expect(again.upserts).toEqual([]);
      expect(again.treeWrites).toEqual([]);
    }
    expect(store.tree).toEqual(stored);
  });

  test("a stored result survives a fresh process (an empty written-definitions map) without a new read-in", async () => {
    const store = { tree: emptyLearnedTree() };
    await connect(store, new Map(), "3.2.0");
    const restart = await connect(store, new Map(), "3.2.0");
    expect(restart.settled).toBe(0);
    expect(restart.upserts.some(write => write.settle)).toBe(false);
    expect(store.tree.settledVersion).toBe("3.2.0");
  });

  test("only a different adapter version reads the receiver in again", async () => {
    const store = { tree: emptyLearnedTree() };
    const written = new Map<string, string>();
    await connect(store, written, "3.2.0");
    const update = await connect(store, written, "3.3.0");
    expect(update.settled).toBe(1);
    expect(store.tree.settledVersion).toBe("3.3.0");
    const after = await connect(store, written, "3.3.0");
    expect(after.settled).toBe(0);
  });
});
