import { connectTransports, type ConnectableTransport } from "./attempt-device";
import { ReachabilityDedup } from "./lifecycle/reachability-dedup";
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
    const handle = await connectTransports(
      "living",
      [
        { transport: ynca.transport, build: () => ynca },
        { transport: yxc.transport, build: () => yxc },
      ],
      d,
    );
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
    const handle = await connectTransports(
      "living",
      [
        { transport: ynca.transport, build: () => ynca },
        { transport: yxc.transport, build: () => yxc },
      ],
      d,
    );
    expect(handle).not.toBeNull();
    expect(yxc.closed).toBe(true);
    expect(yxc.seeded).toEqual([]); // never seeded — not part of the tree
    expect(d.objects).not.toContain("living.dist.role");
  });

  test("no transport answers → null, every attempt closed", async () => {
    const ynca = fakeConn("ynca", [state("power", "Power")], false);
    const yxc = fakeConn("yxc", [state("dist.role", "Role")], false);
    const handle = await connectTransports(
      "living",
      [
        { transport: ynca.transport, build: () => ynca },
        { transport: yxc.transport, build: () => yxc },
      ],
      deps(),
    );
    expect(handle).toBeNull();
    expect(ynca.closed).toBe(true);
    expect(yxc.closed).toBe(true);
  });

  test("a connect that throws is swallowed so the other transports still connect", async () => {
    const ynca = fakeConn("ynca", [state("power", "Power")], () => Promise.reject(new Error("socket")));
    const yxc = fakeConn("yxc", [state("dist.role", "Role")], true);
    const d = deps();
    const handle = await connectTransports(
      "living",
      [
        { transport: ynca.transport, build: () => ynca },
        { transport: yxc.transport, build: () => yxc },
      ],
      d,
    );
    expect(handle).not.toBeNull();
    expect(ynca.closed).toBe(true);
    expect(d.objects).toContain("living.dist.role"); // yxc still made it into the tree
  });

  test("without a reachability dep, every failed attempt still warns (unchanged default)", async () => {
    const ynca = fakeConn("ynca", [], false);
    const warn = vi.fn();
    const d = { ...deps(), log: { ...silentLog, warn } };
    await connectTransports("living", [{ transport: ynca.transport, build: () => ynca }], d);
    await connectTransports("living", [{ transport: ynca.transport, build: () => ynca }], d);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("with a reachability dep, only the first attempt in a row warns — repeats drop to debug", async () => {
    const ynca = fakeConn("ynca", [], false);
    const warn = vi.fn();
    const debug = vi.fn();
    const d = { ...deps(), log: { ...silentLog, warn, debug }, reachability: new ReachabilityDedup() };
    await connectTransports("living", [{ transport: ynca.transport, build: () => ynca }], d);
    await connectTransports("living", [{ transport: ynca.transport, build: () => ynca }], d);
    await connectTransports("living", [{ transport: ynca.transport, build: () => ynca }], d);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("living: no reachable transport (YNCA/YXC/XML)");
    expect(debug).toHaveBeenCalledTimes(2);
  });

  test("a reconnect after failures re-arms the warn for the next drop", async () => {
    const dead = fakeConn("ynca", [], false);
    const alive = fakeConn("ynca", [state("power", "Power")], true);
    const warn = vi.fn();
    const d = { ...deps(), log: { ...silentLog, warn }, reachability: new ReachabilityDedup() };
    await connectTransports("living", [{ transport: dead.transport, build: () => dead }], d); // 1st failure — warns
    await connectTransports("living", [{ transport: dead.transport, build: () => dead }], d); // repeat — debug, no extra warn
    await connectTransports("living", [{ transport: alive.transport, build: () => alive }], d); // reconnects — clears the dedup
    await connectTransports("living", [{ transport: dead.transport, build: () => dead }], d); // dropped again — warns again
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// attemptDevice itself: the three transport builders. Everything above drives
// connectTransports with fakes; these prove each builder targets the right
// protocol on the right port — a mis-wired builder is a protocol that never
// connects, and looks exactly like a device that does not speak it.
// ---------------------------------------------------------------------------

import { vi } from "vitest";
import { attemptDevice } from "./attempt-device";

const wire = vi.hoisted(() => ({
  tcp: [] as Array<Record<string, unknown>>,
  http: [] as Array<Record<string, unknown>>,
  udp: 0,
}));
vi.mock("node:net", () => ({
  connect: (options: Record<string, unknown>) => {
    wire.tcp.push(options);
    const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    const s = {
      on: (ev: string, h: (...a: unknown[]) => void) => {
        (handlers[ev] ??= []).push(h);
        // Nothing is listening on 50000 in this test — answer like the OS does.
        if (ev === "error") {
          queueMicrotask(() => {
            h(new Error("ECONNREFUSED"));
            (handlers.close ?? []).forEach(c => c());
          });
        }
        return s;
      },
      setTimeout: () => undefined,
      write: () => undefined,
      destroy: () => undefined,
    };
    return s;
  },
}));
vi.mock("node:http", () => {
  const make = (options: unknown) => {
    wire.http.push((typeof options === "string" ? { url: options } : options) as Record<string, unknown>);
    const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    const req = {
      on: (ev: string, h: (...a: unknown[]) => void) => {
        (handlers[ev] ??= []).push(h);
        return req;
      },
      setTimeout: () => undefined,
      write: () => undefined,
      end: () => undefined,
      destroy: () => undefined,
    };
    // `get` auto-ends, `request` needs .end() — answer like a refused connection
    // either way so no attempt can hang the test.
    queueMicrotask(() => (handlers.error ?? []).forEach(h => h(new Error("ECONNREFUSED"))));
    return req;
  };
  return { request: make, get: make };
});
vi.mock("node:dgram", () => ({
  createSocket: () => {
    wire.udp++;
    return { on: () => undefined, bind: () => undefined, close: () => undefined, send: () => undefined };
  },
}));

describe("attemptDevice builders", () => {
  test("tries all three protocols at their own endpoints and gives up cleanly", async () => {
    wire.tcp.length = 0;
    wire.http.length = 0;
    const warns: string[] = [];
    const result = await attemptDevice(
      { id: "living", ip: "192.168.1.10" },
      {
        log: { debug: () => {}, info: () => {}, warn: m => warns.push(m) },
        upsertObject: async () => {},
        setStateAck: () => {},
        timers: { schedule: () => 1 as unknown as ioBroker.Timeout, cancel: () => {} },
        registerPush: () => () => {},
        scheduleKeepalive: () => () => {},
        xmlPollIntervalMs: 60_000,
        onTransports: () => {},
        knownDeviceIps: new Set(["192.168.1.10"]),
        isEntryEnabled: () => true,
      },
    );

    // Nothing answered — the device is simply not reachable this attempt.
    expect(result).toBeNull();
    expect(warns.some(w => w.includes("no reachable transport"))).toBe(true);
    // YNCA is a held TCP connection on 50000 …
    expect(wire.tcp).toContainEqual({ host: "192.168.1.10", port: 50000 });
    // … while YXC and XML both speak HTTP on 80, XML on the control endpoint.
    expect(wire.http.some(o => o.port === 80 && o.path === "/YamahaRemoteControl/ctrl")).toBe(true);
    expect(wire.http.some(o => String(o.url ?? o.host ?? "").includes("192.168.1.10"))).toBe(true);
  });
});
