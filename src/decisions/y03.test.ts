import { describe, expect, test } from "vitest";
import {
  MultiTransportHandle,
  type ConnectableTransport,
  type WriteOutcome,
} from "../lib/lifecycle/multi-transport-handle";
import type { LearnedTree } from "../lib/lifecycle/learned-tree";
import type { ObjectDef } from "../lib/catalog/types";
import type { Transport } from "../lib/catalog/owner-policy";

/** A device that has not been read in yet — built here, so the guard also loads on releases before the learned tree. */
const emptyTree = (): LearnedTree => ({ shared: {}, transports: [], firmware: {} });

// Y-03: a receiver loses power as a whole. Which protocol owns a datapoint is fixed: a protocol that drops, a
// device that goes away, a protocol that comes back or a restart with one protocol missing moves nothing.

const log = { debug: (): void => undefined, info: (): void => undefined, warn: (): void => undefined };

function state(id: string, extra: Record<string, unknown> = {}): ObjectDef {
  return {
    id,
    type: "state",
    common: { name: id, type: "boolean", role: "switch", read: true, write: true, ...extra },
  };
}

interface Fake extends ConnectableTransport {
  writes: string[];
  drop(): void;
}

function fake(transport: Transport, objects: readonly ObjectDef[]): Fake {
  let onDrop: ((reason?: Error) => void) | undefined;
  const conn: Fake = {
    transport,
    writes: [],
    connect: () => Promise.resolve(true),
    buildObjects: () => objects,
    seedOwned: () => undefined,
    handleWrite: (id): Promise<WriteOutcome> => {
      conn.writes.push(id);
      return Promise.resolve("sent");
    },
    onDrop: cb => {
      onDrop = cb;
    },
    close: () => undefined,
    drop: () => onDrop?.(new Error("power cut")),
  };
  return conn;
}

const YNCA_OBJECTS = [state("power"), state("mute"), state("input", { type: "string" })];
const YXC_OBJECTS = [state("power"), state("mute"), state("input", { type: "string" }), state("player.shuffle")];

/** Let every fire-and-forget write and learn run to its end. */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** One receiver's handles, with what they wrote and scheduled. */
interface Harness {
  make(transports: Transport[], missing?: Transport[]): { handle: MultiTransportHandle; conns: Fake[] };
  upserts: string[];
  settles: string[];
  treeWrites: LearnedTree[];
  timers: Array<() => void>;
  rebuilt: Fake[];
  gone(): number;
}

/**
 * A receiver whose transports can be dropped and brought back by hand.
 *
 * @param store the device's stored tree, shared across handles like the capability profile
 * @param store.tree the tree itself
 * @returns the harness
 */
function harness(store: { tree: LearnedTree }): Harness {
  const upserts: string[] = [];
  const settles: string[] = [];
  const treeWrites: LearnedTree[] = [];
  const timers: Array<() => void> = [];
  const rebuilt: Fake[] = [];
  let gone = 0;
  const make = (
    transports: Transport[],
    missing: Transport[] = [],
  ): { handle: MultiTransportHandle; conns: Fake[] } => {
    const conns = transports.map(t => fake(t, t === "ynca" ? YNCA_OBJECTS : YXC_OBJECTS));
    const handle = new MultiTransportHandle("living", conns, {
      upsertObject: (id, _def, settle) => {
        upserts.push(id);
        if (settle === true) {
          settles.push(id);
        }
        return Promise.resolve();
      },
      log,
      adapterVersion: "3.2.0",
      missing,
      tree: {
        get: () => store.tree,
        set: tree => {
          store.tree = tree;
          treeWrites.push(tree);
        },
      },
      settleTree: () => Promise.resolve(),
      rebuild: transport => {
        const conn = fake(transport, transport === "ynca" ? YNCA_OBJECTS : YXC_OBJECTS);
        rebuilt.push(conn);
        return conn;
      },
      schedule: cb => {
        timers.push(cb);
        return timers.length;
      },
      cancel: () => undefined,
      backoffFactory: () => ({ nextDelay: () => 1000, reset: () => undefined }),
    });
    handle.onDrop(() => {
      gone++;
    });
    return { handle, conns };
  };
  return { make, upserts, settles, treeWrites, timers, rebuilt, gone: () => gone };
}

describe("Y-03 an outage is the whole receiver; ownership does not move at runtime", () => {
  test("a protocol that drops writes nothing and hands nothing over; back again, it owns what it owned", async () => {
    const store = { tree: emptyTree() };
    const h = harness(store);
    const { handle, conns } = h.make(["ynca", "yxc"]);
    await handle.start();
    // Positive control: the read-in wrote the tree, MusicCast owns power and mute, YNCA owns the input.
    expect(h.upserts.length).toBeGreaterThan(0);
    expect(store.tree.shared.power?.[0]).toBe("yxc");
    expect(store.tree.shared.input?.[0]).toBe("ynca");
    const [ynca, yxc] = conns;
    h.upserts.length = 0;
    h.treeWrites.length = 0;

    yxc.drop();
    await flush();
    expect(h.upserts).toEqual([]);
    expect(h.treeWrites).toEqual([]);
    // The receiver is not gone while YNCA answers; only MusicCast is reconnected.
    expect(h.gone()).toBe(0);
    expect(h.timers).toHaveLength(1);

    // The dropped owner's datapoints did not change hands: a write is not owned by YNCA now.
    handle.handleStateChange("living.input", false, "HDMI1");
    await flush();
    expect(ynca.writes).toEqual(["input"]);

    // MusicCast comes back: nothing is written, and it owns power again — it never stopped owning it.
    h.timers.shift()!();
    await flush();
    expect(h.rebuilt).toHaveLength(1);
    expect(h.upserts).toEqual([]);
    expect(h.treeWrites).toEqual([]);
    handle.handleStateChange("living.power", false, true);
    await flush();
    expect(h.rebuilt[0].writes).toEqual(["power"]);
    expect(ynca.writes).toEqual(["input"]);
    handle.close();
  });

  test("power gone: every protocol drops, the device is reported gone once and nothing is written", async () => {
    const store = { tree: emptyTree() };
    const h = harness(store);
    const { handle, conns } = h.make(["ynca", "yxc"]);
    await handle.start();
    h.upserts.length = 0;
    h.treeWrites.length = 0;
    for (const conn of conns) {
      conn.drop();
    }
    await flush();
    expect(h.gone()).toBe(1);
    expect(h.upserts).toEqual([]);
    expect(h.treeWrites).toEqual([]);
    handle.close();
  });

  test("a restart with one protocol still booting keeps the stored owners and rebuilds nothing, however long", async () => {
    const store = { tree: emptyTree() };
    const first = harness(store);
    const initial = first.make(["ynca", "yxc"]);
    await initial.handle.start();
    initial.handle.close();
    const stored = structuredClone(store.tree);

    // The next start: only YNCA answers; MusicCast is known and reconnected — the one timer there is.
    const h = harness(store);
    const { handle } = h.make(["ynca"], ["yxc"]);
    await handle.start();
    expect(h.timers).toHaveLength(1);
    expect(h.upserts.filter(id => id === "living.power" || id === "living.mute")).toEqual([]);
    expect(store.tree).toEqual(stored);
    // MusicCast answers again: it still owns what it owned, and no read-in rebuilt the tree in between.
    h.timers.shift()!();
    await flush();
    expect(h.settles).toEqual([]);
    handle.handleStateChange("living.power", false, true);
    await flush();
    expect(h.rebuilt[0].writes).toEqual(["power"]);
    expect(store.tree.shared.power?.[0]).toBe("yxc");
    handle.close();
  });
});
