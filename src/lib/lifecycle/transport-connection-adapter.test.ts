import { TransportConnectionAdapter, type AdaptedController } from "./transport-connection-adapter";
import type { ObjectDef } from "../catalog/types";

function st(id: string): ObjectDef {
  return { id, type: "state", common: { name: id, type: "number", role: "level", read: true, write: true } };
}

describe("TransportConnectionAdapter", () => {
  test("collects the controller's objects canonicalized, seeds only owned, routes writes back", async () => {
    const acks: Array<{ id: string; value: unknown }> = [];
    const writes: Array<{ stateId: string; value: unknown }> = [];
    const adapter = new TransportConnectionAdapter("yxc", "living", (id, value) => acks.push({ id, value }));

    // A fake controller built with the adapter's intercept deps — start() upserts + seeds through them.
    // subwooferVolume is YXC's own id, drifted to the canonical "sound.subwooferTrim".
    const controller: AdaptedController = {
      start: async () => {
        await adapter.interceptUpsert("living.subwooferVolume", st("subwooferVolume"));
        await adapter.interceptUpsert("living.volume", st("volume"));
        adapter.interceptSetStateAck("living.subwooferVolume", 3);
        adapter.interceptSetStateAck("living.volume", -30);
        return true;
      },
      handleWrite: (stateId, value) => {
        writes.push({ stateId, value });
      },
      onDrop: () => {},
      close: () => {},
    };
    adapter.bind(controller);

    expect(await adapter.connect()).toBe(true);
    // objects come back canonicalized: YXC subwooferVolume → sound.subwooferTrim
    expect(adapter.buildObjects().map(o => o.id)).toEqual(["sound.subwooferTrim", "volume"]);
    // seedOwned writes only the owned ids, under the device path
    adapter.seedOwned(new Set(["volume"]));
    expect(acks).toEqual([{ id: "living.volume", value: -30 }]);
    // handleWrite maps the canonical id back to the controller's own id (sound.subwooferTrim → subwooferVolume)
    void adapter.handleWrite("sound.subwooferTrim", 5);
    expect(writes).toContainEqual({ stateId: "subwooferVolume", value: 5 });
  });

  test("after seedOwned, later pushes are filtered live (only owned reach the adapter's setStateAck)", async () => {
    const acks: Array<{ id: string; value: unknown }> = [];
    const adapter = new TransportConnectionAdapter("yxc", "living", (id, value) => acks.push({ id, value }));
    adapter.bind({
      start: () => Promise.resolve(true),
      handleWrite: () => {},
      onDrop: () => {},
      close: () => {},
    });
    await adapter.connect();
    adapter.seedOwned(new Set(["dist.role"]));
    // a live push after seeding: dist.role owned → through; power not owned → dropped
    adapter.interceptSetStateAck("living.dist.role", "server");
    adapter.interceptSetStateAck("living.power", true);
    expect(acks).toEqual([{ id: "living.dist.role", value: "server" }]);
  });

  test("connect returns false when the controller does not start; close is forwarded", async () => {
    let closed = false;
    const adapter = new TransportConnectionAdapter("xml", "living", () => {});
    adapter.bind({
      start: () => Promise.resolve(false),
      handleWrite: () => {},
      onDrop: () => {},
      close: () => {
        closed = true;
      },
    });
    expect(await adapter.connect()).toBe(false);
    adapter.close();
    expect(closed).toBe(true);
  });
});

describe("TransportConnectionAdapter within a session (2.7.0 re-collect)", () => {
  const bound = (adapter: TransportConnectionAdapter, start: () => Promise<boolean>): void =>
    adapter.bind({ start, handleWrite: () => {}, onDrop: () => {}, close: () => {} });

  test("an upsert after the first coordination replaces the def by id and signals a shape change — once per real change", async () => {
    const adapter = new TransportConnectionAdapter("ynca", "living", () => {});
    bound(adapter, async () => {
      await adapter.interceptUpsert("living.volume", st("volume"));
      return true;
    });
    let fired = 0;
    adapter.onShapeChanged(() => {
      fired++;
    });
    await adapter.connect();
    // Collected during start: no signal — the handle coordinates once after connect anyway.
    expect(fired).toBe(0);
    adapter.seedOwned(new Set(["volume"]));
    // A new object mid-session: signalled, appended.
    await adapter.interceptUpsert("living.mute", st("mute"));
    expect(fired).toBe(1);
    expect(adapter.buildObjects().map(o => o.id)).toEqual(["volume", "mute"]);
    // The same def again: nothing changed, no signal (a controller may re-upsert freely).
    await adapter.interceptUpsert("living.mute", st("mute"));
    expect(fired).toBe(1);
    // A changed def for a known id replaces it in place (order kept — parents before children).
    await adapter.interceptUpsert("living.volume", {
      ...st("volume"),
      common: { ...st("volume").common, name: "Volume (dB)" },
    });
    expect(fired).toBe(2);
    expect(adapter.buildObjects().map(o => [o.id, o.common.name])).toEqual([
      ["volume", "Volume (dB)"],
      ["mute", "mute"],
    ]);
  });

  test("a value for an object created mid-session waits for the re-coordination, a foreign id is dropped", async () => {
    const acks: Array<{ id: string; value: unknown }> = [];
    const adapter = new TransportConnectionAdapter("ynca", "living", (id, value) => acks.push({ id, value }));
    bound(adapter, () => Promise.resolve(true));
    await adapter.connect();
    adapter.seedOwned(new Set(["volume"]));
    // The object for `mute` appears mid-session; its value arrives BEFORE the handle re-coordinated.
    await adapter.interceptUpsert("living.mute", st("mute"));
    adapter.interceptSetStateAck("living.mute", true);
    // A value for an id this transport never built belongs to another transport — dropped, not buffered.
    adapter.interceptSetStateAck("living.dist.role", "server");
    expect(acks).toEqual([]);
    adapter.seedOwned(new Set(["volume", "mute"]));
    expect(acks).toEqual([{ id: "living.mute", value: true }]);
    // The wait is over: a later push goes straight through, and nothing is replayed twice.
    adapter.interceptSetStateAck("living.mute", false);
    adapter.seedOwned(new Set(["volume", "mute"]));
    expect(acks).toEqual([
      { id: "living.mute", value: true },
      { id: "living.mute", value: false },
    ]);
  });

  test("an object created mid-session whose id another transport owns: its value is dropped at the arming", async () => {
    const acks: Array<{ id: string; value: unknown }> = [];
    const adapter = new TransportConnectionAdapter("ynca", "living", (id, value) => acks.push({ id, value }));
    bound(adapter, () => Promise.resolve(true));
    await adapter.connect();
    adapter.seedOwned(new Set(["volume"]));
    await adapter.interceptUpsert("living.mute", st("mute"));
    adapter.interceptSetStateAck("living.mute", true);
    // The coordination gave `mute` to another transport — the buffered value is discarded, and
    // the buffer does not grow with every later push either.
    adapter.seedOwned(new Set(["volume"]));
    adapter.interceptSetStateAck("living.mute", false);
    adapter.seedOwned(new Set(["volume"]));
    expect(acks).toEqual([]);
  });
});

describe("TransportConnectionAdapter — verifyAlive", () => {
  test("forwards verifyAlive to a controller that has one, and is a no-op for one that has not", async () => {
    const verify = vi.fn(() => Promise.resolve());
    const withProbe = new TransportConnectionAdapter("yxc", "living", () => {});
    withProbe.bind({
      start: () => Promise.resolve(true),
      handleWrite: () => {},
      onDrop: () => {},
      close: () => {},
      verifyAlive: verify,
    });
    await withProbe.verifyAlive();
    expect(verify).toHaveBeenCalledTimes(1);

    // YNCA judges itself through its own keepalive — its controller offers no probe.
    const without = new TransportConnectionAdapter("ynca", "living", () => {});
    without.bind({
      start: () => Promise.resolve(true),
      handleWrite: () => {},
      onDrop: () => {},
      close: () => {},
    });
    await expect(without.verifyAlive()).resolves.toBeUndefined();
  });
});

describe("TransportConnectionAdapter takes over an id with its last value (audit 2026-09-24, C21)", () => {
  // Another transport dropped and a re-coordination hands this one the id: the controller will
  // not repeat an unchanged value, so the tree kept the dropped owner's value until the device changed.
  test("an id newly owned after a re-coordination gets its last seen value at once", async () => {
    const acks: Array<{ id: string; value: unknown }> = [];
    const adapter = new TransportConnectionAdapter("xml", "living", (id, value) => acks.push({ id, value }));
    adapter.bind({
      start: () => Promise.resolve(true),
      handleWrite: () => {},
      onDrop: () => {},
      close: () => {},
    });
    await adapter.connect();
    adapter.seedOwned(new Set(["mute"]));
    adapter.interceptSetStateAck("living.power", true); // not owned yet — another transport's
    expect(acks).toEqual([]);
    adapter.seedOwned(new Set(["mute", "power"]));
    expect(acks).toEqual([{ id: "living.power", value: true }]);
    // An id it already owned is not replayed on a re-arming.
    acks.length = 0;
    adapter.seedOwned(new Set(["mute", "power"]));
    expect(acks).toEqual([]);
  });
});

// MusicCast serves a Zone B as its zone2 (YXC Basic Rev 1.10 §4.2); the tree and YNCA call it Zone B.
// Before, one physical zone stood in two folders on the RX-V481/RX-V4A/RX-V583 class (audit 2026-09-29, C29).
describe("TransportConnectionAdapter — a zone folder named as the tree does", () => {
  test("zone2 ids land under multiroom.zoneB, the folder is named Zone B, writes go back to zone2", async () => {
    const acks: Array<{ id: string; value: unknown }> = [];
    const writes: string[] = [];
    const adapter = new TransportConnectionAdapter("yxc", "living", (id, value) => acks.push({ id, value }));
    adapter.bind({
      start: async () => {
        adapter.aliasZone("zone2", "zoneB");
        await adapter.interceptUpsert("living.multiroom.zone2", {
          id: "multiroom.zone2",
          type: "channel",
          common: { name: "Zone 2" },
        });
        await adapter.interceptUpsert("living.multiroom.zone2.volume", st("multiroom.zone2.volume"));
        await adapter.interceptUpsert("living.multiroom.zone2.subwooferVolume", st("multiroom.zone2.subwooferVolume"));
        adapter.interceptSetStateAck("living.multiroom.zone2.volume", 40);
        return true;
      },
      handleWrite: stateId => {
        writes.push(stateId);
      },
      onDrop: () => {},
      close: () => {},
    });
    await adapter.connect();
    const objects = adapter.buildObjects();
    expect(objects.map(o => o.id)).toEqual([
      "multiroom.zoneB",
      "multiroom.zoneB.volume",
      "multiroom.zoneB.sound.subwooferTrim",
    ]);
    expect((objects[0].common.name as Record<string, string>).en).toBe("Zone B");
    adapter.seedOwned(new Set(["multiroom.zoneB.volume"]));
    expect(acks).toEqual([{ id: "living.multiroom.zoneB.volume", value: 40 }]);
    void adapter.handleWrite("multiroom.zoneB.sound.subwooferTrim", 1);
    void adapter.handleWrite("multiroom.zoneB.volume", 30);
    expect(writes).toEqual(["multiroom.zone2.subwooferVolume", "multiroom.zone2.volume"]);
    expect(adapter.canonicalId("living.multiroom.zone2.mute")).toBe("multiroom.zoneB.mute");
  });
});

describe("TransportConnectionAdapter — what the handle asks of a controller (2026-10-02)", () => {
  test("passes the write outcome, the read completeness and the firmware through", async () => {
    const adapter = new TransportConnectionAdapter("ynca", "living", () => {});
    let complete = false;
    const listeners: Array<() => void> = [];
    const controller: AdaptedController = {
      start: () => Promise.resolve(true),
      handleWrite: () => Promise.resolve("refused" as const),
      onDrop: () => {},
      close: () => {},
      readComplete: () => complete,
      onReadComplete: cb => listeners.push(cb),
      firmware: () => "1.80",
    };
    adapter.bind(controller);
    await expect(adapter.handleWrite("power", true)).resolves.toBe("refused");
    expect(adapter.readComplete()).toBe(false);
    let called = 0;
    adapter.onReadComplete(() => called++);
    complete = true;
    listeners.forEach(listener => listener());
    expect(adapter.readComplete()).toBe(true);
    expect(called).toBe(1);
    expect(adapter.firmware()).toBe("1.80");
  });

  test("a controller that says nothing about a write is unclear; one that cannot tell its read counts as complete", async () => {
    const adapter = new TransportConnectionAdapter("xml", "living", () => {});
    await expect(adapter.handleWrite("power", true)).resolves.toBe("unavailable");
    adapter.bind({ start: () => Promise.resolve(true), handleWrite: () => {}, onDrop: () => {}, close: () => {} });
    await expect(adapter.handleWrite("power", true)).resolves.toBe("unclear");
    expect(adapter.readComplete()).toBe(true);
    expect(adapter.firmware()).toBeUndefined();
  });
});
