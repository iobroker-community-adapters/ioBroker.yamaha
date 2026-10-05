import { vi } from "vitest";
import { YncaDeviceController } from "../device-controller";
import { YncaClient } from "./ynca-client";
import { availGets, YNCA_CATALOG } from "./catalog";
import { answeredAvail, sameReceiver } from "./shape-reader";
import { createSubunitCache, type YncaAvailSnapshot } from "./subunit-cache";
import type { ObjectDef } from "../catalog/types";
import { CommandGate } from "../lifecycle/command-gate";
import { ProbeMemory } from "../lifecycle/probe-memory";
import { DISCOVERY_SCHEMA } from "../lifecycle/discovery-schema";
import { FakeClient, testGate } from "../../../test/helpers/ynca-fake-client";
import { SimSocket, simTimers } from "../../../test/helpers/ynca-sim";

/** Every subunit the AVAIL probe asks. */
const PROBED = availGets(YNCA_CATALOG).map(get => get.subunit);

const silent = { debug: (): void => undefined, info: (): void => undefined, warn: (): void => undefined };

/**
 * One controller start against a simulated receiver on the real client.
 *
 * @param values the receiver's functions (`SUBUNIT:FUNC` → value)
 * @param memory the device's memory, kept across starts by the caller
 * @param snap the AVAIL snapshot holder, kept across starts by the caller
 * @param snap.s the snapshot
 * @returns whether the start succeeded and which objects it built
 */
async function startOnSim(
  values: Record<string, string>,
  memory: ProbeMemory,
  snap: { s?: YncaAvailSnapshot },
): Promise<{ ok: boolean; objects: string[] }> {
  const socket = new SimSocket(5, { ...values });
  const gate = new CommandGate({ minSpacingMs: 100, timers: simTimers });
  const client = new YncaClient("192.0.2.1", simTimers, gate, () => socket);
  const objects: string[] = [];
  const controller = new YncaDeviceController("rx", {
    client,
    gate,
    upsertObject: (id: string) => {
      objects.push(id);
      return Promise.resolve();
    },
    setStateAck: () => undefined,
    log: silent,
    subunitCache: createSubunitCache(snap.s, s => (snap.s = s)),
    probeMemory: memory,
  });
  const started = controller.start();
  setImmediate(() => socket.emitConnect());
  await vi.advanceTimersByTimeAsync(300_000);
  const ok = await started;
  controller.close();
  return { ok, objects };
}

/** A receiver that knows the amplifier basics. */
const RECEIVER: Record<string, string> = {
  "SYS:MODELNAME": "RX-V473",
  "SYS:VERSION": "1.00",
  "MAIN:PWR": "On",
  "MAIN:VOL": "-40.0",
  "MAIN:MUTE": "Off",
  "MAIN:INP": "HDMI1",
};

describe("presence is proven by AVAIL alone (review 2026-10-05, A1)", () => {
  test("the closing marker's answer and a pushed line prove no subunit", () => {
    expect(
      answeredAvail({
        model: "",
        subunits: { SYS: { VERSION: "1.00" }, MAIN: { VOL: "-30.0" }, NETRADIO: { AVAIL: "Not Ready" } },
      }),
    ).toEqual(new Set(["NETRADIO"]));
  });

  describe("on the real client against a simulated receiver", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    test("a receiver that answers no AVAIL is swept blind — its amplifier is there, and no snapshot is kept", async () => {
      // Every AVAIL is answered @UNDEFINED; only the closing marker answers. Before the fix the marker's
      // `@SYS:VERSION=` counted as presence: the start swept SYS alone and kept `{ subunits: ["SYS"] }` for good.
      const snap: { s?: YncaAvailSnapshot } = {};
      const { ok, objects } = await startOnSim(RECEIVER, new ProbeMemory({ __schema: DISCOVERY_SCHEMA }), snap);
      expect(ok).toBe(true);
      expect(objects).toEqual(expect.arrayContaining(["rx.power", "rx.volume", "rx.mute", "rx.input"]));
      expect(snap.s).toBeUndefined();
    });

    test("a start without AVAIL answers poisons nothing: the next start that gets them keeps a real snapshot", async () => {
      const memory = new ProbeMemory({ __schema: DISCOVERY_SCHEMA });
      const snap: { s?: YncaAvailSnapshot } = {};
      const first = await startOnSim(RECEIVER, memory, snap);
      expect(first.objects).toContain("rx.power");
      const second = await startOnSim({ ...RECEIVER, "MAIN:AVAIL": "Ready" }, memory, snap);
      expect(second.objects).toContain("rx.power");
      expect(snap.s?.subunits).toEqual(["MAIN"]);
      expect(snap.s?.probed).toEqual(PROBED);
    });

    test("an installation the bug left on SYS alone is swept anew and heals", async () => {
      // What 3.2.0 kept after a probe nobody answered: a shape of SYS and a snapshot of SYS.
      const memory = new ProbeMemory({
        __schema: DISCOVERY_SCHEMA,
        yncaCapabilities: {
          model: "RX-V473",
          firmware: "1.00",
          subunits: { SYS: { MODELNAME: "RX-V473", VERSION: "1.00" } },
        },
      });
      const snap: { s?: YncaAvailSnapshot } = {
        s: { schema: DISCOVERY_SCHEMA, subunits: ["SYS"], probed: PROBED, model: "RX-V473", firmware: "1.00" },
      };
      const { objects } = await startOnSim({ ...RECEIVER, "MAIN:AVAIL": "Ready" }, memory, snap);
      expect(objects).toEqual(expect.arrayContaining(["rx.power", "rx.volume"]));
      expect(snap.s?.subunits).toEqual(["MAIN"]);
      const caps = memory.remembered<{ subunits: Record<string, unknown> }>("yncaCapabilities");
      expect(Object.keys(caps?.subunits ?? {}).sort()).toEqual(["MAIN", "SYS"]);
    });
  });
});

/**
 * The controller's deps around a fake client.
 *
 * @param client the fake device
 * @param memory the device's memory
 * @returns the deps and what the controller built
 */
function fakeDeps(
  client: FakeClient,
  memory: ProbeMemory,
): {
  objects: Array<{ id: string; def: ObjectDef }>;
  deps: ConstructorParameters<typeof YncaDeviceController>[1];
} {
  const objects: Array<{ id: string; def: ObjectDef }> = [];
  return {
    objects,
    deps: {
      client,
      upsertObject: (id: string, def: ObjectDef) => {
        objects.push({ id, def });
        return Promise.resolve();
      },
      setStateAck: () => undefined,
      log: silent,
      gate: testGate(),
      probeMemory: memory,
      subunitCache: createSubunitCache(undefined, () => undefined),
    },
  };
}

/** Lets a background refresh run out. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
};

describe("a subunit the snapshot never asked is asked on the fast path too (review 2026-10-05, A25)", () => {
  test("an update that adds a subunit to the catalog reaches an installation that starts from its memory", async () => {
    const subunits = {
      SYS: { MODELNAME: "RX-A2A", VERSION: "1.0" },
      MAIN: { PWR: "On", INP: "HDMI1" },
      NETRADIO: { PLAYBACKINFO: "Stop" },
      DEEZER: { PLAYBACKINFO: "Play", ARTIST: "x" },
    };
    const memory = new ProbeMemory({
      __schema: DISCOVERY_SCHEMA,
      yncaCapabilities: {
        model: "RX-A2A",
        firmware: "1.0",
        subunits: { SYS: subunits.SYS, MAIN: subunits.MAIN, NETRADIO: subunits.NETRADIO },
        awake: true,
      },
    });
    const client = new FakeClient();
    client.availableSubunits = ["MAIN", "NETRADIO", "DEEZER"];
    client.capabilities = { model: "RX-A2A", subunits };
    const { deps } = fakeDeps(client, memory);
    // A snapshot taken by an older adapter whose catalog had no DEEZER: it never asked it.
    let snapshot: YncaAvailSnapshot | undefined = {
      schema: DISCOVERY_SCHEMA,
      subunits: ["MAIN", "NETRADIO"],
      probed: ["MAIN", "ZONE2", "NETRADIO"],
      model: "RX-A2A",
      firmware: "1.0",
    };
    deps.subunitCache = createSubunitCache(snapshot, s => (snapshot = s));
    const controller = new YncaDeviceController("rx", deps);
    expect(await controller.start()).toBe(true);
    await settle();
    const asked = client.requests.flat();
    const availAsked = asked.filter(get => get.func === "AVAIL").map(get => get.subunit);
    expect(availAsked).toContain("DEEZER");
    // What the snapshot asked is not asked again.
    expect(availAsked).not.toContain("MAIN");
    expect(asked.some(get => get.subunit === "DEEZER" && get.func === "PLAYBACKINFO")).toBe(true);
    expect(snapshot?.subunits).toEqual(expect.arrayContaining(["MAIN", "NETRADIO", "DEEZER"]));
    expect(snapshot?.probed).toEqual(PROBED);
    const stored = memory.remembered<{ subunits: Record<string, unknown> }>("yncaCapabilities");
    expect(stored?.subunits.DEEZER).toBeDefined();
    controller.close();
  });
});

describe("an empty firmware is unknown, never a change (review 2026-10-05, A39)", () => {
  test("sameReceiver: the same model with an unknown firmware on either side is the same receiver", () => {
    expect(sameReceiver({ model: "RX", firmware: "" }, { model: "RX", firmware: "1.10" })).toBe(true);
    expect(sameReceiver({ model: "RX", firmware: "1.10" }, { model: "RX", firmware: "" })).toBe(true);
    expect(sameReceiver({ model: "RX", firmware: "1.10" }, { model: "RX", firmware: "1.20" })).toBe(false);
    expect(sameReceiver({ model: "RX", firmware: "1.10" }, { model: "RY", firmware: "1.10" })).toBe(false);
    expect(sameReceiver({ model: "", firmware: "1.10" }, { model: "", firmware: "1.10" })).toBe(false);
  });

  /**
   * A receiver remembered with its menu proof, pad dialect and observed values.
   *
   * @param firmware the firmware the memory was kept under
   * @returns the memory
   */
  const rememberedReceiver = (firmware: string): ProbeMemory =>
    new ProbeMemory({
      __schema: DISCOVERY_SCHEMA,
      yncaCapabilities: {
        model: "RX-V673",
        firmware,
        subunits: {
          SYS: { MODELNAME: "RX-V673", VERSION: firmware },
          MAIN: { PWR: "Standby", INP: "HDMI1" },
          NETRADIO: { PLAYBACKINFO: "Stop" },
        },
        awake: true,
      },
      yncaBrowseSources: { subunits: ["NETRADIO"], proven: true },
      yncaPadDialect: { dialect: "list", proven: true },
      yncaObserved: { MAIN: { SOUNDPRG: ["Enhanced"] } },
    });

  /**
   * The receiver, switched on.
   *
   * @param version what it answers to `SYS:VERSION` (undefined: it answers nothing)
   * @returns the fake device
   */
  const receiver = (version: string | undefined): FakeClient => {
    const client = new FakeClient();
    client.availableSubunits = ["MAIN", "NETRADIO"];
    client.capabilities = {
      model: "RX-V673",
      subunits: {
        SYS: { MODELNAME: "RX-V673", ...(version === undefined ? {} : { VERSION: version }) },
        MAIN: { PWR: "Standby", INP: "HDMI1" },
        NETRADIO: { PLAYBACKINFO: "Stop" },
      },
    };
    return client;
  };

  test("an identity read that lost SYS:VERSION keeps every proof and starts from the memory", async () => {
    const memory = rememberedReceiver("1.10");
    const client = receiver("1.10");
    // The identity read: MODELNAME answered, both VERSION answers late (the closing marker timed out).
    const real = client.readCapabilities.bind(client);
    let first = true;
    client.readCapabilities = gets => {
      if (first) {
        first = false;
        client.requests.push(gets);
        return Promise.resolve({ model: "RX-V673", subunits: { SYS: { MODELNAME: "RX-V673" } } });
      }
      return real(gets);
    };
    const controller = new YncaDeviceController("rx", fakeDeps(client, memory).deps);
    expect(await controller.start()).toBe(true);
    // The fast path: the identity, then the few decisive values — no probe, no sweep before the ready line.
    expect(client.requests[1].map(get => `${get.subunit}:${get.func}`)).toEqual(["MAIN:PWR", "MAIN:INP"]);
    expect(memory.remembered("yncaBrowseSources")).toEqual({ subunits: ["NETRADIO"], proven: true });
    expect(memory.remembered("yncaPadDialect")).toEqual({ dialect: "list", proven: true });
    expect(memory.remembered("yncaObserved")).toMatchObject({ MAIN: { SOUNDPRG: ["Enhanced"] } });
    // Nothing was read, so no firmware is reported — the handle keeps the one it knows.
    expect(controller.firmware()).toBeUndefined();
    controller.close();
  });

  test("a refresh that did not get SYS:VERSION back keeps the firmware the shape was read under", async () => {
    const memory = rememberedReceiver("1.10");
    const client = receiver(undefined);
    const real = client.readCapabilities.bind(client);
    let first = true;
    client.readCapabilities = gets => {
      if (first) {
        first = false;
        client.requests.push(gets);
        return Promise.resolve({ model: "RX-V673", subunits: { SYS: { MODELNAME: "RX-V673", VERSION: "1.10" } } });
      }
      return real(gets);
    };
    const controller = new YncaDeviceController("rx", fakeDeps(client, memory).deps);
    await controller.start();
    await settle();
    // Stored as "" it voided the whole memory at the next start.
    expect(memory.remembered<{ firmware: string }>("yncaCapabilities")?.firmware).toBe("1.10");
    controller.close();
  });

  test("a memory kept under an unknown firmware is the same receiver, and learns the firmware", async () => {
    const memory = rememberedReceiver("");
    const client = receiver("1.10");
    const controller = new YncaDeviceController("rx", fakeDeps(client, memory).deps);
    await controller.start();
    await settle();
    expect(memory.remembered("yncaBrowseSources")).toEqual({ subunits: ["NETRADIO"], proven: true });
    expect(memory.remembered<{ firmware: string }>("yncaCapabilities")?.firmware).toBe("1.10");
    expect(controller.firmware()).toBe("1.10");
    controller.close();
  });

  test("another known firmware is another receiver: what it proved is let go and it is swept anew", async () => {
    const memory = rememberedReceiver("1.10");
    const client = receiver("1.20");
    const controller = new YncaDeviceController("rx", fakeDeps(client, memory).deps);
    await controller.start();
    expect(memory.remembered("yncaPadDialect")).toBeUndefined();
    expect(memory.remembered<{ firmware: string }>("yncaCapabilities")?.firmware).toBe("1.20");
    expect(client.requests[1].every(get => get.func === "AVAIL")).toBe(true);
    controller.close();
  });
});
