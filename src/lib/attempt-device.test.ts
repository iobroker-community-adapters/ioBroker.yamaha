import { connectTransports, type ConnectableTransport } from "./attempt-device";
import type { ObjectDef } from "./catalog/types";
import type { Transport } from "./catalog/owner-policy";

const silentLog = { debug: (): void => {}, info: (): void => {}, warn: (): void => {} };

function state(id: string, name: string, extra: Record<string, unknown> = {}): ObjectDef {
  return { id, type: "state", common: { name, type: "number", role: "level", read: true, write: true, ...extra } };
}

/** A fake connectable transport: connect() yields a preset result; records seed + close. */
function fakeConn(
  transport: Transport,
  objects: readonly ObjectDef[],
  connectResult: boolean | (() => Promise<boolean>) = true,
): ConnectableTransport & { seeded: string[]; closed: boolean } {
  const conn = {
    transport,
    seeded: [] as string[],
    closed: false,
    connect: (): Promise<boolean> =>
      typeof connectResult === "function" ? connectResult() : Promise.resolve(connectResult),
    buildObjects: (): readonly ObjectDef[] => objects,
    seedOwned: (owned: ReadonlySet<string>): void => {
      conn.seeded.push(...owned);
    },
    handleWrite: (): void => {},
    onDrop: (): void => {},
    close: (): void => {
      conn.closed = true;
    },
  };
  return conn;
}

function deps(): { objects: string[]; upsertObject: (id: string) => Promise<void>; log: typeof silentLog } {
  const objects: string[] = [];
  return {
    objects,
    upsertObject: (id: string): Promise<void> => {
      objects.push(id);
      return Promise.resolve();
    },
    log: silentLog,
  };
}

describe("connectTransports", () => {
  test("unifies every answering transport into one tree — no capability doubled", async () => {
    const ynca = fakeConn("ynca", [state("volume", "Volume dB", { unit: "dB" }), state("power", "Power")]);
    const yxc = fakeConn("yxc", [state("volume", "Volume raw"), state("power", "Power"), state("dist.role", "Role")]);
    const d = deps();
    const handle = await connectTransports("living", [{ conn: ynca }, { conn: yxc }], d);
    expect(handle).not.toBeNull();
    // one node per capability, under the device id — volume appears exactly once
    expect(d.objects).toEqual(expect.arrayContaining(["living.volume", "living.power", "living.dist.role"]));
    expect(d.objects.filter(id => id === "living.volume").length).toBe(1);
    // volume owned by YNCA (dB, lossless override), dist.role exclusive to YXC
    expect(ynca.seeded).toContain("volume");
    expect(yxc.seeded).toContain("dist.role");
    expect(yxc.seeded).not.toContain("volume");
  });

  test("a transport that does not answer is closed and left out of the tree", async () => {
    const ynca = fakeConn("ynca", [state("power", "Power")]);
    const yxc = fakeConn("yxc", [state("dist.role", "Role")], false);
    const d = deps();
    const handle = await connectTransports("living", [{ conn: ynca }, { conn: yxc }], d);
    expect(handle).not.toBeNull();
    expect(yxc.closed).toBe(true);
    expect(yxc.seeded).toEqual([]); // never seeded — not part of the tree
    expect(d.objects).not.toContain("living.dist.role");
  });

  test("no transport answers → null, every attempt closed", async () => {
    const ynca = fakeConn("ynca", [state("power", "Power")], false);
    const yxc = fakeConn("yxc", [state("dist.role", "Role")], false);
    const handle = await connectTransports("living", [{ conn: ynca }, { conn: yxc }], deps());
    expect(handle).toBeNull();
    expect(ynca.closed).toBe(true);
    expect(yxc.closed).toBe(true);
  });

  test("a connect that throws is swallowed so the other transports still connect", async () => {
    const ynca = fakeConn("ynca", [state("power", "Power")], () => Promise.reject(new Error("socket")));
    const yxc = fakeConn("yxc", [state("dist.role", "Role")], true);
    const d = deps();
    const handle = await connectTransports("living", [{ conn: ynca }, { conn: yxc }], d);
    expect(handle).not.toBeNull();
    expect(ynca.closed).toBe(true);
    expect(d.objects).toContain("living.dist.role"); // yxc still made it into the tree
  });
});
