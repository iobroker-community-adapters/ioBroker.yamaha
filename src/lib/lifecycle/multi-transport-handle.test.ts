import {
  MultiTransportHandle,
  type ConnectableTransport,
  type TransportConnection,
  type WriteOutcome,
} from "./multi-transport-handle";
import type { ObjectDef } from "../catalog/types";
import type { Transport } from "../catalog/owner-policy";
import { emptyLearnedTree, type LearnedTree } from "./learned-tree";
import { TransportConnectionAdapter } from "./transport-connection-adapter";
import { catalogToObjects } from "../catalog/build-objects";
import { INFO_ENTRIES } from "../catalog/info-objects";

const silentLog = { debug: (): void => {}, info: (): void => {}, warn: (): void => {} };

function state(id: string, name: string, extra: Record<string, unknown> = {}): ObjectDef {
  return { id, type: "state", common: { name, type: "number", role: "level", read: true, write: true, ...extra } };
}

/**
 * A fake transport connection recording what the handle asks of it; its drop is triggerable.
 *
 * @param transport Which protocol the fake stands in for
 * @param objects Object definitions the fake declares
 */
function fakeConn(
  transport: Transport,
  objects: readonly ObjectDef[],
): ConnectableTransport & {
  seeded: string[];
  writes: Array<{ id: string; value: unknown }>;
  closed: boolean;
  outcome: WriteOutcome;
  drop: (reason?: Error) => void;
  changeShape: () => void;
} {
  let dropHandler: ((reason?: Error) => void) | undefined;
  let shapeHandler: (() => void) | undefined;
  const conn = {
    transport,
    seeded: [] as string[],
    writes: [] as Array<{ id: string; value: unknown }>,
    closed: false,
    outcome: "sent" as WriteOutcome,
    connect: (): Promise<boolean> => Promise.resolve(true),
    buildObjects: (): readonly ObjectDef[] => objects,
    seedOwned: (owned: ReadonlySet<string>): void => {
      conn.seeded.push(...owned);
    },
    handleWrite: (id: string, value: unknown): Promise<WriteOutcome> => {
      conn.writes.push({ id, value });
      return Promise.resolve(conn.outcome);
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
    onShapeChanged: (cb: () => void): void => {
      shapeHandler = cb;
    },
    changeShape: (): void => {
      shapeHandler?.();
    },
  };
  return conn;
}

function setup(connections: TransportConnection[]): { handle: MultiTransportHandle; objects: string[] } {
  const objects: string[] = [];
  const handle = new MultiTransportHandle("living", connections, {
    upsertObject: id => {
      objects.push(id);
      return Promise.resolve();
    },
    log: silentLog,
  });
  return { handle, objects };
}

describe("MultiTransportHandle start with a latched drop (audit 2026-09-24, A1)", () => {
  // A drop the YNCA client latched before start is delivered while its handler is armed; it
  // spliced `live` under the loop, and the NEXT transport never got a drop handler — a device
  // without power stayed connected for good.
  test("a drop latched before start() leaves every other transport armed", async () => {
    const ynca = fakeConn("ynca", [state("power", "Power")]);
    const latched = ynca.onDrop;
    ynca.onDrop = (cb: (reason?: Error) => void): void => {
      latched(cb);
      cb(new Error("socket closed before start"));
    };
    const yxc = fakeConn("yxc", [state("volume", "Volume")]);
    const xml = fakeConn("xml", [state("mute", "Mute")]);
    const reports: string[][] = [];
    const handle = new MultiTransportHandle("living", [ynca, yxc, xml], {
      upsertObject: () => Promise.resolve(),
      log: silentLog,
      onTransports: names => reports.push(names),
    });
    const running = await handle.start();
    expect(running).toEqual(["yxc", "xml"]);
    yxc.drop(new Error("3 polls failed"));
    expect(yxc.closed).toBe(true);
    expect(reports.at(-1)).toEqual(["xml"]);
    let gone = false;
    handle.onDrop(() => {
      gone = true;
    });
    xml.drop();
    expect(gone).toBe(true);
  });
});

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
    // volume owned by MusicCast (it alone reports the displayed scale), power by modernity, dist.role exclusive to YXC
    expect(yxc.seeded).toContain("volume");
    expect(yxc.seeded).toEqual(expect.arrayContaining(["power", "dist.role"]));
    expect(ynca.seeded).not.toContain("volume");
  });

  test("routes a user write to the owning connection", async () => {
    const ynca = fakeConn("ynca", [state("volume", "Volume dB")]);
    const yxc = fakeConn("yxc", [state("volume", "Volume raw"), state("dist.role", "Role")]);
    const { handle } = setup([ynca, yxc]);
    await handle.start();
    handle.handleStateChange("living.volume", false, -30);
    handle.handleStateChange("living.dist.role", false, "server");
    expect(yxc.writes).toContainEqual({ id: "volume", value: -30 }); // volume → MusicCast owner
    expect(yxc.writes).toContainEqual({ id: "dist.role", value: "server" }); // dist.role → YXC owner
    expect(ynca.writes).not.toContainEqual({ id: "volume", value: -30 });
  });

  // The one place that filters echoes and foreign ids: each controller re-checked both, a path
  // production never took (audit 2026-09-29, A32). "office." is as long as "living." — a slice by
  // length alone would have read it as this device's id.
  test("an acked echo and a write meant for another device reach no transport", async () => {
    const ynca = fakeConn("ynca", [state("power", "Power")]);
    const { handle } = setup([ynca]);
    await handle.start();
    handle.handleStateChange("living.power", true, true);
    handle.handleStateChange("office.power", false, true);
    expect(ynca.writes).toEqual([]);
    handle.handleStateChange("living.power", false, true);
    expect(ynca.writes).toEqual([{ id: "power", value: true }]);
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

/**
 * Setup with per-transport reconnect wired: manual timers, GROWING backoff, a rebuild factory.
 *
 * @param connections Initial connections handed to the handle
 * @param rebuilds Per-transport factories used after a drop
 */
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
    upsertObject: id => {
      objects.push(id);
      return Promise.resolve();
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
  // `sound.bass` is the YNCA-owned capability here (documented-decibel override), so the drop and
  // the rebuild are visible in ownership. `volume` would not show it: MusicCast owns that one
  // whenever it answers, so nothing would change hands.
  test("a single transport's drop keeps the device alive and reconnects just that transport", async () => {
    const ynca = fakeConn("ynca", [state("sound.bass", "Bass dB", { unit: "dB" })]);
    const yxc = fakeConn("yxc", [state("sound.bass", "Bass raw"), state("dist.role", "Role")]);
    const freshYnca = fakeConn("ynca", [state("sound.bass", "Bass dB", { unit: "dB" })]);
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
    // the fresh YNCA is live again and owns the decibel capability again (re-coordinated)
    expect(transportsReports.at(-1)).toEqual(["yxc", "ynca"]);
    expect(freshYnca.seeded).toContain("sound.bass");
    handle.handleStateChange("living.sound.bass", false, -3);
    expect(freshYnca.writes).toContainEqual({ id: "sound.bass", value: -3 });
  });

  // krobi 2026-10-02: "always try the most modern one; if the command does not work with it, then the next one" —
  // the owner stays; only the write takes the next transport that carries it unchanged.
  test("while the owner is offline, a write goes through the next transport that carries it unchanged", async () => {
    const ynca = fakeConn("ynca", [state("power", "Power", { type: "boolean", role: "switch.power" })]);
    const xml = fakeConn("xml", [state("power", "Power", { type: "boolean", role: "switch.power" })]);
    const freshYnca = fakeConn("ynca", [state("power", "Power", { type: "boolean", role: "switch.power" })]);
    const { handle, fireTimers } = reconnectSetup([ynca, xml], { ynca: () => freshYnca });
    await handle.start();
    handle.handleStateChange("living.power", false, true);
    expect(ynca.writes).toContainEqual({ id: "power", value: true });
    ynca.drop(new Error("socket reset"));
    await new Promise(resolve => setTimeout(resolve, 0));
    handle.handleStateChange("living.power", false, false);
    expect(xml.writes).toContainEqual({ id: "power", value: false });
    await fireTimers();
    handle.handleStateChange("living.power", false, true);
    expect(freshYnca.writes).toContainEqual({ id: "power", value: true });
  });

  // A shared definition map (per device, held by the adapter) survives a new handle: a device that
  // came back as a whole rewrote its entire tree unchanged (A14).
  test("a second handle with the device's written definitions writes nothing unchanged", async () => {
    const written = new Map<string, string>();
    const upserts: string[] = [];
    const deps = {
      upsertObject: (id: string): Promise<void> => {
        upserts.push(id);
        return Promise.resolve();
      },
      log: silentLog,
      writtenObjects: written,
    };
    await new MultiTransportHandle("living", [fakeConn("ynca", [state("power", "Power")])], deps).start();
    expect(upserts).toEqual(["living.power"]);
    upserts.length = 0;
    await new MultiTransportHandle("living", [fakeConn("ynca", [state("power", "Power")])], deps).start();
    expect(upserts).toEqual([]);
  });

  test("while the owner is offline its write is dropped, not sent to the dead connection", async () => {
    const ynca = fakeConn("ynca", [state("sound.bass", "Bass dB", { unit: "dB" })]);
    const yxc = fakeConn("yxc", [state("sound.bass", "Bass raw"), state("dist.role", "Role")]);
    const { handle } = reconnectSetup([ynca, yxc], { ynca: () => fakeConn("ynca", []) });
    await handle.start();
    ynca.drop();
    handle.handleStateChange("living.sound.bass", false, -3);
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

  // The retry runs from a timer callback as `void this.attemptTransport(...)`, so nothing holds
  // its promise. Everything inside already sat in a try — except the factory call itself, which
  // is the one statement that can throw before it: a rejection there would reach no handler, and
  // js-controller stops the instance for an unhandled rejection.
  test("a THROWING rebuild factory neither escapes nor ends the retry loop", async () => {
    const ynca = fakeConn("ynca", [state("power", "Power")]);
    const yxc = fakeConn("yxc", [state("dist.role", "Role")]);
    const { handle, timers, fireTimers, logs } = reconnectSetup([ynca, yxc], {
      ynca: () => {
        throw new Error("no factory for this transport");
      },
    });
    await handle.start();
    ynca.drop();
    expect(timers).toHaveLength(1);
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      await fireTimers();
      await Promise.resolve();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    expect(rejections).toEqual([]);
    expect(logs.some(line => line.includes("could not rebuild the transport"))).toBe(true);
    // And the loop survives it: a transport that cannot be rebuilt right now gets another turn.
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

  test("when one transport drops, the others are asked to verify at once — a dead device is judged in seconds, not at the next poll", async () => {
    // Power cut: YNCA notices within 90 s, but MusicCast polls every five minutes and needs
    // three misses — the device stayed "connected" for a quarter of an hour on one transport
    // nobody asked. The first drop is the question to the others.
    const ynca = fakeConn("ynca", [state("power", "Power")]);
    const yxc = fakeConn("yxc", [state("dist.role", "Role")]);
    const xml = fakeConn("xml", [state("sleep", "Sleep")]);
    const yxcVerify = vi.fn(() => Promise.resolve());
    const xmlVerify = vi.fn(() => Promise.resolve());
    Object.assign(yxc, { verifyAlive: yxcVerify });
    Object.assign(xml, { verifyAlive: xmlVerify });
    const { handle } = reconnectSetup([ynca, yxc, xml], {});
    await handle.start();
    ynca.drop(new Error("keepalive unanswered"));
    expect(yxcVerify).toHaveBeenCalledTimes(1);
    expect(xmlVerify).toHaveBeenCalledTimes(1);
  });

  test("a transport without verifyAlive is left to its own drop detection, and a failing verify does not end the handle", async () => {
    const ynca = fakeConn("ynca", [state("power", "Power")]);
    const yxc = fakeConn("yxc", [state("dist.role", "Role")]);
    Object.assign(yxc, { verifyAlive: () => Promise.reject(new Error("probe exploded")) });
    const { handle, logs } = reconnectSetup([ynca, yxc], {});
    await handle.start();
    const supervisorDrop = vi.fn();
    handle.onDrop(supervisorDrop);
    ynca.drop();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(supervisorDrop).not.toHaveBeenCalled();
    expect(logs.some(line => line.includes("probe exploded"))).toBe(true);
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

describe("MultiTransportHandle — a read-in receiver keeps its tree (krobi 2026-10-02)", () => {
  const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

  // 2026-10-01 23:49: the RX-V6A lost its power. YNCA dropped first, MusicCast five seconds later, and for 18 ms
  // XML was the only transport left — it took the datapoints over and wrote its definitions without a list.
  test("a power cut — YNCA, then MusicCast, then XML drop — writes nothing and moves no datapoint", async () => {
    const program = (states?: Record<string, string>): ObjectDef =>
      state("soundProgram", "Program", { type: "string", role: "state", ...(states ? { states } : {}) });
    const ynca = fakeConn("ynca", [program({ Straight: "Straight", Jazz: "Jazz" })]);
    const yxc = fakeConn("yxc", [state("dist.role", "Role")]);
    const xml = fakeConn("xml", [program()]);
    const timers: Array<() => void> = [];
    const objects: string[] = [];
    const handle = new MultiTransportHandle("living", [ynca, yxc, xml], {
      upsertObject: id => {
        objects.push(id);
        return Promise.resolve();
      },
      log: silentLog,
      rebuild: transport => fakeConn(transport, []),
      schedule: cb => {
        timers.push(cb);
        return timers.length;
      },
      cancel: () => {},
      backoffFactory: () => ({ nextDelay: () => 1000, reset: () => {} }),
    });
    await handle.start();
    objects.length = 0;
    xml.seeded.length = 0;
    ynca.drop(new Error("socket closed"));
    await flush();
    yxc.drop(new Error("3 polls failed"));
    await flush();
    expect(objects).toEqual([]);
    expect(xml.seeded).toEqual([]);
    xml.drop(new Error("3 polls failed"));
    await flush();
    expect(objects).toEqual([]);
  });

  test("a transport that comes back with the same objects writes nothing", async () => {
    const ynca = fakeConn("ynca", [state("sound.bass", "Bass dB", { unit: "dB" })]);
    const yxc = fakeConn("yxc", [state("dist.role", "Role")]);
    const fresh = fakeConn("ynca", [state("sound.bass", "Bass dB", { unit: "dB" })]);
    const { handle, objects, fireTimers } = reconnectSetup([ynca, yxc], { ynca: () => fresh });
    await handle.start();
    objects.length = 0;
    ynca.drop(new Error("socket reset"));
    await fireTimers();
    expect(objects).toEqual([]);
    expect(fresh.seeded).toContain("sound.bass");
  });

  test("what a transport learned later is added — a new datapoint written, nothing else touched", async () => {
    const yncaObjects = [state("volume", "Volume dB", { unit: "dB" })];
    const ynca = fakeConn("ynca", yncaObjects);
    const { handle, objects } = setup([ynca]);
    await handle.start();
    objects.length = 0;
    yncaObjects.push(state("mute", "Mute"));
    ynca.changeShape();
    await flush();
    expect(objects).toEqual(["living.mute"]);
  });
});

/**
 * A handle with a learned tree, an adapter version and the read-in completion recorded.
 *
 * @param connections the transports that answered
 * @param options what the device is known for
 * @param options.tree the learned tree to start from
 * @param options.version the running adapter version
 * @param options.missing the known transports that did not answer
 * @param options.existing the tree as it stands (canonical id → object)
 * @param options.rebuilds per-transport factories for a reconnect
 */
function learnSetup(
  connections: ConnectableTransport[],
  options: {
    tree?: LearnedTree;
    version?: string;
    missing?: Transport[];
    existing?: Record<string, { type: string; common: Partial<ObjectDef["common"]> }>;
    rebuilds?: Partial<Record<Transport, () => ConnectableTransport>>;
  } = {},
): {
  handle: MultiTransportHandle;
  writes: Array<{ id: string; def: ObjectDef; settle: boolean }>;
  tree: () => LearnedTree;
  settled: Array<ReadonlySet<string>>;
  info: string[];
  debug: string[];
  timers: Array<() => void>;
  fireTimers: () => Promise<void>;
} {
  let tree = options.tree ?? emptyLearnedTree();
  const writes: Array<{ id: string; def: ObjectDef; settle: boolean }> = [];
  const settled: Array<ReadonlySet<string>> = [];
  const info: string[] = [];
  const debug: string[] = [];
  const timers: Array<() => void> = [];
  const handle = new MultiTransportHandle("living", connections, {
    upsertObject: (id, def, settle) => {
      writes.push({ id, def, settle: settle === true });
      return Promise.resolve();
    },
    log: { ...silentLog, info: (m: string) => info.push(m), debug: (m: string) => debug.push(m) },
    tree: { get: () => tree, set: next => (tree = next) },
    adapterVersion: options.version,
    missing: options.missing,
    existing: id => options.existing?.[id],
    settleTree: built => {
      settled.push(built);
      return Promise.resolve();
    },
    rebuild: transport => options.rebuilds![transport]!(),
    schedule: cb => {
      timers.push(cb);
      return timers.length;
    },
    cancel: () => {},
    backoffFactory: () => ({ nextDelay: () => 1000, reset: () => {} }),
  });
  const fireTimers = async (): Promise<void> => {
    for (const cb of timers.splice(0)) {
      cb();
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  return { handle, writes, tree: () => tree, settled, info, debug, timers, fireTimers };
}

describe("MultiTransportHandle — who serves a datapoint is learned once and kept", () => {
  // The RX-V6A shape of `sleep`: a text dropdown over YNCA, a minute number over MusicCast.
  const yncaSleep = state("sleep", "Sleep", { type: "string", role: "state", states: { Off: "Off", "30 min": "30" } });
  const yxcSleep = state("sleep", "Sleep", { type: "number", role: "level.timer.sleep", unit: "min" });

  test("a start with a known transport missing keeps the learned owner — no hold, no form change, ever", async () => {
    const tree: LearnedTree = { shared: { sleep: ["ynca", "yxc"] }, transports: ["ynca", "yxc"], firmware: {} };
    const yxc = fakeConn("yxc", [yxcSleep, state("volume", "Volume")]);
    const fresh = fakeConn("ynca", [yncaSleep]);
    const s = learnSetup([yxc], { tree, version: "3.2.0", missing: ["ynca"], rebuilds: { ynca: () => fresh } });
    await s.handle.start();
    // Only the reconnect is scheduled — there is no hold any more that could run out.
    expect(s.timers).toHaveLength(1);
    expect(s.writes.map(w => w.id)).not.toContain("living.sleep");
    expect(yxc.seeded).not.toContain("sleep");
    await s.fireTimers();
    expect(fresh.seeded).toContain("sleep");
    // Back, the owner hands in its own definition — never MusicCast's number.
    expect(s.writes.filter(w => w.id === "living.sleep").every(w => w.def.common.type === "string")).toBe(true);
    s.handle.handleStateChange("living.sleep", false, "30 min");
    expect(fresh.writes).toContainEqual({ id: "sleep", value: "30 min" });
  });

  test("a more modern transport learned later with another form stays a fallback — the owner keeps its form", async () => {
    const yncaObjects = [yncaSleep];
    const ynca = fakeConn("ynca", yncaObjects);
    const s = learnSetup([ynca], {
      tree: { shared: {}, transports: ["ynca"], firmware: {} },
      existing: { sleep: { type: "state", common: yncaSleep.common } },
      rebuilds: { yxc: () => fakeConn("yxc", [yxcSleep]) },
    });
    await s.handle.start();
    // MusicCast arrives (it was not there at the read-in) and builds sleep as a number.
    const yxc = fakeConn("yxc", [yxcSleep]);
    (s.handle as unknown as { live: TransportConnection[] }).live.push(yxc);
    yncaObjects.splice(0);
    yncaObjects.push(yncaSleep);
    ynca.changeShape();
    await new Promise(resolve => setImmediate(resolve));
    s.handle.handleStateChange("living.sleep", false, "Off");
    expect(ynca.writes).toContainEqual({ id: "sleep", value: "Off" });
    expect(yxc.writes).toEqual([]);
    expect(s.writes.filter(w => w.id === "living.sleep").every(w => w.def.common.type === "string")).toBe(true);
  });

  test("a refused write goes to the next transport that carries it; an incompatible one is skipped", async () => {
    const power = state("power", "Power", { type: "boolean", role: "switch.power" });
    const ynca = fakeConn("ynca", [power, state("sound.bass", "Bass dB", { unit: "dB" })]);
    const xml = fakeConn("xml", [power]);
    const yxc = fakeConn("yxc", [state("sound.bass", "Bass raw")]);
    const s = learnSetup([ynca, xml, yxc]);
    await s.handle.start();
    ynca.outcome = "refused";
    s.handle.handleStateChange("living.power", false, true);
    await new Promise(resolve => setImmediate(resolve));
    expect(xml.writes).toContainEqual({ id: "power", value: true });
    s.handle.handleStateChange("living.sound.bass", false, -3);
    await new Promise(resolve => setImmediate(resolve));
    expect(yxc.writes).toEqual([]);
  });

  test("no second send after an unclear answer, and never for a key that cannot be read", async () => {
    const power = state("power", "Power", { type: "boolean", role: "switch.power" });
    const key = state("remote.cursor", "Cursor", { type: "string", role: "button", read: false });
    const ynca = fakeConn("ynca", [power, key]);
    const xml = fakeConn("xml", [power, key]);
    const s = learnSetup([ynca, xml]);
    await s.handle.start();
    ynca.outcome = "unclear";
    s.handle.handleStateChange("living.power", false, true);
    await new Promise(resolve => setImmediate(resolve));
    expect(xml.writes).toEqual([]);
    ynca.outcome = "refused";
    s.handle.handleStateChange("living.remote.cursor", false, "Up");
    await new Promise(resolve => setImmediate(resolve));
    expect(xml.writes).toEqual([]);
  });

  test("a step key that cannot be read is never pressed a second time over another protocol", async () => {
    // remote.* stays with its owner for another reason (ownerOnlyWrite) — this key has only `read: false` to stop it.
    const step = state("tuner.presetUp", "Preset up", { type: "boolean", role: "button", read: false });
    const ynca = fakeConn("ynca", [step]);
    const xml = fakeConn("xml", [step]);
    const s = learnSetup([ynca, xml]);
    await s.handle.start();
    ynca.outcome = "refused";
    s.handle.handleStateChange("living.tuner.presetUp", false, true);
    await new Promise(resolve => setImmediate(resolve));
    expect(ynca.writes).toEqual([{ id: "tuner.presetUp", value: true }]);
    expect(xml.writes).toEqual([]);
  });

  // Forum 85413 (bilberry): in standby YNCA cannot prove its menus, XML serves them. Once YNCA proves them it
  // takes them over — one way, learned, and a drop, a return or a restart in standby changes nothing again.
  test("the YNCA menu proof takes the menus over once and for good", async () => {
    const browse = (unproven: boolean): ObjectDef => ({
      ...state("player.browse.source", "Source", { type: "string" }),
      ...(unproven ? { unproven: true } : {}),
    });
    const yncaObjects = [browse(true)];
    const ynca = fakeConn("ynca", yncaObjects);
    const xml = fakeConn("xml", [browse(false)]);
    const s = learnSetup([ynca, xml], { rebuilds: { xml: () => fakeConn("xml", [browse(false)]) } });
    await s.handle.start();
    expect(s.tree().shared["player.browse.source"]).toBeUndefined();
    yncaObjects[0] = browse(false);
    ynca.changeShape();
    await new Promise(resolve => setImmediate(resolve));
    expect(s.tree().shared["player.browse.source"]?.[0]).toBe("ynca");
    xml.drop();
    await s.fireTimers();
    s.handle.handleStateChange("living.player.browse.source", false, "server");
    expect(ynca.writes).toContainEqual({ id: "player.browse.source", value: "server" });
    // A restart in standby: YNCA claims without proof again, the learned owner stands — in the tree AND in the
    // routing of this session.
    const standbyYnca = fakeConn("ynca", [browse(true)]);
    const awakeXml = fakeConn("xml", [browse(false)]);
    const again = learnSetup([standbyYnca, awakeXml], { tree: s.tree() });
    await again.handle.start();
    expect(again.tree().shared["player.browse.source"]?.[0]).toBe("ynca");
    again.handle.handleStateChange("living.player.browse.source", false, "netRadio");
    expect(standbyYnca.writes).toContainEqual({ id: "player.browse.source", value: "netRadio" });
    expect(awakeXml.writes).toEqual([]);
    expect(standbyYnca.seeded).toContain("player.browse.source");
  });
});

describe("MultiTransportHandle — learned owners and the write fallback in detail", () => {
  const power = state("power", "Power", { type: "boolean", role: "switch.power" });
  const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

  test("a transport that ranks before a learned owner and proves the datapoint takes it over — one way", async () => {
    const browse = state("player.browse.source", "Source", { type: "string" });
    const ynca = fakeConn("ynca", [browse]);
    const xml = fakeConn("xml", [browse]);
    const s = learnSetup([ynca, xml], {
      tree: { shared: { "player.browse.source": ["xml", "ynca"] }, transports: ["ynca", "xml"], firmware: {} },
    });
    await s.handle.start();
    s.handle.handleStateChange("living.player.browse.source", false, "server");
    expect(ynca.writes).toContainEqual({ id: "player.browse.source", value: "server" });
    expect(xml.writes).toEqual([]);
    expect(s.tree().shared["player.browse.source"]).toEqual(["ynca", "xml"]);
  });

  test("a datapoint already in the tree is owned by the transport that keeps its form, not by the ranking", async () => {
    // sleep ranks YNCA first; the tree holds MusicCast's number form from an earlier version.
    const yncaSleep = state("sleep", "Sleep", { type: "string", role: "state", states: { Off: "Off" } });
    const yxcSleep = state("sleep", "Sleep", { type: "number", role: "level.timer.sleep", unit: "min" });
    const ynca = fakeConn("ynca", [yncaSleep]);
    const yxc = fakeConn("yxc", [yxcSleep]);
    const s = learnSetup([ynca, yxc], { existing: { sleep: { type: "state", common: yxcSleep.common } } });
    await s.handle.start();
    s.handle.handleStateChange("living.sleep", false, 30);
    expect(yxc.writes).toContainEqual({ id: "sleep", value: 30 });
    expect(ynca.writes).toEqual([]);
  });

  test("the fallback skips a transport that is offline and takes the next one that is live", async () => {
    // power ranks MusicCast first, then YNCA, then XML.
    const yxc = fakeConn("yxc", [power]);
    const ynca = fakeConn("ynca", [power]);
    const xml = fakeConn("xml", [power]);
    const s = learnSetup([yxc, ynca, xml]);
    await s.handle.start();
    yxc.drop();
    ynca.drop();
    s.handle.handleStateChange("living.power", false, true);
    await flush();
    expect(xml.writes).toContainEqual({ id: "power", value: true });
  });

  test("a write the owner could not send takes the fallback too, and the line says why", async () => {
    const ynca = fakeConn("ynca", [power]);
    const xml = fakeConn("xml", [power]);
    const s = learnSetup([ynca, xml]);
    await s.handle.start();
    ynca.outcome = "unavailable";
    s.handle.handleStateChange("living.power", false, true);
    await flush();
    expect(xml.writes).toContainEqual({ id: "power", value: true });
    expect(s.debug).toContain("living: power — ynca could not send it, sent through xml");
    ynca.outcome = "refused";
    s.handle.handleStateChange("living.power", false, false);
    await flush();
    expect(s.debug).toContain("living: power — ynca refused it, sent through xml");
  });

  // YNCA allows one connection: a client like Home Assistant holding it at a restart keeps the owner away from
  // this handle's start. It built nothing here, so a write could not be judged and never fell back
  // (review 2026-10-05, A4) — while the same owner dropping mid-session did fall back.
  describe("an owner away since the handle started (review 2026-10-05, A4)", () => {
    const tree = (): LearnedTree => ({
      shared: { power: ["ynca", "xml"], "remote.cursor": ["ynca", "xml"] },
      transports: ["ynca", "xml"],
      firmware: {},
      settledVersion: "3.2.0",
    });
    const key = state("remote.cursor", "Cursor", { type: "string", role: "button", read: false });

    test("a write falls back, judged on the form the owner left in the tree", async () => {
      const xml = fakeConn("xml", [power, key]);
      const s = learnSetup([xml], {
        tree: tree(),
        version: "3.2.0",
        missing: ["ynca"],
        existing: { power: { type: "state", common: power.common } },
      });
      await s.handle.start();
      s.handle.handleStateChange("living.power", false, true);
      await flush();
      expect(xml.writes).toEqual([{ id: "power", value: true }]);
      expect(s.debug).toContain("living: power — ynca offline, sent through xml");
    });

    test("without a form in the tree it cannot be judged, and nothing is sent", async () => {
      const xml = fakeConn("xml", [power, key]);
      const s = learnSetup([xml], { tree: tree(), version: "3.2.0", missing: ["ynca"] });
      await s.handle.start();
      s.handle.handleStateChange("living.power", false, true);
      await flush();
      expect(xml.writes).toEqual([]);
      expect(s.debug).toContain("living: write to power — its transport (ynca) is offline");
    });

    test("a key the owner left in the tree is never sent a second way", async () => {
      const xml = fakeConn("xml", [power, key]);
      const s = learnSetup([xml], {
        tree: tree(),
        version: "3.2.0",
        missing: ["ynca"],
        existing: { "remote.cursor": { type: "state", common: key.common } },
      });
      await s.handle.start();
      s.handle.handleStateChange("living.remote.cursor", false, "Up");
      await flush();
      expect(xml.writes).toEqual([]);
    });
  });

  // Another transport's menu is not the one on screen: its browse states are filtered as a non-owner's, so a line it
  // selected or a key it pressed would act on a window the user never saw.
  test("a menu or remote-key write never falls back to another transport, in no zone", async () => {
    const readable = (id: string): ObjectDef => state(id, id, { type: "string", role: "state" });
    const ids = ["player.browse.selectLine", "remote.cursor", "multiroom.zone2.remote.menu"];
    const ynca = fakeConn("ynca", ids.map(readable));
    const xml = fakeConn("xml", ids.map(readable));
    const s = learnSetup([ynca, xml]);
    await s.handle.start();
    ynca.outcome = "refused";
    for (const id of ids) {
      s.handle.handleStateChange(`living.${id}`, false, "1");
    }
    await flush();
    expect(ynca.writes.map(w => w.id)).toEqual(ids);
    expect(xml.writes).toEqual([]);
  });

  test("a returning transport whose objects cannot be built is not taken in — its retry goes on", async () => {
    const ynca = fakeConn("ynca", [power]);
    const yxc = fakeConn("yxc", [state("dist.role", "Role")]);
    const broken = fakeConn("ynca", [power]);
    broken.buildObjects = (): readonly ObjectDef[] => {
      throw new Error("garbled answer");
    };
    const { handle, transportsReports, fireTimers, timers } = reconnectSetup([ynca, yxc], { ynca: () => broken });
    await handle.start();
    ynca.drop();
    await fireTimers();
    expect(transportsReports.at(-1)).toEqual(["yxc"]);
    expect(broken.closed).toBe(true);
    expect(timers).toHaveLength(1);
  });

  test("a known transport missing at this start keeps the read-in open", async () => {
    const s = learnSetup([fakeConn("yxc", [state("volume", "Volume")])], { version: "3.2.0", missing: ["ynca"] });
    await s.handle.start();
    expect(s.settled).toEqual([]);
  });
});

describe("MultiTransportHandle — the read-in completes once, with the receiver on (2026-10-02)", () => {
  test("not before every known transport answers and every read comes from a switched-on receiver", async () => {
    const ynca = fakeConn("ynca", [state("power", "Power")]);
    let complete = false;
    let onComplete: (() => void) | undefined;
    Object.assign(ynca, {
      readComplete: () => complete,
      onReadComplete: (cb: () => void) => (onComplete = cb),
    });
    const s = learnSetup([ynca], { version: "3.2.0" });
    await s.handle.start();
    expect(s.settled).toEqual([]);
    expect(s.tree().settledVersion).toBeUndefined();
    expect(s.writes.every(w => !w.settle)).toBe(true);
    complete = true;
    onComplete?.();
    await new Promise(resolve => setImmediate(resolve));
    expect(s.settled).toHaveLength(1);
    expect([...s.settled[0]]).toContain("power");
    expect(s.tree().settledVersion).toBe("3.2.0");
    expect(s.writes.some(w => w.settle)).toBe(true);
  });

  test("a known transport that does not answer keeps the read-in open", async () => {
    const s = learnSetup([fakeConn("yxc", [state("volume", "Volume")])], {
      version: "3.2.0",
      tree: { shared: {}, transports: ["ynca", "yxc"], firmware: {} },
    });
    await s.handle.start();
    expect(s.settled).toEqual([]);
  });

  test("a completed read-in of this version does not run again", async () => {
    const s = learnSetup([fakeConn("ynca", [state("power", "Power")])], {
      version: "3.2.0",
      tree: { shared: {}, transports: ["ynca"], firmware: {}, settledVersion: "3.2.0" },
    });
    await s.handle.start();
    expect(s.settled).toEqual([]);
  });

  test("a new firmware opens the read-in again, with one line, and its completion says ready", async () => {
    const ynca = fakeConn("ynca", [state("power", "Power")]);
    Object.assign(ynca, { firmware: () => "1.90" });
    const s = learnSetup([ynca], {
      version: "3.2.0",
      tree: { shared: {}, transports: ["ynca"], firmware: { ynca: "1.80" }, settledVersion: "3.2.0" },
    });
    await s.handle.start();
    expect(s.info).toEqual([
      "living: new firmware found (1.80 → 1.90) — reading the receiver again, this can take a few minutes",
      "living: ready — YNCA ✓",
    ]);
    expect(s.settled).toHaveLength(1);
    expect(s.tree().firmware.ynca).toBe("1.90");
  });

  test("an empty firmware is no update, and the same new firmware says nothing a second time", async () => {
    const quiet = fakeConn("ynca", [state("power", "Power")]);
    Object.assign(quiet, { firmware: () => "" });
    const first = learnSetup([quiet], { tree: { shared: {}, transports: [], firmware: { ynca: "1.80" } } });
    await first.handle.start();
    expect(first.info).toEqual([]);
    const same = fakeConn("ynca", [state("power", "Power")]);
    Object.assign(same, { firmware: () => "1.80" });
    const second = learnSetup([same], { tree: first.tree() });
    await second.handle.start();
    expect(second.info).toEqual([]);
  });

  // A receiver updated in standby is read in once it is switched on — often in a later connection. The flag that
  // said "this read-in came from a firmware update" lived in the connection that saw the update, and the later
  // one closed the read-in without the ready line (review 2026-10-05, A54).
  test("a firmware read-in completed by a later connection still ends with the ready line", async () => {
    const store = {
      tree: { shared: {}, transports: ["ynca"], firmware: { ynca: "1.80" }, settledVersion: "3.2.0" } as LearnedTree,
    };
    const connect = async (complete: boolean): Promise<string[]> => {
      const info: string[] = [];
      const ynca = Object.assign(fakeConn("ynca", [state("power", "Power")]), {
        firmware: () => "1.90",
        readComplete: () => complete,
      });
      const handle = new MultiTransportHandle("living", [ynca], {
        upsertObject: () => Promise.resolve(),
        log: { ...silentLog, info: (m: string) => info.push(m) },
        adapterVersion: "3.2.0",
        tree: { get: () => store.tree, set: tree => (store.tree = tree) },
        settleTree: () => Promise.resolve(),
      });
      await handle.start();
      handle.close();
      return info;
    };
    expect(await connect(false)).toEqual([
      "living: new firmware found (1.80 → 1.90) — reading the receiver again, this can take a few minutes",
    ]);
    expect(store.tree.settledVersion).toBeUndefined();
    expect(await connect(true)).toEqual(["living: ready — YNCA ✓"]);
    expect(store.tree.settledVersion).toBe("3.2.0");
    expect(store.tree.firmwareUpdate).toBeUndefined();
    // Read in: the next connection says nothing.
    expect(await connect(true)).toEqual([]);
  });

  test("in standby the firmware line stands, the ready line waits for the switched-on read", async () => {
    const ynca = fakeConn("ynca", [state("power", "Power")]);
    Object.assign(ynca, { firmware: () => "1.90", readComplete: () => false });
    const s = learnSetup([ynca], {
      version: "3.2.0",
      tree: { shared: {}, transports: ["ynca"], firmware: { ynca: "1.80" }, settledVersion: "3.2.0" },
    });
    await s.handle.start();
    expect(s.info).toHaveLength(1);
    expect(s.settled).toEqual([]);
  });
});

describe("MultiTransportHandle — a tree that follows the device within a session (2.7.0)", () => {
  const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

  test("a transport's shape change re-coordinates the tree: the new object is written and owned", async () => {
    const yncaObjects = [state("volume", "Volume dB", { unit: "dB" })];
    const ynca = fakeConn("ynca", yncaObjects);
    const yxc = fakeConn("yxc", [state("dist.role", "Role")]);
    const { handle, objects } = setup([ynca, yxc]);
    await handle.start();
    objects.length = 0;
    // A function the receiver answered later (a push, a background refresh) — the controller
    // upserted it through its adapter, which signals the handle.
    yncaObjects.push(state("mute", "Mute"));
    ynca.changeShape();
    await flush();
    expect(objects).toEqual(["living.mute"]);
    expect(ynca.seeded).toContain("mute");
    handle.handleStateChange("living.mute", false, true);
    expect(ynca.writes).toContainEqual({ id: "mute", value: true });
  });

  test("a menu claim proven later in the session takes the menus over from the transport that held them (forum 85413)", async () => {
    // A receiver in standby at connect: YNCA claims the menus without proof, XML proved them, so
    // XML owns them. Switched on, YNCA proves its menus and re-publishes the claim without the mark.
    const browse = (unproven: boolean): ObjectDef => ({
      ...state("player.browse.source", "Source", { type: "string" }),
      ...(unproven ? { unproven: true } : {}),
    });
    const yncaObjects = [browse(true)];
    const ynca = fakeConn("ynca", yncaObjects);
    const xml = fakeConn("xml", [browse(false)]);
    const { handle } = setup([ynca, xml]);
    await handle.start();
    handle.handleStateChange("living.player.browse.source", false, "netRadio");
    expect(xml.writes).toEqual([{ id: "player.browse.source", value: "netRadio" }]);
    expect(ynca.writes).toEqual([]);
    yncaObjects[0] = browse(false);
    ynca.changeShape();
    await flush();
    handle.handleStateChange("living.player.browse.source", false, "server");
    expect(ynca.writes).toEqual([{ id: "player.browse.source", value: "server" }]);
    expect(xml.writes).toHaveLength(1);
  });

  test("a shape signal without a real change writes nothing", async () => {
    const ynca = fakeConn("ynca", [state("volume", "Volume dB")]);
    const { handle, objects } = setup([ynca]);
    await handle.start();
    objects.length = 0;
    ynca.changeShape();
    await flush();
    expect(objects).toEqual([]);
  });

  test("a dropped transport shrinks nothing — removals stay a start-time decision", async () => {
    const ynca = fakeConn("ynca", [state("volume", "Volume dB")]);
    const yxc = fakeConn("yxc", [state("dist.role", "Role")]);
    const { handle, objects } = setup([ynca, yxc]);
    await handle.start();
    objects.length = 0;
    yxc.drop();
    await flush();
    expect(objects).toEqual([]);
  });

  test("a shape change after close is ignored", async () => {
    const yncaObjects = [state("volume", "Volume dB")];
    const ynca = fakeConn("ynca", yncaObjects);
    const { handle, objects } = setup([ynca]);
    await handle.start();
    handle.close();
    objects.length = 0;
    yncaObjects.push(state("mute", "Mute"));
    ynca.changeShape();
    await flush();
    expect(objects).toEqual([]);
  });
});

describe("MultiTransportHandle — coordination is serialized against a reconnect", () => {
  const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

  // A transport's reconnect coordinates the tree. A transport that was live all along keeps its
  // shape-change wiring armed across that drop — `handleTransportDrop` splices only the one that
  // went — so its background refresh can signal a re-coordination straight into the reconnect's
  // upsert await. Both runs compute their ownership map BEFORE the awaits and install it AFTER,
  // so whichever finishes last wins. The reconnect started first with the older snapshot: let it
  // finish last and the newly learned id belongs to nobody, and every write to it is dropped
  // without a trace.
  test("a live transport's shape change during a reconnect keeps the LATER ownership", async () => {
    const yncaObjects = [state("sound.bass", "Bass dB", { unit: "dB" })];
    const ynca = fakeConn("ynca", yncaObjects);
    const xml = fakeConn("xml", [state("power", "Power")]);
    // The returning connection contributes one id the tree did not have — `coordinate()` writes
    // only CHANGED definitions, so without it the reconnect's coordination has no await to park in.
    const freshXml = fakeConn("xml", [state("power", "Power"), state("input", "Input")]);

    const timers: Array<() => void> = [];
    let releaseUpsert: (() => void) | undefined;
    let stallNextUpsert = false;

    const handle = new MultiTransportHandle("living", [ynca, xml], {
      upsertObject: () => {
        if (stallNextUpsert) {
          stallNextUpsert = false;
          return new Promise<void>(resolve => {
            releaseUpsert = resolve;
          });
        }
        return Promise.resolve();
      },
      log: silentLog,
      rebuild: () => freshXml,
      schedule: cb => {
        timers.push(cb);
        return timers.length;
      },
      cancel: () => {},
      backoffFactory: () => ({ nextDelay: () => 1000, reset: () => {} }),
    });
    await handle.start();

    xml.drop(new Error("socket reset"));
    stallNextUpsert = true;
    for (const cb of timers.splice(0)) {
      cb();
    }
    await flush();
    expect(releaseUpsert).toBeDefined(); // parked inside the reconnect's coordination

    // The receiver answered a function it had not answered before, while that coordination runs.
    yncaObjects.push(state("mute", "Mute"));
    ynca.changeShape();
    await flush();

    releaseUpsert?.();
    await flush();
    await flush();

    handle.handleStateChange("living.mute", false, true);
    expect(ynca.writes).toContainEqual({ id: "mute", value: true });
  });
});

describe("canCarryWrite keeps a write off a read-only transport (audit 2026-09-29, A27)", () => {
  test("with its owner offline, a write to hdmi.out3 does not go to the read-only MusicCast entry", async () => {
    const out = (write: boolean): ObjectDef =>
      state("hdmi.out3", "HDMI OUT 3", { type: "boolean", role: "switch", write });
    const ynca = fakeConn("ynca", [out(true)]);
    const yxc = fakeConn("yxc", [out(false)]);
    const { handle, fireTimers } = reconnectSetup([ynca, yxc], { ynca: () => fakeConn("ynca", [out(true)]) });
    await handle.start();
    yxc.seeded.length = 0;
    ynca.drop(new Error("socket reset"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(yxc.seeded).not.toContain("hdmi.out3");
    handle.handleStateChange("living.hdmi.out3", false, true);
    expect(yxc.writes).toEqual([]);
    await fireTimers();
  });
});

describe("MultiTransportHandle capture (diagnostics report)", () => {
  test("reads each live transport that can be read and names who serves which datapoint, changing nothing", async () => {
    const ynca = fakeConn("ynca", [state("power", "Power"), state("volume", "Volume")]);
    const yxc = Object.assign(fakeConn("yxc", [state("volume", "Volume")]), {
      capture: () =>
        Promise.resolve({
          transport: "yxc" as const,
          startedAt: "",
          durationMs: 0,
          complete: true,
          asked: 1,
          answers: { a: 1 },
        }),
    });
    const { handle, objects } = setup([ynca, yxc]);
    await handle.start();
    const written = objects.length;
    const capture = await handle.capture();
    expect(capture.live).toEqual(["ynca", "yxc"]);
    expect(capture.owners).toEqual({ power: "ynca", volume: "yxc" });
    expect(capture.captures.map(c => c.transport)).toEqual(["yxc"]);
    expect(objects).toHaveLength(written);
    expect(ynca.writes).toEqual([]);
    expect(yxc.writes).toEqual([]);
  });
});

describe("MultiTransportHandle — a closed handle writes nothing more (review 2026-10-05, A6)", () => {
  // A delete or a move closes the handle and removes or rebuilds the tree right after. The learn in flight wrote
  // on: 19 objects landed in the deleted device, and on a move its settle could remove what the new handle had
  // just created.
  test("a learn in flight stops at its next write: no upsert starts, no transport is seeded after close", async () => {
    const objects = [state("volume", "Volume")];
    const ynca = fakeConn("ynca", objects);
    const started: Array<{ id: string; afterClose: boolean }> = [];
    let closed = false;
    let slow = false;
    const handle = new MultiTransportHandle("living", [ynca], {
      upsertObject: async id => {
        started.push({ id, afterClose: closed });
        if (slow) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      },
      log: silentLog,
    });
    await handle.start();
    started.length = 0;
    // A refresh adds 20 objects; the learn writes them one by one, each a database round trip.
    for (let i = 0; i < 20; i++) {
      objects.push(state(`sound.x${i}`, `X${i}`));
    }
    slow = true;
    ynca.changeShape();
    await new Promise(resolve => setTimeout(resolve, 12));
    const seededAtClose = ynca.seeded.length;
    handle.close();
    closed = true;
    await handle.settled();
    expect(started.length).toBeGreaterThan(0);
    expect(started.filter(write => write.afterClose)).toEqual([]);
    expect(ynca.seeded.length).toBe(seededAtClose);
  });

  test("a read-in completing after close neither writes the tree nor settles it", async () => {
    let release: () => void = () => undefined;
    const settled: string[] = [];
    const trees: LearnedTree[] = [];
    const handle = new MultiTransportHandle("living", [fakeConn("ynca", [state("power", "Power")])], {
      upsertObject: () => new Promise<void>(resolve => (release = resolve)),
      log: silentLog,
      adapterVersion: "3.2.0",
      tree: { get: () => emptyLearnedTree(), set: tree => void trees.push(tree) },
      settleTree: () => {
        settled.push("settle");
        return Promise.resolve();
      },
    });
    const starting = handle.start();
    await new Promise(resolve => setImmediate(resolve));
    handle.close();
    release();
    await expect(starting).resolves.toEqual([]);
    expect(trees).toEqual([]);
    expect(settled).toEqual([]);
  });
});

describe("MultiTransportHandle — a reconnect in flight and one that drops again (review 2026-10-05, A7/A52)", () => {
  const power = state("power", "Power", { type: "boolean", role: "switch.power" });

  // A YNCA reconnect sweeps for 20-40 s. When the device was deleted or moved meanwhile, or its last other
  // transport dropped, the connection kept sweeping and then held the receiver's ONE YNCA connection: the next
  // full reconnect failed on it.
  test("close() closes a transport whose reconnect is still connecting, at once", async () => {
    let release: (ok: boolean) => void = () => undefined;
    const sweeping = fakeConn("ynca", [power]);
    sweeping.connect = (): Promise<boolean> => new Promise<boolean>(resolve => (release = resolve));
    const ynca = fakeConn("ynca", [power]);
    const yxc = fakeConn("yxc", [power]);
    const { handle, fireTimers, transportsReports } = reconnectSetup([ynca, yxc], { ynca: () => sweeping });
    await handle.start();
    ynca.drop(new Error("socket reset"));
    await fireTimers(); // the reconnect starts: socket open, sweep running
    expect(sweeping.closed).toBe(false);
    handle.close();
    expect(sweeping.closed).toBe(true);
    const reports = transportsReports.length;
    release(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(transportsReports).toHaveLength(reports);
  });

  // The fresh connection reports a drop it latched while it connected: it is gone again during its first learn.
  test("a reconnect that drops during its first learn keeps its backoff and its timer, and says no reconnected", async () => {
    const ynca = fakeConn("ynca", [power]);
    const yxc = fakeConn("yxc", [power]);
    const flaky = (): ConnectableTransport => {
      const conn = fakeConn("ynca", [power]);
      conn.onDrop = (cb: (reason?: Error) => void): void => cb(new Error("dropped while connecting"));
      return conn;
    };
    const timers: Array<{ id: number; cb: () => void; ms: number }> = [];
    const cancelled: unknown[] = [];
    const logs: string[] = [];
    const reports: string[][] = [];
    let factories = 0;
    const handle = new MultiTransportHandle("living", [ynca, yxc], {
      upsertObject: () => Promise.resolve(),
      log: { ...silentLog, debug: (m: string) => logs.push(m) },
      onTransports: names => reports.push([...names]),
      rebuild: flaky,
      schedule: (cb, ms) => {
        const id = timers.length + 1;
        timers.push({ id, cb, ms });
        return id;
      },
      cancel: id => void cancelled.push(id),
      backoffFactory: () => {
        factories++;
        let n = 0;
        return { nextDelay: () => 1000 * 2 ** n++, reset: () => (n = 0) };
      },
    });
    await handle.start();
    ynca.drop(new Error("socket reset"));
    timers[0].cb();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(logs.some(line => line.includes("transport reconnected"))).toBe(false);
    expect(reports.at(-1)).toEqual(["yxc"]);
    // The next attempt is pending on the SAME backoff, one step further — not reset to the first delay.
    expect(timers.map(timer => timer.ms)).toEqual([1000, 2000]);
    expect(factories).toBe(1);
    // And it is still the handle's: close cancels it.
    handle.close();
    expect(cancelled).toEqual([2]);
  });

  test("a reconnect that holds resets the backoff: the next outage starts at the first delay again", async () => {
    const ynca = fakeConn("ynca", [power]);
    const yxc = fakeConn("yxc", [power]);
    const fresh = fakeConn("ynca", [power]);
    const h = reconnectSetup([ynca, yxc], { ynca: () => fresh });
    await h.handle.start();
    ynca.drop(new Error("socket reset"));
    await h.fireTimers();
    expect(h.logs.some(line => line.includes("transport reconnected"))).toBe(true);
    fresh.drop(new Error("socket reset"));
    expect(h.delays).toEqual([1000, 1000]);
  });
});

describe("MultiTransportHandle — what changes during the first learn is learned (review 2026-10-05, A8/F1)", () => {
  const text = (id: string, extra: Record<string, unknown> = {}): ObjectDef => ({
    id,
    type: "state",
    common: { name: id, type: "string", role: "state", read: true, write: true, ...extra },
  });

  // While the first learn writes (a database round trip), a push grows the input list and a brand-new datapoint
  // appears with its value. The handle armed its signals only after that learn, so both were never learned — and
  // the new datapoint's value was dropped — until some later, unrelated change.
  test("a list grown and a datapoint built while the first learn writes are learned, with their values", async () => {
    const written: string[] = [];
    const acks: Array<[string, unknown]> = [];
    const adapter = new TransportConnectionAdapter("yxc", "dev", (id, value) => void acks.push([id, value]));
    adapter.bind({
      start: async () => {
        await adapter.interceptUpsert("dev.input", text("input", { states: { hdmi1: "HDMI1" } }));
        adapter.interceptSetStateAck("dev.input", "hdmi1");
        return true;
      },
      handleWrite: () => "sent",
      onDrop: () => {},
      close: () => {},
    });
    await adapter.connect();
    let midLearn: (() => void) | undefined = () => {
      void adapter.interceptUpsert("dev.input", text("input", { states: { hdmi1: "HDMI1", tv: "TV" } }));
      void adapter.interceptUpsert("dev.sound.dialogueLevel", text("sound.dialogueLevel"));
      adapter.interceptSetStateAck("dev.sound.dialogueLevel", "2");
      adapter.interceptSetStateAck("dev.input", "tv");
    };
    const defs = new Map<string, ObjectDef>();
    const handle = new MultiTransportHandle("dev", [adapter], {
      upsertObject: async (id, def) => {
        written.push(id);
        defs.set(id, def);
        const fire = midLearn;
        midLearn = undefined;
        fire?.();
        await new Promise(resolve => setTimeout(resolve, 1));
      },
      log: silentLog,
    });
    await handle.start();
    // Waited for, not timed: every write takes a timer round, and a Windows timer is ~15 ms coarse — a fixed 30 ms
    // ended before the value arrived there (CI 2026-10-06, 22.x windows).
    await vi.waitFor(() => {
      expect(written).toContain("dev.sound.dialogueLevel");
      expect(defs.get("dev.input")?.common.states).toEqual({ hdmi1: "HDMI1", tv: "TV" });
      expect(acks).toContainEqual(["dev.sound.dialogueLevel", "2"]);
      expect(acks.filter(([id]) => id === "dev.input").at(-1)).toEqual(["dev.input", "tv"]);
    });
    handle.close();
  });

  // The YNCA controller tells its listeners once when the switched-on read is complete; a read completing during
  // the first learn found no listener yet.
  test("a read that became complete during the first learn completes the read-in", async () => {
    let complete = false;
    const ynca = Object.assign(fakeConn("ynca", [state("power", "Power")]), {
      readComplete: () => complete,
      onReadComplete: (): void => undefined,
    });
    const settled: Array<ReadonlySet<string>> = [];
    const handle = new MultiTransportHandle("living", [ynca], {
      upsertObject: () => {
        complete = true;
        return Promise.resolve();
      },
      log: silentLog,
      adapterVersion: "3.2.0",
      tree: { get: () => emptyLearnedTree(), set: () => undefined },
      settleTree: built => {
        settled.push(built);
        return Promise.resolve();
      },
    });
    await handle.start();
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toHaveLength(1);
    handle.close();
  });

  // A background refresh republishes every object with a grown list: one signal per object queued one full learn
  // per object — a coordination and a fingerprint of the whole tree each, 3.4 s of event loop for 1000. Coalesced,
  // a learn takes what changed while the one before it ran (measured: 19 learns, 146 ms), and each changed object
  // is written once.
  test("a refresh that changes 1000 objects is learned in a few learns, each object written once", async () => {
    const N = 1000;
    const big = (id: string, rev: number): ObjectDef => text(id, { states: { a: "A", b: "B", [`r${rev}`]: "R" } });
    const adapter = new TransportConnectionAdapter("ynca", "dev", () => {});
    adapter.bind({
      start: async () => {
        for (let i = 0; i < N; i++) {
          await adapter.interceptUpsert(`dev.s${i}`, big(`s${i}`, 0));
        }
        return true;
      },
      handleWrite: () => "sent",
      onDrop: () => {},
      close: () => {},
    });
    await adapter.connect();
    const snapshot = adapter.buildObjects.bind(adapter);
    let learns = 0;
    adapter.buildObjects = (): readonly ObjectDef[] => {
      learns++;
      return snapshot();
    };
    let upserts = 0;
    const handle = new MultiTransportHandle("dev", [adapter], {
      upsertObject: () => {
        upserts++;
        return Promise.resolve();
      },
      log: silentLog,
    });
    await handle.start();
    learns = 0;
    upserts = 0;
    for (let i = 0; i < N; i++) {
      await adapter.interceptUpsert(`dev.s${i}`, big(`s${i}`, 1));
    }
    let last = -1;
    while (last !== learns) {
      last = learns;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(learns).toBeGreaterThan(0);
    expect(learns).toBeLessThan(N / 20);
    expect(upserts).toBe(N);
    handle.close();
  });
});

describe("the model and the firmware reach the tree over every protocol (review 2026-10-05, A5)", () => {
  /**
   * A transport whose controller builds info.model/info.firmware from the one definition and reports them.
   *
   * @param transport the protocol
   * @param model the model it reports
   * @param firmware the firmware it reports
   * @param acks where the values the tree gets land
   * @returns the transport behind its adapter
   */
  function reporting(
    transport: Transport,
    model: string,
    firmware: string,
    acks: Array<[string, unknown]>,
  ): TransportConnectionAdapter {
    const adapter = new TransportConnectionAdapter(transport, "dev", (id, value) => void acks.push([id, value]));
    adapter.bind({
      start: async () => {
        for (const def of catalogToObjects([...INFO_ENTRIES])) {
          await adapter.interceptUpsert(`dev.${def.id}`, def);
        }
        adapter.interceptSetStateAck("dev.info.model", model);
        adapter.interceptSetStateAck("dev.info.firmware", firmware);
        return true;
      },
      handleWrite: () => "sent",
      onDrop: () => {},
      close: () => {},
    });
    return adapter;
  }

  test("with YNCA and MusicCast, YNCA's values stand — as they did before every protocol built them", async () => {
    const acks: Array<[string, unknown]> = [];
    const ynca = reporting("ynca", "RX-V6A", "1.10/2.40", acks);
    const yxc = reporting("yxc", "RX-V6A", "2.40", acks);
    await Promise.all([ynca.connect(), yxc.connect()]);
    const objects: string[] = [];
    const handle = new MultiTransportHandle("dev", [ynca, yxc], {
      upsertObject: id => {
        objects.push(id);
        return Promise.resolve();
      },
      log: silentLog,
    });
    await handle.start();
    expect(objects.filter(id => id === "dev.info.firmware")).toHaveLength(1);
    expect(acks).toEqual([
      ["dev.info.model", "RX-V6A"],
      ["dev.info.firmware", "1.10/2.40"],
    ]);
    handle.close();
  });

  test("without YNCA, MusicCast's model and firmware reach the tree", async () => {
    const acks: Array<[string, unknown]> = [];
    const yxc = reporting("yxc", "WX-030", "2.16", acks);
    const xml = reporting("xml", "WX-030", "1.00", acks);
    await Promise.all([yxc.connect(), xml.connect()]);
    const handle = new MultiTransportHandle("dev", [xml, yxc], {
      upsertObject: () => Promise.resolve(),
      log: silentLog,
    });
    await handle.start();
    expect(acks).toEqual([
      ["dev.info.model", "WX-030"],
      ["dev.info.firmware", "2.16"],
    ]);
    handle.close();
  });
});
