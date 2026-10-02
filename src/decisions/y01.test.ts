import { describe, expect, test, vi } from "vitest";

// Y-01: a receiver that has been read in keeps its tree. Running code — a protocol that drops, comes back or answers
// with less, a reconnect, the datapoint balance — never deletes a datapoint and never empties a value list or a
// limit. Only the completion of a read-in after an adapter update may take something away.

/** The adapter base: in-memory object and state stores with js-controller's merge semantics. */
vi.mock("@iobroker/adapter-core", () => {
  const copy = <T>(value: T | undefined): T | null =>
    value === undefined || value === null ? null : structuredClone(value);
  class Adapter {
    public log = { silly: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    public namespace = "yamaha.0";
    public version = "3.2.0";
    public adapterDir = "/tmp/yamaha";
    public config: Record<string, unknown> = {};
    public objects = new Map<string, Record<string, unknown>>();
    public states = new Map<string, { val: unknown; ack: boolean }>();
    public foreignObjects = new Map<string, Record<string, unknown>>();
    public deleted: string[] = [];
    public on = vi.fn();
    private key(id: string): string {
      return id.replace(`${this.namespace}.`, "");
    }
    public setState = vi.fn((id: string, state: { val?: unknown; ack?: boolean }) => {
      this.states.set(this.key(id), { val: state?.val, ack: state?.ack === true });
      return Promise.resolve();
    });
    public setStateChangedAsync = vi.fn((id: string, state: { val?: unknown; ack?: boolean }) => {
      this.states.set(this.key(id), { val: state?.val, ack: state?.ack === true });
      return Promise.resolve({ id, notChanged: false });
    });
    public getStateAsync = vi.fn((id: string) => Promise.resolve(copy(this.states.get(this.key(id)))));
    public extendObject = vi.fn((id: string, obj: Record<string, unknown>) => {
      const k = this.key(id);
      const prev = this.objects.get(k) ?? {};
      const prevCommon = (prev.common ?? {}) as Record<string, unknown>;
      const nextCommon = (obj.common ?? {}) as Record<string, unknown>;
      const common: Record<string, unknown> = { ...prevCommon, ...nextCommon };
      // js-controller merges a states map key by key; `null` empties it.
      if ("states" in nextCommon) {
        const before = prevCommon.states;
        const after = nextCommon.states;
        common.states =
          after !== null && typeof after === "object" && before !== null && typeof before === "object"
            ? { ...before, ...after }
            : after;
      }
      this.objects.set(k, { ...prev, ...obj, common, native: { ...(prev.native ?? {}), ...(obj.native ?? {}) } });
      return Promise.resolve();
    });
    public setObjectNotExistsAsync = vi.fn((id: string, obj: Record<string, unknown>) => {
      if (!this.objects.has(this.key(id))) {
        this.objects.set(this.key(id), obj);
      }
      return Promise.resolve();
    });
    public getObjectAsync = vi.fn((id: string) => Promise.resolve(copy(this.objects.get(this.key(id)))));
    public getAdapterObjectsAsync = vi.fn(() => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of this.objects) {
        out[`${this.namespace}.${k}`] = copy(v);
      }
      return Promise.resolve(out);
    });
    public delObjectAsync = vi.fn((id: string, options?: { recursive?: boolean }) => {
      const key = this.key(id);
      this.deleted.push(key);
      this.objects.delete(key);
      if (options?.recursive) {
        for (const existing of [...this.objects.keys()]) {
          if (existing.startsWith(`${key}.`)) {
            this.deleted.push(existing);
            this.objects.delete(existing);
          }
        }
      }
      return Promise.resolve();
    });
    public delForeignObjectAsync = vi.fn((id: string) => {
      const key = this.key(id);
      this.deleted.push(key);
      this.objects.delete(key);
      return Promise.resolve();
    });
    public getStatesAsync = vi.fn(() => {
      const out: Record<string, { val: unknown; ack: boolean }> = {};
      for (const [k, v] of this.states) {
        out[`${this.namespace}.${k}`] = v;
      }
      return Promise.resolve(out);
    });
    public getForeignObjectAsync = vi.fn((id: string) => Promise.resolve(copy(this.foreignObjects.get(id))));
    public setForeignObjectAsync = vi.fn((id: string, obj: Record<string, unknown>) => {
      this.foreignObjects.set(id, obj);
      return Promise.resolve();
    });
    // Replaces, it does not merge — the way the adapter drops a key from one of its own objects.
    public setForeignObject = vi.fn((id: string, obj: Record<string, unknown>) => {
      if (id.startsWith(`${this.namespace}.`)) {
        this.objects.set(this.key(id), obj);
      } else {
        this.foreignObjects.set(id, obj);
      }
      return Promise.resolve();
    });
    public extendForeignObjectAsync = vi.fn((id: string, patch: Record<string, unknown>) => {
      if (id.startsWith(`${this.namespace}.`)) {
        return this.extendObject(id, patch);
      }
      const prev = this.foreignObjects.get(id) ?? {};
      this.foreignObjects.set(id, { ...prev, native: { ...(prev.native ?? {}), ...(patch.native ?? {}) } });
      return Promise.resolve();
    });
    public getForeignStatesAsync = vi.fn(() => Promise.resolve({}));
    public setForeignStateAsync = vi.fn(() => Promise.resolve());
    public getForeignObjectsAsync = vi.fn(() => Promise.resolve({}));
    public restart = vi.fn();
    public subscribeStatesAsync = vi.fn(() => Promise.resolve());
    public setTimeout = vi.fn((_cb: () => void, _ms: number) => ({ kind: "timeout" }));
    public clearTimeout = vi.fn();
    public setInterval = vi.fn(() => ({ kind: "interval" }));
    public clearInterval = vi.fn();
    constructor(_opts: unknown) {}
  }
  return {
    Adapter,
    I18n: { init: vi.fn(() => Promise.resolve(undefined)) },
    getAbsoluteInstanceDataDir: () => "/tmp/yamaha-data",
  };
});

const fakes = vi.hoisted(() => ({
  attempts: [] as Array<{ deps: Record<string, unknown> }>,
  connected: [] as Array<{ drop(): void }>,
}));
vi.mock("../lib/attempt-device", () => ({
  attemptDevice: vi.fn((_device: unknown, deps: Record<string, unknown>) => {
    fakes.attempts.push({ deps });
    let onDrop: (reason?: Error) => void = () => undefined;
    const handle = {
      onDrop: (cb: (reason?: Error) => void) => {
        onDrop = cb;
      },
      handleStateChange: () => undefined,
      close: () => undefined,
      drop: () => onDrop(new Error("power cut")),
    };
    fakes.connected.push(handle);
    return Promise.resolve(handle);
  }),
}));
vi.mock("../lib/discovery", () => ({
  discoverYamaha: vi.fn(() => Promise.resolve([])),
  probeDescription: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("../lib/ssdp-listener", () => ({
  SsdpListener: class {
    public start = vi.fn(() => Promise.resolve());
    public close = vi.fn();
  },
}));
vi.mock("../lib/discovered-store", () => ({
  isExcluded: () => false,
  readDiscovered: vi.fn(() => Promise.resolve([])),
  readDiscoveredChecked: vi.fn(() => Promise.resolve({ records: [], readable: true })),
  writeDiscovered: vi.fn(() => Promise.resolve()),
  readIgnored: vi.fn(() => Promise.resolve([])),
  writeIgnored: vi.fn(() => Promise.resolve()),
  readExcluded: vi.fn(() => Promise.resolve([])),
  writeExcluded: vi.fn(() => Promise.resolve()),
}));
vi.mock("../lib/discovered-store-deps", () => ({
  discoveredStoreDeps: () => ({}),
  ignoredStoreDeps: () => ({}),
  excludedStoreDeps: () => ({}),
}));
vi.mock("../lib/yxc/push-receiver", () => ({
  YxcPushReceiver: class {
    public start = vi.fn();
    public close = vi.fn();
    public register = vi.fn(() => () => undefined);
  },
}));

import { Yamaha } from "../main";
import {
  MultiTransportHandle,
  type TransportConnection,
  type WriteOutcome,
} from "../lib/lifecycle/multi-transport-handle";
import type { LearnedTree } from "../lib/lifecycle/learned-tree";
import type { ObjectDef } from "../lib/catalog/types";
import type { Transport } from "../lib/catalog/owner-policy";

/** A device that has not been read in yet — built here, so the guard also loads on releases before the learned tree. */
const emptyTree = (): LearnedTree => ({ shared: {}, transports: [], firmware: {} });

interface Internals {
  onReady(): Promise<void>;
  config: Record<string, unknown>;
  objects: Map<string, Record<string, unknown>>;
  states: Map<string, { val: unknown; ack: boolean }>;
  deleted: string[];
  setTimeout: ReturnType<typeof vi.fn>;
}

type Upsert = (id: string, def: unknown, settle?: boolean) => Promise<void>;

/** Let the supervisor's attempt chain and every queued write run to their end. */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5));

/**
 * The adapter, started with one device that was read in earlier: its tree is already in the object store.
 *
 * @param tree the device's objects, relative to the device
 * @returns the adapter internals and the device's real object-writing path
 */
async function started(tree: Record<string, Record<string, unknown>>): Promise<{ i: Internals; upsert: Upsert }> {
  fakes.attempts.length = 0;
  fakes.connected.length = 0;
  const i = new Yamaha() as unknown as Internals;
  i.config = { devices: [{ id: "living", name: "living", ip: "192.168.1.10" }], discovery: "never" };
  i.objects.set("living", { type: "device", common: { name: "living" }, native: {} });
  for (const [id, object] of Object.entries(tree)) {
    i.objects.set(`living.${id}`, { ...object, native: {} });
  }
  await i.onReady();
  await flush();
  return { i, upsert: fakes.attempts[0].deps.upsertObject as Upsert };
}

const SOUND_PROGRAM = {
  type: "state",
  common: {
    name: "p",
    type: "string",
    role: "text",
    read: true,
    write: true,
    states: { Straight: "Straight", Jazz: "Jazz" },
  },
};
const BASS = {
  type: "state",
  common: { name: "b", type: "number", role: "level", read: true, write: true, min: -6, max: 6, step: 0.5 },
};

function commonOf(i: Internals, id: string): Record<string, unknown> {
  return (i.objects.get(id)?.common ?? {}) as Record<string, unknown>;
}

describe("Y-01 a receiver that has been read in keeps its tree", () => {
  test("running, a definition without a list or with a shorter one empties nothing; a longer one adds", async () => {
    const { i, upsert } = await started({ soundProgram: SOUND_PROGRAM });
    await upsert("living.soundProgram", { type: "state", common: { name: "p", type: "string", role: "text" } });
    await upsert("living.soundProgram", {
      type: "state",
      common: { name: "p", type: "string", role: "text", states: { Straight: "Straight" } },
    });
    expect(Object.keys(commonOf(i, "living.soundProgram").states as object).sort()).toEqual(["Jazz", "Straight"]);
    // Positive control: what the device adds does arrive, so the store is really being written.
    await upsert("living.soundProgram", {
      type: "state",
      common: { name: "p", type: "string", role: "text", states: { Straight: "Straight", Drama: "Drama" } },
    });
    expect(Object.keys(commonOf(i, "living.soundProgram").states as object).sort()).toEqual([
      "Drama",
      "Jazz",
      "Straight",
    ]);
  });

  test("running, a definition without limits or with other ones keeps the stored limits", async () => {
    const { i, upsert } = await started({ "sound.bass": BASS });
    await upsert("living.sound.bass", { type: "state", common: { name: "b", type: "number", role: "level" } });
    await upsert("living.sound.bass", {
      type: "state",
      common: { name: "b", type: "number", role: "level", min: -3, max: 3, step: 1 },
    });
    const common = commonOf(i, "living.sound.bass");
    expect([common.min, common.max, common.step]).toEqual([-6, 6, 0.5]);
  });

  test("running, a reconnect and the datapoint balance delete nothing — not even a datapoint never filled", async () => {
    const { i } = await started({
      "multiroom.zone2.sleep": { type: "state", common: { name: "s", type: "string", role: "text" } },
      multiroom: { type: "folder", common: { name: "m" } },
      "multiroom.zone4": { type: "channel", common: { name: "z" } },
    });
    expect(fakes.connected).toHaveLength(1);
    // Power cut, then the supervisor's reconnect; then every pending timer (balance, patches) fires.
    fakes.connected[0].drop();
    await flush();
    for (const call of [...i.setTimeout.mock.calls]) {
      (call[0] as () => void)();
    }
    await flush();
    for (const call of [...i.setTimeout.mock.calls]) {
      (call[0] as () => void)();
    }
    await flush();
    expect(fakes.attempts.length).toBeGreaterThan(1);
    expect(i.deleted.filter(id => id.startsWith("living."))).toEqual([]);
    expect(i.objects.has("living.multiroom.zone2.sleep")).toBe(true);
    expect(i.objects.has("living.multiroom.zone4")).toBe(true);
  });

  test("the completion of a read-in is the one moment a list and a limit may shrink", async () => {
    const { i, upsert } = await started({ soundProgram: SOUND_PROGRAM, "sound.bass": BASS });
    await upsert(
      "living.soundProgram",
      { type: "state", common: { name: "p", type: "string", role: "text", states: { Straight: "Straight" } } },
      true,
    );
    await upsert("living.sound.bass", { type: "state", common: { name: "b", type: "number", role: "level" } }, true);
    expect(Object.keys(commonOf(i, "living.soundProgram").states as object)).toEqual(["Straight"]);
    expect(commonOf(i, "living.sound.bass").min).toBeUndefined();
  });
});

describe("Y-01 the device handle never shrinks a read-in tree at runtime", () => {
  const log = { debug: (): void => undefined, info: (): void => undefined, warn: (): void => undefined };

  /**
   * A transport whose list can shrink and which can drop.
   *
   * @param transport the protocol
   * @param states the list it builds right now
   * @returns the connection
   */
  function conn(
    transport: Transport,
    states: () => Record<string, string>,
  ): TransportConnection & { drop(): void; reshape(): void } {
    let onDrop: ((reason?: Error) => void) | undefined;
    let onShape: (() => void) | undefined;
    const connection: TransportConnection & { drop(): void; reshape(): void } = {
      transport,
      buildObjects: (): ObjectDef[] => [
        {
          id: "soundProgram",
          type: "state",
          common: { name: "p", type: "string", role: "text", read: true, write: true, states: states() },
        },
      ],
      seedOwned: () => undefined,
      handleWrite: (): Promise<WriteOutcome> => Promise.resolve("sent"),
      onDrop: cb => {
        onDrop = cb;
      },
      onShapeChanged: cb => {
        onShape = cb;
      },
      close: () => undefined,
      drop: () => onDrop?.(new Error("gone")),
      reshape: () => onShape?.(),
    };
    return connection;
  }

  test("after the read-in, a protocol that answers with a shorter list never asks for a shrinking write", async () => {
    let list: Record<string, string> = { Straight: "Straight", Jazz: "Jazz" };
    const ynca = conn("ynca", () => list);
    const xml = conn("xml", () => list);
    const writes: Array<{ id: string; settle: boolean }> = [];
    const store: { tree: LearnedTree } = { tree: emptyTree() };
    const handle = new MultiTransportHandle("living", [ynca, xml], {
      upsertObject: (id, _def, settle) => {
        writes.push({ id, settle: settle === true });
        return Promise.resolve();
      },
      log,
      adapterVersion: "3.2.0",
      tree: { get: () => store.tree, set: tree => (store.tree = tree) },
      settleTree: () => Promise.resolve(),
    });
    await handle.start();
    // Positive control: the read-in itself was the one shrinking write.
    expect(writes.filter(w => w.settle).map(w => w.id)).toEqual(["living.soundProgram"]);
    writes.length = 0;
    list = { Straight: "Straight" };
    ynca.reshape();
    xml.drop();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.filter(w => w.settle)).toEqual([]);
    handle.close();
  });
});
