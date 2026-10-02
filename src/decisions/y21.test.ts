import { describe, expect, test } from "vitest";
import {
  MultiTransportHandle,
  type TransportConnection,
  type WriteOutcome,
} from "../lib/lifecycle/multi-transport-handle";
import { emptyLearnedTree, type LearnedTree } from "../lib/lifecycle/learned-tree";
import { readyLine } from "../lib/ready-line";
import { connectTransports, type TransportAttempt } from "../lib/attempt-device";
import type { ObjectDef } from "../lib/catalog/types";
import type { Transport } from "../lib/catalog/owner-policy";

// Y-21: new firmware reported by the receiver opens the read-in again. A log line of its own announces it, and when
// the read-in completes the same ready line as at startup closes it. The same firmware, or none reported, changes
// nothing.

const POWER: ObjectDef = {
  id: "power",
  type: "state",
  common: { name: "power", type: "boolean", role: "switch", read: true, write: true },
};

function connection(transport: Transport, firmware: string | undefined): TransportConnection {
  return {
    transport,
    buildObjects: () => [POWER],
    seedOwned: () => undefined,
    handleWrite: (): Promise<WriteOutcome> => Promise.resolve("sent"),
    onDrop: () => undefined,
    close: () => undefined,
    firmware: () => firmware,
  };
}

async function connect(
  store: { tree: LearnedTree },
  firmware: { ynca?: string; yxc?: string },
): Promise<{ info: string[]; settled: number; settleWrites: number }> {
  const info: string[] = [];
  let settled = 0;
  let settleWrites = 0;
  const handle = new MultiTransportHandle(
    "living",
    [connection("ynca", firmware.ynca), connection("yxc", firmware.yxc)],
    {
      upsertObject: (_id, _def, settle) => {
        if (settle === true) {
          settleWrites++;
        }
        return Promise.resolve();
      },
      log: { debug: () => undefined, info: message => info.push(message), warn: () => undefined },
      adapterVersion: "3.2.0",
      tree: { get: () => store.tree, set: tree => (store.tree = tree) },
      settleTree: () => {
        settled++;
        return Promise.resolve();
      },
    },
  );
  await handle.start();
  handle.close();
  return { info, settled, settleWrites };
}

async function readIn(): Promise<{ tree: LearnedTree }> {
  const store = { tree: emptyLearnedTree() };
  await connect(store, { ynca: "1.10/2.40", yxc: "2.40" });
  return store;
}

describe("Y-21 new firmware reads the receiver in again, announced and closed by the startup ready line", () => {
  test("a new firmware: one announcing line, a full read-in, then the ready line of the startup", async () => {
    const store = await readIn();
    const run = await connect(store, { ynca: "1.10/2.40", yxc: "2.51" });
    expect(run.info).toEqual([
      "living: new firmware found (2.40 → 2.51) — reading the receiver again, this can take a few minutes",
      readyLine("living", ["ynca", "yxc"]),
    ]);
    expect(run.settled).toBe(1);
    expect(run.settleWrites).toBeGreaterThan(0);
    expect(store.tree.firmware.yxc).toBe("2.51");
    expect(store.tree.settledVersion).toBe("3.2.0");
  });

  test("the ready line closing the read-in is the very line the startup logs", async () => {
    const store = await readIn();
    const update = await connect(store, { ynca: "1.10/2.51", yxc: "2.40" });
    const startup: string[] = [];
    const attempt = (transport: Transport): TransportAttempt => ({
      transport,
      build: () => ({ ...connection(transport, "1.10/2.51"), connect: () => Promise.resolve(true) }),
    });
    const handle = await connectTransports("living", [attempt("ynca"), attempt("yxc")], {
      upsertObject: () => Promise.resolve(),
      log: { debug: () => undefined, info: message => startup.push(message), warn: () => undefined },
    });
    handle?.close();
    expect(startup).toHaveLength(1);
    expect(update.info.at(-1)).toBe(startup[0]);
  });

  test("the same firmware again announces nothing and reads nothing in", async () => {
    const store = await readIn();
    const run = await connect(store, { ynca: "1.10/2.40", yxc: "2.40" });
    expect(run.info).toEqual([]);
    expect(run.settled).toBe(0);
    expect(run.settleWrites).toBe(0);
  });

  test("no firmware reported is no firmware update", async () => {
    const store = await readIn();
    const run = await connect(store, { ynca: undefined, yxc: "" });
    expect(run.info).toEqual([]);
    expect(run.settled).toBe(0);
    expect(store.tree.firmware).toEqual({ ynca: "1.10/2.40", yxc: "2.40" });
  });

  test("after the read-in for the new firmware, the next connect with it is quiet again", async () => {
    const store = await readIn();
    await connect(store, { ynca: "1.10/2.40", yxc: "2.51" });
    const again = await connect(store, { ynca: "1.10/2.40", yxc: "2.51" });
    expect(again.info).toEqual([]);
    expect(again.settled).toBe(0);
  });
});
