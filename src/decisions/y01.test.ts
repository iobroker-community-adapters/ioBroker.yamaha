import { describe, expect, test, vi } from "vitest";

// Y-01: a receiver that has been read in keeps its tree. Running code — a protocol that drops, comes back or answers
// with less, a reconnect, the datapoint balance — never deletes a datapoint and never empties a value list or a
// limit. Only the completion of a read-in after an adapter update may take something away. One exception (krobi
// 2026-10-05 22:47 "y01 yes, exactly these exceptions are approved and wanted"): while running, only the LABEL of an
// existing list entry may change, and only on the lists of names the user gives in the receiver — inputs, scenes,
// sound programs, zones (`liveLabels`). Keys, type and limits stay.

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
import { YncaDeviceController } from "../lib/device-controller";
import { yncaObjectsFor, type InputEvidence } from "../lib/ynca/catalog";
import type { YncaCapabilities } from "../lib/ynca/capability";
import type { StatesResolver } from "../lib/catalog/build-objects";
import { XmlDeviceController } from "../lib/xml/device-controller";
import type { BasicStatus } from "../lib/xml/protocol";
import { CommandGate } from "../lib/lifecycle/command-gate";
import { ProbeMemory } from "../lib/lifecycle/probe-memory";
import { DISCOVERY_SCHEMA } from "../lib/lifecycle/discovery-schema";
import { mapYxcToObjects } from "../lib/yxc/object-mapper";
import { coordinateObjectTree } from "../lib/catalog/object-tree-coordinator";

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
const INPUT = {
  type: "state",
  common: {
    name: "i",
    type: "string",
    role: "media.input",
    read: true,
    write: true,
    states: { HDMI1: "HDMI1", HDMI2: "Turntable" },
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

  test("running, a renamed entry relabels a list of the user's names; no key goes, nothing else changes", async () => {
    const { i, upsert } = await started({ input: INPUT });
    await upsert("living.input", {
      type: "state",
      common: { name: "i", type: "string", role: "media.input", states: { HDMI1: "Apple TV" } },
      liveLabels: true,
    });
    const common = commonOf(i, "living.input");
    expect(common.states).toEqual({ HDMI1: "Apple TV", HDMI2: "Turntable" });
    expect([common.type, common.role]).toEqual(["string", "media.input"]);
  });

  test("running, a list that is not the user's names keeps its labels", async () => {
    const { i, upsert } = await started({ soundProgram: SOUND_PROGRAM, input: INPUT });
    await upsert("living.soundProgram", {
      type: "state",
      common: { name: "p", type: "string", role: "text", states: { Straight: "Straight!", Jazz: "Jazz" } },
    });
    await upsert("living.input", {
      type: "state",
      common: { name: "i", type: "string", role: "media.input", states: { HDMI1: "Apple TV" } },
    });
    expect(commonOf(i, "living.soundProgram").states).toEqual({ Straight: "Straight", Jazz: "Jazz" });
    expect(commonOf(i, "living.input").states).toEqual({ HDMI1: "HDMI1", HDMI2: "Turntable" });
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

describe("Y-01 only the user's names relabel while running: inputs, scenes, sound programs, zones", () => {
  /** The datapoints whose list follows renames: the inputs, the scene recall, the sound program, any zone's. */
  const USER_NAMES = /^(?:multiroom\.zone[234B]\.)?(?:input|scene\.recall|soundProgram)$/;

  /** YNCA through the controller's own value-list resolver: the main zone and zone 2 with inputs and scenes. */
  function yncaTree(): ObjectDef[] {
    const caps: YncaCapabilities = {
      model: "RX-V6A",
      subunits: {
        SYS: { INPNAMEHDMI1: "Apple TV" },
        MAIN: { PWR: "On", INP: "HDMI1", SOUNDPRG: "Standard", SCENE1NAME: "Movie", SLEEP: "Off" },
        ZONE2: { PWR: "On", INP: "HDMI1", SCENE1NAME: "Patio", SLEEP: "Off" },
      },
    };
    const controller = Object.create(YncaDeviceController.prototype) as {
      shape: YncaCapabilities;
      observed: Record<string, unknown>;
      sceneTitles: Array<{ num: number; title: string }>;
      zoneSceneTitles: Map<string, Array<{ num: number; title: string }>>;
      statesResolver(live: YncaCapabilities, evidence: InputEvidence): StatesResolver;
    };
    Object.assign(controller, {
      shape: caps,
      observed: {},
      sceneTitles: [{ num: 1, title: "Movie" }],
      zoneSceneTitles: new Map([["zone2", [{ num: 1, title: "Patio" }]]]),
    });
    const evidence: InputEvidence = { present: new Set(["MAIN", "ZONE2"]), probed: new Set() };
    return yncaObjectsFor(caps, undefined, controller.statesResolver(caps, evidence));
  }

  /** XML through the real controller: an input list with a user's name and a scene list with a title. */
  async function xmlTree(): Promise<ObjectDef[]> {
    const statuses: Record<string, BasicStatus> = {
      Main_Zone: { power: true, input: "HDMI1", soundProgram: "Standard", sleep: "Off" },
    };
    const answers: Record<string, string> = {
      "Main_Zone|<Input><Input_Sel_Item>GetParam</Input_Sel_Item></Input>":
        "<Input_Sel_Item><Item_1><Param>HDMI1</Param><RW>RW</RW><Title>Apple TV</Title></Item_1></Input_Sel_Item>",
      "Main_Zone|<Scene><Scene_Sel_Item>GetParam</Scene_Sel_Item></Scene>":
        "<Scene_Sel_Item><Item_1><Param>Scene 1</Param><RW>W</RW><Title>Movie</Title></Item_1></Scene_Sel_Item>",
    };
    const defs = new Map<string, ObjectDef>();
    const controller = new XmlDeviceController("living", {
      gate: new CommandGate({
        minSpacingMs: 0,
        timers: {
          schedule: (h, ms) => setTimeout(h, ms),
          cancel: t => clearTimeout(t as ReturnType<typeof setTimeout>),
        },
      }),
      probeMemory: new ProbeMemory({ __schema: DISCOVERY_SCHEMA }),
      client: {
        getStatus: (zone: string) => Promise.resolve(statuses[zone] ?? {}),
        getSystemConfig: () => Promise.resolve({}),
        getDescriptor: () => Promise.resolve(""),
        send: () => Promise.resolve(),
        getXml: (zone: string, inner: string) => Promise.resolve(answers[`${zone}|${inner}`] ?? ""),
      },
      scheduleKeepalive: () => () => undefined,
      upsertObject: (id, def) => {
        defs.set(id.replace(/^living\./, ""), def);
        return Promise.resolve();
      },
      setStateAck: () => undefined,
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
      host: "192.0.2.10",
    });
    await controller.start();
    controller.close();
    return [...defs.values()];
  }

  test("the datapoints that relabel while running are exactly the user's names, over all three protocols", async () => {
    const ynca = yncaTree();
    const xml = await xmlTree();
    const yxc = mapYxcToObjects({
      zones: [{ id: "main", funcs: ["power", "sleep"], inputs: ["hdmi1"] }],
      media: [],
      names: { inputs: { hdmi1: "Apple TV" }, soundPrograms: {} },
    });
    const tree = coordinateObjectTree([
      { transport: "ynca", objects: ynca },
      { transport: "yxc", objects: yxc },
      { transport: "xml", objects: xml },
    ]).objects;
    const live = [...ynca, ...xml, ...yxc, ...tree].filter(def => def.liveLabels === true).map(def => def.id);
    // Positive control: the inputs and the scenes of YNCA and XML do relabel, so the set is not empty ...
    expect(live).toEqual(
      expect.arrayContaining(["input", "multiroom.zone2.input", "scene.recall", "multiroom.zone2.scene.recall"]),
    );
    // ... and on MusicCast too: its input labels are the names from getNameText.
    expect(yxc.filter(def => def.liveLabels === true).map(def => def.id)).toContain("input");
    expect(live.filter(id => !USER_NAMES.test(id))).toEqual([]);
    // Every other list on the same receiver keeps its labels while running.
    const lists = [...ynca, ...xml, ...yxc].filter(def => def.common.states && !USER_NAMES.test(def.id));
    expect(lists.length).toBeGreaterThan(0);
    expect(lists.filter(def => def.liveLabels === true).map(def => def.id)).toEqual([]);
  });
});
