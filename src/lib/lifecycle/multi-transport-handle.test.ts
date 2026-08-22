import { MultiTransportHandle, type ConnectableTransport, type TransportConnection } from "./multi-transport-handle";
import type { ObjectDef } from "../catalog/types";
import type { Transport } from "../catalog/owner-policy";

const silentLog = { debug: (): void => {}, info: (): void => {}, warn: (): void => {} };

function state(id: string, name: string, extra: Record<string, unknown> = {}): ObjectDef {
  return { id, type: "state", common: { name, type: "number", role: "level", read: true, write: true, ...extra } };
}

/** A fake transport connection recording what the handle asks of it; its drop is triggerable. */
function fakeConn(
  transport: Transport,
  objects: readonly ObjectDef[],
): ConnectableTransport & {
  seeded: string[];
  writes: Array<{ id: string; value: unknown }>;
  closed: boolean;
  drop: (reason?: Error) => void;
} {
  let dropHandler: ((reason?: Error) => void) | undefined;
  const conn = {
    transport,
    seeded: [] as string[],
    writes: [] as Array<{ id: string; value: unknown }>,
    closed: false,
    connect: (): Promise<boolean> => Promise.resolve(true),
    buildObjects: (): readonly ObjectDef[] => objects,
    seedOwned: (owned: ReadonlySet<string>): void => {
      conn.seeded.push(...owned);
    },
    handleWrite: (id: string, _ack: boolean, value: unknown): void => {
      conn.writes.push({ id, value });
    },
    onDrop: (cb: (reason?: Error) => void): void => {
      dropHandler = cb;
    },
    close: (): void => {
      conn.closed = true;
    },
    drop: (reason?: Error): void => {
      dropHandler?.(reason);
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
    const yxc = fakeConn("yxc", [
      state("volume", "Volume raw"),
      state("power", "Power YXC"),
      state("dist.role", "Role"),
    ]);
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

/** Setup with per-transport reconnect wired: manual timers, GROWING backoff, a rebuild factory. */
function reconnectSetup(
  connections: ConnectableTransport[],
  rebuilds: Partial<Record<Transport, () => ConnectableTransport>>,
): {
  handle: MultiTransportHandle;
  objects: string[];
  timers: Array<() => void>;
  delays: number[];
  cancelled: number;
  logs: string[];
  transportsReports: string[][];
  fireTimers: () => Promise<void>;
} {
  const objects: string[] = [];
  const timers: Array<() => void> = [];
  const delays: number[] = [];
  const logs: string[] = [];
  let cancelled = 0;
  const transportsReports: string[][] = [];
  const handle = new MultiTransportHandle("living", connections, {
    upsertObject: async id => {
      objects.push(id);
    },
    log: { ...silentLog, debug: (m: string) => logs.push(m) },
    onTransports: names => transportsReports.push([...names]),
    rebuild: transport => rebuilds[transport]!(),
    schedule: (cb, ms) => {
      timers.push(cb);
      delays.push(ms);
      return timers.length;
    },
    cancel: () => {
      cancelled++;
    },
    // A real growing backoff, so "the backoff is kept across attempts" is visible.
    backoffFactory: () => {
      let n = 0;
      return { nextDelay: () => 1000 * 2 ** n++, reset: () => (n = 0) };
    },
  });
  const fireTimers = async (): Promise<void> => {
    const due = timers.splice(0);
    for (const cb of due) {
      cb();
    }
    // let the async attemptTransport chains settle
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  return {
    handle,
    objects,
    timers,
    delays,
    get cancelled(): number {
      return cancelled;
    },
    logs,
    transportsReports,
    fireTimers,
  };
}

describe("MultiTransportHandle per-transport reconnect", () => {
  test("a single transport's drop keeps the device alive and reconnects just that transport", async () => {
    const ynca = fakeConn("ynca", [state("volume", "Volume dB", { unit: "dB" })]);
    const yxc = fakeConn("yxc", [state("volume", "Volume raw"), state("dist.role", "Role")]);
    const freshYnca = fakeConn("ynca", [state("volume", "Volume dB", { unit: "dB" })]);
    const supervisorDrop = vi.fn();
    const { handle, transportsReports, fireTimers } = reconnectSetup([ynca, yxc], { ynca: () => freshYnca });
    await handle.start();
    handle.onDrop(supervisorDrop);
    expect(transportsReports.at(-1)).toEqual(["ynca", "yxc"]);

    ynca.drop(new Error("socket reset"));
    // the dropped transport is closed, the device stays up, the supervisor is NOT told
    expect(ynca.closed).toBe(true);
    expect(supervisorDrop).not.toHaveBeenCalled();
    expect(transportsReports.at(-1)).toEqual(["yxc"]);

    await fireTimers();
    // the fresh YNCA is live again and owns volume again (re-coordinated)
    expect(transportsReports.at(-1)).toEqual(["yxc", "ynca"]);
    expect(freshYnca.seeded).toContain("volume");
    handle.handleStateChange("living.volume", false, -30);
    expect(freshYnca.writes).toContainEqual({ id: "volume", value: -30 });
  });

  test("while the owner is offline its write is dropped, not sent to the dead connection", async () => {
    const ynca = fakeConn("ynca", [state("volume", "Volume dB", { unit: "dB" })]);
    const yxc = fakeConn("yxc", [state("volume", "Volume raw"), state("dist.role", "Role")]);
    const { handle } = reconnectSetup([ynca, yxc], { ynca: () => fakeConn("ynca", []) });
    await handle.start();
    ynca.drop();
    handle.handleStateChange("living.volume", false, -30);
    expect(ynca.writes).toEqual([]);
    expect(yxc.writes).toEqual([]); // not re-routed either — ownership stands
  });

  test("a failed rebuild keeps the retry loop going", async () => {
    const ynca = fakeConn("ynca", [state("power", "Power")]);
    const yxc = fakeConn("yxc", [state("dist.role", "Role")]);
    const deadYnca = fakeConn("ynca", []);
    deadYnca.connect = (): Promise<boolean> => Promise.resolve(false);
    const { handle, timers, fireTimers } = reconnectSetup([ynca, yxc], { ynca: () => deadYnca });
    await handle.start();
    ynca.drop();
    expect(timers).toHaveLength(1);
    await fireTimers();
    // the failed attempt closed the fresh conn and scheduled the next try
    expect(deadYnca.closed).toBe(true);
    expect(timers).toHaveLength(1);
  });

  test("when the LAST live transport drops, the supervisor's drop fires once", async () => {
    const ynca = fakeConn("ynca", [state("power", "Power")]);
    const yxc = fakeConn("yxc", [state("dist.role", "Role")]);
    const supervisorDrop = vi.fn();
    const { handle } = reconnectSetup([ynca, yxc], {});
    await handle.start();
    handle.onDrop(supervisorDrop);
    ynca.drop();
    expect(supervisorDrop).not.toHaveBeenCalled();
    yxc.drop(new Error("gone"));
    expect(supervisorDrop).toHaveBeenCalledTimes(1);
    yxc.drop();
    expect(supervisorDrop).toHaveBeenCalledTimes(1);
  });

  test("an all-down before the supervisor registers is latched and delivered on registration", async () => {
    const ynca = fakeConn("ynca", [state("power", "Power")]);
    const { handle } = reconnectSetup([ynca], {});
    await handle.start();
    ynca.drop(new Error("early"));
    const supervisorDrop = vi.fn();
    handle.onDrop(supervisorDrop);
    expect(supervisorDrop).toHaveBeenCalledTimes(1);
  });

  test("close stops a pending transport retry from reconnecting", async () => {
    const ynca = fakeConn("ynca", [state("power", "Power")]);
    const yxc = fakeConn("yxc", [state("dist.role", "Role")]);
    const fresh = fakeConn("ynca", []);
    const { handle, fireTimers, transportsReports } = reconnectSetup([ynca, yxc], { ynca: () => fresh });
    await handle.start();
    ynca.drop();
    handle.close();
    const before = transportsReports.length;
    await fireTimers();
    expect(transportsReports.length).toBe(before); // no live-set change after close
    expect(yxc.closed).toBe(true);
  });
});

describe("MultiTransportHandle teardown guards", () => {
  test("a drop from a connection that is no longer live removes nothing", async () => {
    const ynca = fakeConn("ynca", [state("power", "Power")]);
    const yxc = fakeConn("yxc", [state("dist.role", "Role")]);
    const supervisorDrop = vi.fn();
    const { handle, transportsReports } = reconnectSetup([ynca, yxc], {});
    await handle.start();
    handle.onDrop(supervisorDrop);

    ynca.drop();
    const after = transportsReports.at(-1);
    // A transport can report its drop twice (the socket event AND the keepalive).
    // Without the "is it still in the set" check the second report evicts whichever
    // connection happens to sit last — a live one.
    ynca.drop();
    expect(transportsReports.at(-1)).toEqual(after);
    expect(yxc.closed).toBe(false);
    expect(supervisorDrop).not.toHaveBeenCalled();
  });

  test("a transport that connects after close is closed again, not taken into the set", async () => {
    const ynca = fakeConn("ynca", [state("power", "Power")]);
    const yxc = fakeConn("yxc", [state("dist.role", "Role")]);
    const fresh = fakeConn("ynca", [state("power", "Power")]);
    let release: (v: boolean) => void = () => undefined;
    fresh.connect = (): Promise<boolean> => new Promise(resolve => (release = resolve));
    const { handle, fireTimers, transportsReports } = reconnectSetup([ynca, yxc], { ynca: () => fresh });
    await handle.start();
    ynca.drop();
    await fireTimers(); // starts the attempt; it is still awaiting connect()

    handle.close();
    const before = transportsReports.length;
    release(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    // The connect resolves AFTER onUnload. Taking the socket into the live set then
    // leaves it open for the rest of the process's life.
    expect(fresh.closed).toBe(true);
    expect(transportsReports.length).toBe(before);
  });

  test("a failed reconnect after close schedules no further attempt", async () => {
    const ynca = fakeConn("ynca", [state("power", "Power")]);
    const yxc = fakeConn("yxc", [state("dist.role", "Role")]);
    const fresh = fakeConn("ynca", []);
    let release: (v: boolean) => void = () => undefined;
    fresh.connect = (): Promise<boolean> => new Promise(resolve => (release = resolve));
    const { handle, timers, fireTimers } = reconnectSetup([ynca, yxc], { ynca: () => fresh });
    await handle.start();
    ynca.drop();
    await fireTimers();

    handle.close();
    release(false);
    await new Promise(resolve => setTimeout(resolve, 0));
    // A retry loop that survives the unload keeps the instance from ever stopping.
    expect(timers).toHaveLength(0);
  });
});

describe("MultiTransportHandle per-transport backoff", () => {
  test("keeps one transport's backoff growing across its failed attempts", async () => {
    const ynca = fakeConn("ynca", [state("power", "Power")]);
    const yxc = fakeConn("yxc", [state("dist.role", "Role")]);
    const dead = (): ConnectableTransport => {
      const c = fakeConn("ynca", []);
      c.connect = (): Promise<boolean> => Promise.resolve(false);
      return c;
    };
    const h = reconnectSetup([ynca, yxc], { ynca: dead });
    await h.handle.start();
    ynca.drop();
    expect(h.delays).toEqual([1000]);

    await h.fireTimers();
    await h.fireTimers();
    // A fresh backoff per attempt means a permanently dead transport is retried
    // every second for as long as the instance runs.
    expect(h.delays).toEqual([1000, 2000, 4000]);
  });

  test("names the cause when a reconnect attempt throws", async () => {
    const ynca = fakeConn("ynca", [state("power", "Power")]);
    const yxc = fakeConn("yxc", [state("dist.role", "Role")]);
    const throwing = (): ConnectableTransport => {
      const c = fakeConn("ynca", []);
      c.connect = (): Promise<boolean> => Promise.reject(new Error("EHOSTUNREACH"));
      return c;
    };
    const h = reconnectSetup([ynca, yxc], { ynca: throwing });
    await h.handle.start();
    ynca.drop();
    await h.fireTimers();
    // "reconnect attempt failed" without the reason is a log line nobody can act on.
    expect(h.logs.some(l => l.includes("reconnect attempt failed") && l.includes("EHOSTUNREACH"))).toBe(true);
  });

  test("cancels every pending transport retry when the device is gone", async () => {
    const ynca = fakeConn("ynca", [state("power", "Power")]);
    const yxc = fakeConn("yxc", [state("dist.role", "Role")]);
    const h = reconnectSetup([ynca, yxc], { ynca: () => fakeConn("ynca", []) });
    await h.handle.start();
    ynca.drop(); // one retry pending
    yxc.drop(); // last transport gone → the supervisor reconnects the whole set
    // A retry timer that survives the device-gone report reconnects a transport
    // into a handle the supervisor has already replaced.
    expect(h.cancelled).toBeGreaterThanOrEqual(1);
  });
});
