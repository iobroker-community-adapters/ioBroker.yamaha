import { vi } from "vitest";
import { connectTransports, partnerClient, type ConnectableTransport } from "./attempt-device";
import { YamahaYxcClient } from "./yxc/http-client";
import type { ObjectDef } from "./catalog/types";
import type { Transport } from "./catalog/owner-policy";

const silentLog = { debug: (): void => {}, info: (): void => {}, warn: (): void => {} };

function state(id: string, name: string, extra: Record<string, unknown> = {}): ObjectDef {
  return { id, type: "state", common: { name, type: "number", role: "level", read: true, write: true, ...extra } };
}

/**
 * A fake connectable transport: connect() yields a preset result; records seed + close.
 *
 * @param transport Which protocol the fake stands in for
 * @param objects Object definitions the fake declares
 * @param connectResult Preset connect() outcome, or a function producing it
 */
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
    // volume owned by MusicCast (it alone reports the displayed scale), dist.role exclusive to YXC
    expect(yxc.seeded).toContain("volume");
    expect(yxc.seeded).toContain("dist.role");
    expect(ynca.seeded).not.toContain("volume");
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

  test("an unreachable device is a debug line, never a warning — its state says offline", async () => {
    const ynca = fakeConn("ynca", [], false);
    const warn = vi.fn();
    const debug = vi.fn();
    const d = { ...deps(), log: { ...silentLog, warn, debug } };
    await connectTransports("living", [{ transport: ynca.transport, build: () => ynca }], d);
    await connectTransports("living", [{ transport: ynca.transport, build: () => ynca }], d);
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith("living: no reachable transport (YNCA/YXC/XML)");
  });

  test("hands the handle a rebuild that builds the SAME transport afresh after it drops", async () => {
    // The per-transport reconnect: a dropped YNCA socket must come back as a new YNCA client
    // for the same device while YXC keeps running — wired here, exercised in the handle.
    let builds = 0;
    let drop: (reason?: Error) => void = () => {};
    const yncaConn = (): ConnectableTransport => {
      builds++;
      const conn = fakeConn("ynca", [state("power", "Power")]);
      conn.onDrop = cb => {
        drop = cb;
      };
      return conn;
    };
    const scheduled: Array<() => void> = [];
    const cancelled: unknown[] = [];
    const d = {
      ...deps(),
      timers: {
        schedule: (cb: () => void, _ms: number) => {
          scheduled.push(cb);
          return scheduled.length as unknown as ioBroker.Timeout;
        },
        cancel: (handle: unknown) => {
          cancelled.push(handle);
        },
      },
    };
    const handle = await connectTransports(
      "living",
      [
        { transport: "ynca", build: yncaConn },
        { transport: "yxc", build: () => fakeConn("yxc", [state("volume", "Volume")]) },
      ],
      d,
    );
    expect(handle).not.toBeNull();
    expect(builds).toBe(1);
    drop(new Error("socket closed"));
    // The retry was scheduled through the adapter's timers (never a native one) …
    expect(scheduled).toHaveLength(1);
    scheduled[0]();
    await new Promise(resolve => setImmediate(resolve));
    // … and it rebuilt exactly the YNCA transport, not the whole device.
    expect(builds).toBe(2);
    handle?.close();
  });
});

// ---------------------------------------------------------------------------
// attemptDevice itself: the three transport builders. Everything above drives
// connectTransports with fakes; these prove each builder targets the right
// protocol on the right port — a mis-wired builder is a protocol that never
// connects, and looks exactly like a device that does not speak it.
// ---------------------------------------------------------------------------

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
interface FakeRequest {
  on(ev: string, h: (...a: unknown[]) => void): FakeRequest;
  setTimeout(): undefined;
  write(): undefined;
  end(): undefined;
  destroy(): undefined;
}
vi.mock("node:http", () => {
  const make = (options: unknown): FakeRequest => {
    wire.http.push((typeof options === "string" ? { url: options } : options) as Record<string, unknown>);
    const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    const req: FakeRequest = {
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

describe("connectTransports ends with what is live (audit 2026-09-24, A21/A3)", () => {
  // Every transport dropping while the tree was built used to hand the supervisor a handle: a
  // "ready" line and info.connection true, then at once false — for a device that is off.
  test("all transports dropping during start is no connection and no ready line", async () => {
    const latchedDrop = (transport: Transport): ConnectableTransport & { closed: boolean } => {
      const conn = fakeConn(transport, [state(`${transport}.x`, "X")]);
      conn.onDrop = (cb: (reason?: Error) => void): void => cb(new Error("gone"));
      return conn;
    };
    const ynca = latchedDrop("ynca");
    const xml = latchedDrop("xml");
    const infos: string[] = [];
    const d = { ...deps(), log: { ...silentLog, info: (message: string): void => void infos.push(message) } };
    const handle = await connectTransports(
      "living",
      [
        { transport: "ynca", build: () => ynca },
        { transport: "xml", build: () => xml },
      ],
      d,
    );
    expect(handle).toBeNull();
    expect(infos).toEqual([]);
  });

  // A delete or a move closes the supervisor while the attempt still connects: what it built is
  // closed (that also closes the command gate) and the attempt yields nothing.
  test("an aborted attempt closes every transport it built and returns null", async () => {
    let release: (ok: boolean) => void = () => {};
    const slow = fakeConn("ynca", [state("power", "Power")], () => new Promise<boolean>(r => (release = r)));
    const fast = fakeConn("yxc", [state("volume", "Volume")]);
    const abort = new AbortController();
    const pending = connectTransports(
      "living",
      [
        { transport: "ynca", build: () => slow },
        { transport: "yxc", build: () => fast },
      ],
      deps(),
      abort.signal,
    );
    abort.abort();
    expect(slow.closed).toBe(true);
    expect(fast.closed).toBe(true);
    release(true);
    await expect(pending).resolves.toBeNull();
  });
});

describe("partnerClient — the multiroom link target", () => {
  test("another device this instance runs gets a client; the device itself and strangers do not", () => {
    const known = new Set(["192.168.1.10", "192.168.1.11"]);
    expect(partnerClient("192.168.1.10", known, "192.168.1.11")).toBeInstanceOf(YamahaYxcClient);
    expect(partnerClient("192.168.1.10", known, "192.168.1.10")).toBeUndefined();
    expect(partnerClient("192.168.1.10", known, "192.168.1.99")).toBeUndefined();
  });
});

describe("attemptDevice builders", () => {
  /**
   * The deps of the builders test, with the debug lines recorded.
   *
   * @param debugs where debug lines land
   * @param warns where warn lines land
   * @returns the deps
   */
  function depsWith(debugs: string[], warns: string[] = []): Parameters<typeof attemptDevice>[1] {
    return {
      log: { debug: m => debugs.push(m), info: () => {}, warn: m => warns.push(m) },
      upsertObject: async () => {},
      setStateAck: () => {},
      timers: { schedule: () => 1 as unknown as ioBroker.Timeout, cancel: () => {} },
      registerPush: () => () => {},
      scheduleKeepalive: () => () => {},
      xmlPollIntervalMs: 60_000,
      onTransports: () => {},
      knownDeviceIps: new Set(["192.168.1.10"]),
      isEntryEnabled: () => true,
    };
  }
  // MusicCast requests by URL string, XML by an options object — the recorder keeps each as is.
  const yxcTried = (): boolean => wire.http.some(o => String(o.url ?? o.path).includes("/YamahaExtendedControl"));
  const xmlTried = (): boolean => wire.http.some(o => o.path === "/YamahaRemoteControl/ctrl");

  test("skips the transports the description does not advertise — YNCA never", async () => {
    wire.tcp.length = 0;
    wire.http.length = 0;
    const debugs: string[] = [];
    await attemptDevice(
      { id: "wx", ip: "192.168.1.10", source: "discovered", services: { yxc: true, xml: false } },
      depsWith(debugs),
    );
    expect(wire.tcp).toContainEqual({ host: "192.168.1.10", port: 50000 }); // YNCA always
    expect(yxcTried()).toBe(true);
    expect(xmlTried()).toBe(false);
    expect(debugs).toContainEqual(expect.stringContaining("wx/xml: not advertised by the device — skipped"));
  });

  test("advertised XML without MusicCast: XML is tried, MusicCast skipped", async () => {
    wire.tcp.length = 0;
    wire.http.length = 0;
    const debugs: string[] = [];
    await attemptDevice(
      { id: "old", ip: "192.168.1.10", source: "discovered", services: { yxc: false, xml: true } },
      depsWith(debugs),
    );
    expect(xmlTried()).toBe(true);
    expect(yxcTried()).toBe(false);
    expect(debugs).toContainEqual(expect.stringContaining("old/yxc: not advertised by the device — skipped"));
  });

  test("without services every transport is tried", async () => {
    wire.tcp.length = 0;
    wire.http.length = 0;
    await attemptDevice({ id: "rx", ip: "192.168.1.10", source: "manual" }, depsWith([]));
    expect(wire.tcp).toContainEqual({ host: "192.168.1.10", port: 50000 });
    expect(yxcTried()).toBe(true);
    expect(xmlTried()).toBe(true);
  });

  test("a description that advertises neither service still tries YNCA", async () => {
    wire.tcp.length = 0;
    wire.http.length = 0;
    await attemptDevice(
      { id: "old", ip: "192.168.1.10", source: "discovered", services: { yxc: false, xml: false } },
      depsWith([]),
    );
    expect(wire.tcp).toContainEqual({ host: "192.168.1.10", port: 50000 });
    expect(wire.http).toEqual([]);
  });

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

    // Nothing answered — the device is simply not reachable this attempt. Not a warning.
    expect(result).toBeNull();
    expect(warns).toEqual([]);
    // YNCA is a held TCP connection on 50000 …
    expect(wire.tcp).toContainEqual({ host: "192.168.1.10", port: 50000 });
    // … while YXC and XML both speak HTTP on 80, XML on the control endpoint.
    expect(wire.http.some(o => o.port === 80 && o.path === "/YamahaRemoteControl/ctrl")).toBe(true);
    expect(
      wire.http.some(o =>
        (typeof o.url === "string" ? o.url : typeof o.host === "string" ? o.host : "").includes("192.168.1.10"),
      ),
    ).toBe(true);
  });
});
