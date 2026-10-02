import { describe, expect, test } from "vitest";
import {
  MultiTransportHandle,
  type ConnectableTransport,
  type WriteOutcome,
} from "../lib/lifecycle/multi-transport-handle";
import type { LearnedTree } from "../lib/lifecycle/learned-tree";
import { pickOwner } from "../lib/catalog/owner-policy";
import type { ObjectDef } from "../lib/catalog/types";
import type { Transport } from "../lib/catalog/owner-policy";

/** A device that has not been read in yet — built here, so the guard also loads on releases before the learned tree. */
const emptyTree = (): LearnedTree => ({ shared: {}, transports: [], firmware: {} });

// Y-04: a command goes to the most modern protocol that carries it (MusicCast, then YNCA, then XML). When it fails
// there, the next one gets it; when none takes it, the device cannot do it and the command is not sent again.

const log = { debug: (): void => undefined, info: (): void => undefined, warn: (): void => undefined };

/** A plain switch every protocol builds the same way — no census override, so only the rank decides. */
const MUTE: ObjectDef = {
  id: "mute",
  type: "state",
  common: { name: "mute", type: "boolean", role: "switch", read: true, write: true },
};

interface Fake extends ConnectableTransport {
  writes: unknown[];
  outcome: WriteOutcome;
  drop(): void;
}

function fake(transport: Transport): Fake {
  let onDrop: ((reason?: Error) => void) | undefined;
  const conn: Fake = {
    transport,
    writes: [],
    outcome: "sent",
    connect: () => Promise.resolve(true),
    buildObjects: () => [MUTE],
    seedOwned: () => undefined,
    handleWrite: (_id, value): Promise<WriteOutcome> => {
      conn.writes.push(value);
      return Promise.resolve(conn.outcome);
    },
    onDrop: cb => {
      onDrop = cb;
    },
    close: () => undefined,
    drop: () => onDrop?.(new Error("gone")),
  };
  return conn;
}

/** Let the fire-and-forget write chain run to its end. */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

async function device(order: Transport[]): Promise<{ handle: MultiTransportHandle; by: Record<Transport, Fake> }> {
  const by = { yxc: fake("yxc"), ynca: fake("ynca"), xml: fake("xml") };
  const store: { tree: LearnedTree } = { tree: emptyTree() };
  const handle = new MultiTransportHandle(
    "living",
    order.map(t => by[t]),
    {
      upsertObject: () => Promise.resolve(),
      log,
      adapterVersion: "3.2.0",
      tree: { get: () => store.tree, set: tree => (store.tree = tree) },
      settleTree: () => Promise.resolve(),
    },
  );
  await handle.start();
  return { handle, by };
}

describe("Y-04 the most modern protocol first, then the next; never sent where none can", () => {
  test("the rank is MusicCast, then YNCA, then XML", () => {
    expect(pickOwner("mute", ["xml", "ynca", "yxc"])).toBe("yxc");
    expect(pickOwner("mute", ["xml", "ynca"])).toBe("ynca");
    expect(pickOwner("mute", ["xml"])).toBe("xml");
  });

  test("a command the most modern protocol takes goes there alone, whatever order the protocols connected in", async () => {
    const { handle, by } = await device(["xml", "ynca", "yxc"]);
    handle.handleStateChange("living.mute", false, true);
    await flush();
    expect([by.yxc.writes, by.ynca.writes, by.xml.writes]).toEqual([[true], [], []]);
    handle.close();
  });

  test("refused by MusicCast it goes to YNCA, refused there it goes to XML — each once", async () => {
    const { handle, by } = await device(["yxc", "ynca", "xml"]);
    by.yxc.outcome = "refused";
    by.ynca.outcome = "unavailable";
    handle.handleStateChange("living.mute", false, false);
    await flush();
    expect([by.yxc.writes, by.ynca.writes, by.xml.writes]).toEqual([[false], [false], [false]]);
    handle.close();
  });

  test("with MusicCast offline the command goes to YNCA", async () => {
    const { handle, by } = await device(["yxc", "ynca", "xml"]);
    by.yxc.drop();
    handle.handleStateChange("living.mute", false, true);
    await flush();
    expect([by.yxc.writes, by.ynca.writes, by.xml.writes]).toEqual([[], [true], []]);
    handle.close();
  });

  test("when no protocol takes it the device cannot do it: one try each, nothing more", async () => {
    const { handle, by } = await device(["yxc", "ynca", "xml"]);
    for (const conn of Object.values(by)) {
      conn.outcome = "refused";
    }
    handle.handleStateChange("living.mute", false, true);
    await flush();
    await flush();
    expect([by.yxc.writes.length, by.ynca.writes.length, by.xml.writes.length]).toEqual([1, 1, 1]);
    handle.close();
  });
});
