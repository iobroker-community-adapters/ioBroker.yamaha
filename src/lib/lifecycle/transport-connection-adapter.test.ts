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
      start: async () => true,
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
      start: async () => false,
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
