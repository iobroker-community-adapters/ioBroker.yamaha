import { TransportConnectionAdapter, type AdaptedController } from "./transport-connection-adapter";
import type { ObjectDef } from "../catalog/types";

function st(id: string): ObjectDef {
  return { id, type: "state", common: { name: id, type: "number", role: "level", read: true, write: true } };
}

describe("TransportConnectionAdapter", () => {
  test("collects the controller's objects canonicalized, seeds only owned, routes writes back", async () => {
    const acks: Array<{ id: string; value: unknown }> = [];
    const writes: Array<{ fullId: string; ack: boolean; value: unknown }> = [];
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
      handleStateChange: (fullId, ack, value) => writes.push({ fullId, ack, value }),
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
    adapter.handleWrite("sound.subwooferTrim", false, 5);
    expect(writes).toContainEqual({ fullId: "living.subwooferVolume", ack: false, value: 5 });
  });

  test("after seedOwned, later pushes are filtered live (only owned reach the adapter's setStateAck)", async () => {
    const acks: Array<{ id: string; value: unknown }> = [];
    const adapter = new TransportConnectionAdapter("yxc", "living", (id, value) => acks.push({ id, value }));
    adapter.bind({
      start: () => Promise.resolve(true),
      handleStateChange: () => {},
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
      handleStateChange: () => {},
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
    adapter.bind({ start, handleStateChange: () => {}, onDrop: () => {}, close: () => {} });

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
