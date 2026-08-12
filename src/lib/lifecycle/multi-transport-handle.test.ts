import { MultiTransportHandle, type TransportConnection } from "./multi-transport-handle";
import type { ObjectDef } from "../catalog/types";
import type { Transport } from "../catalog/owner-policy";

const silentLog = { debug: (): void => {}, info: (): void => {}, warn: (): void => {} };

function state(id: string, name: string, extra: Record<string, unknown> = {}): ObjectDef {
  return { id, type: "state", common: { name, type: "number", role: "level", read: true, write: true, ...extra } };
}

/** A fake transport connection recording what the handle asks of it. */
function fakeConn(
  transport: Transport,
  objects: readonly ObjectDef[],
): TransportConnection & { seeded: string[]; writes: Array<{ id: string; value: unknown }>; closed: boolean } {
  const conn = {
    transport,
    seeded: [] as string[],
    writes: [] as Array<{ id: string; value: unknown }>,
    closed: false,
    buildObjects: (): readonly ObjectDef[] => objects,
    seedOwned: (owned: ReadonlySet<string>): void => {
      conn.seeded.push(...owned);
    },
    handleWrite: (id: string, _ack: boolean, value: unknown): void => {
      conn.writes.push({ id, value });
    },
    onDrop: (): void => {},
    close: (): void => {
      conn.closed = true;
    },
  };
  return conn;
}

function setup(connections: TransportConnection[]): { handle: MultiTransportHandle; objects: string[] } {
  const objects: string[] = [];
  const handle = new MultiTransportHandle("living", connections, {
    upsertObject: async id => {
      objects.push(id);
    },
    log: silentLog,
  });
  return { handle, objects };
}

describe("MultiTransportHandle", () => {
  test("builds one unified tree from all connections and seeds each its owned ids", async () => {
    const ynca = fakeConn("ynca", [state("volume", "Volume dB", { unit: "dB" }), state("power", "Power YNCA")]);
    const yxc = fakeConn("yxc", [state("volume", "Volume raw"), state("power", "Power YXC"), state("dist.role", "Role")]);
    const { handle, objects } = setup([ynca, yxc]);
    await handle.start();
    // one node per capability, under the device id
    expect(objects).toEqual(expect.arrayContaining(["living.volume", "living.power", "living.dist.role"]));
    expect(objects.filter(id => id === "living.volume").length).toBe(1);
    // volume owned by YNCA (dB), power + dist.role by YXC (modern / exclusive)
    expect(ynca.seeded).toContain("volume");
    expect(yxc.seeded).toEqual(expect.arrayContaining(["power", "dist.role"]));
    expect(yxc.seeded).not.toContain("volume");
  });

  test("routes a user write to the owning connection", async () => {
    const ynca = fakeConn("ynca", [state("volume", "Volume dB")]);
    const yxc = fakeConn("yxc", [state("volume", "Volume raw"), state("dist.role", "Role")]);
    const { handle } = setup([ynca, yxc]);
    await handle.start();
    handle.handleStateChange("living.volume", false, -30);
    handle.handleStateChange("living.dist.role", false, "server");
    expect(ynca.writes).toContainEqual({ id: "volume", value: -30 }); // volume → YNCA owner
    expect(yxc.writes).toContainEqual({ id: "dist.role", value: "server" }); // dist.role → YXC owner
    expect(yxc.writes).not.toContainEqual({ id: "volume", value: -30 });
  });

  test("close closes every connection", () => {
    const ynca = fakeConn("ynca", []);
    const yxc = fakeConn("yxc", []);
    const { handle } = setup([ynca, yxc]);
    handle.close();
    expect(ynca.closed).toBe(true);
    expect(yxc.closed).toBe(true);
  });
});
