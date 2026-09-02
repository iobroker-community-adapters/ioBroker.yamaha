import { vi } from "vitest";
import type * as OsModule from "node:os";

/**
 * Orchestration tests for the adapter lifecycle. `@iobroker/adapter-core` is
 * stubbed with a minimal Adapter base class carrying in-memory object/state
 * stores; the two network-facing collaborators (the per-device transport attempt
 * and the SSDP discovery) are module-mocked, as is the discovered-devices file
 * store. The supervisor, the backoff and the pure helpers all run for real.
 */
vi.mock("@iobroker/adapter-core", () => {
  class Adapter {
    public log = { silly: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    public namespace = "yamaha.0";
    public version = "0.0.0-test";
    public adapterDir = "/tmp/yamaha";
    public config: Record<string, unknown> = {};
    public objects = new Map<string, Record<string, unknown>>();
    public states = new Map<string, { val: unknown; ack: boolean }>();
    public foreignObjects = new Map<string, Record<string, unknown>>();
    public subscribed: string[] = [];
    public on = vi.fn();
    /** When set, every setState rejects with it — a states database that is not reachable. */
    public setStateFail: Error | null = null;
    /** When set, every extendObject rejects with it — an objects database that is not reachable. */
    public extendObjectFail: Error | null = null;
    private key(id: string): string {
      return id.replace(`${this.namespace}.`, "");
    }
    public setState = vi.fn((id: string, state: unknown) => {
      if (this.setStateFail) {
        return Promise.reject(this.setStateFail);
      }
      const s = state as { val?: unknown; ack?: boolean };
      this.states.set(this.key(id), { val: s?.val, ack: s?.ack === true });
      return Promise.resolve();
    });
    public extendObject = vi.fn((id: string, obj: Record<string, unknown>) => {
      if (this.extendObjectFail) {
        return Promise.reject(this.extendObjectFail);
      }
      const k = this.key(id);
      const prev = this.objects.get(k) ?? {};
      this.objects.set(k, {
        ...prev,
        ...obj,
        common: { ...(prev.common ?? {}), ...(obj.common ?? {}) },
        native: { ...(prev.native ?? {}), ...(obj.native ?? {}) },
      });
      return Promise.resolve();
    });
    public setObjectNotExistsAsync = vi.fn((id: string, obj: Record<string, unknown>) => {
      if (!this.objects.has(this.key(id))) {
        this.objects.set(this.key(id), obj);
      }
      return Promise.resolve();
    });
    public getObjectAsync = vi.fn((id: string) => Promise.resolve(this.objects.get(this.key(id)) ?? null));
    public getAdapterObjectsAsync = vi.fn(() => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of this.objects) {
        out[`${this.namespace}.${k}`] = v;
      }
      return Promise.resolve(out);
    });
    public delObjectAsync = vi.fn((id: string, options?: { recursive?: boolean }) => {
      const key = this.key(id);
      this.objects.delete(key);
      if (options?.recursive) {
        for (const existing of [...this.objects.keys()]) {
          if (existing.startsWith(`${key}.`)) {
            this.objects.delete(existing);
          }
        }
      }
      return Promise.resolve();
    });
    public getStatesAsync = vi.fn(() => {
      const out: Record<string, { val: unknown; ack: boolean }> = {};
      for (const [k, v] of this.states) {
        out[`${this.namespace}.${k}`] = v;
      }
      return Promise.resolve(out);
    });
    public getForeignObjectAsync = vi.fn((id: string) => Promise.resolve(this.foreignObjects.get(id) ?? null));
    public setForeignObjectAsync = vi.fn((id: string, obj: Record<string, unknown>) => {
      this.foreignObjects.set(id, obj);
      return Promise.resolve();
    });
    public extendForeignObjectAsync = vi.fn((id: string, patch: Record<string, unknown>) => {
      const prev = this.foreignObjects.get(id) ?? {};
      this.foreignObjects.set(id, {
        ...prev,
        native: { ...(prev.native ?? {}), ...(patch.native ?? {}) },
      });
      return Promise.resolve();
    });
    /**
     * The adapter subscribes through the awaited `…Async` form so a rejection cannot become an
     * unhandled one (js-controller turns those into an adapter stop). `subscribeFails` lets a
     * test drive that rejection path.
     */
    public subscribeFails: Error | undefined;
    public subscribeStatesAsync = vi.fn((pattern: string) => {
      if (this.subscribeFails) {
        return Promise.reject(this.subscribeFails);
      }
      this.subscribed.push(pattern);
      return Promise.resolve();
    });
    public setTimeout = vi.fn((_cb: () => void, _ms: number) => ({ kind: "timeout" }));
    public clearTimeout = vi.fn();
    public setInterval = vi.fn(() => ({ kind: "interval" }));
    public clearInterval = vi.fn();
    constructor(_opts: unknown) {}
  }
  return {
    Adapter,
    I18n: { init: vi.fn(() => Promise.resolve(undefined)) },
    getAbsoluteInstanceDataDir: () => "/tmp/yamaha-data",
  };
});

const mocks = vi.hoisted(() => ({
  attemptDevice: vi.fn(),
  discoverYamaha: vi.fn((_deps?: unknown) => Promise.resolve([] as Array<{ ip: string; name: string }>)),
  discoveredStore: { devices: [] as Array<{ id: string; ip: string }>, ignored: [] as string[] },
  pushReceivers: [] as Array<{
    start: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    registered: string[];
  }>,
}));
vi.mock("./lib/attempt-device", () => ({ attemptDevice: mocks.attemptDevice }));
vi.mock("./lib/discovery", () => ({ discoverYamaha: mocks.discoverYamaha }));
vi.mock("./lib/discovered-store", () => ({
  readDiscovered: vi.fn(() => Promise.resolve(mocks.discoveredStore.devices)),
  writeDiscovered: vi.fn((_d: unknown, devices: Array<{ id: string; ip: string }>) => {
    mocks.discoveredStore.devices = devices;
    return Promise.resolve();
  }),
  readIgnored: vi.fn(() => Promise.resolve(mocks.discoveredStore.ignored)),
  writeIgnored: vi.fn((_d: unknown, ids: string[]) => {
    mocks.discoveredStore.ignored = [...ids];
    return Promise.resolve();
  }),
}));
vi.mock("./lib/discovered-store-deps", () => ({
  discoveredStoreDeps: () => ({}),
  ignoredStoreDeps: () => ({}),
}));

/** A fake dgram + http pair, so the SSDP search and the description fetch are testable. */
const net = vi.hoisted(() => {
  interface FakeSocket {
    bindAddr: string | undefined;
    mcastIf: string[];
    sent: Array<{ msg: string; port: number; address: string }>;
    closed: number;
    handlers: Record<string, Array<(...a: unknown[]) => void>>;
    on: (ev: string, cb: (...a: unknown[]) => void) => FakeSocket;
    bind: (port: number, addr: string | undefined, cb?: () => void) => void;
    setMulticastInterface: (iface: string) => void;
    send: (msg: string, port: number, address: string) => void;
    close: () => void;
    emit: (ev: string, ...args: unknown[]) => void;
  }
  const sockets: FakeSocket[] = [];
  const fail = { bind: false, mcastIf: false, send: false, close: false };
  const interfaces: { value: Record<string, unknown[]> | null } = { value: null };
  const httpCalls: string[] = [];
  const http = {
    body: "<root/>",
    error: null as Error | null,
    lastReq: null as { timeoutMs?: number; destroyed?: Error } | null,
  };
  const createSocket = (): FakeSocket => {
    const s: FakeSocket = {
      bindAddr: undefined,
      mcastIf: [],
      sent: [],
      closed: 0,
      handlers: {},
      on: (ev, cb) => {
        (s.handlers[ev] ??= []).push(cb);
        return s;
      },
      bind: (_port, addr, cb) => {
        s.bindAddr = addr;
        if (fail.bind) {
          s.emit("error", new Error("EADDRNOTAVAIL"));
          return;
        }
        cb?.();
      },
      setMulticastInterface: iface => {
        if (fail.mcastIf) {
          throw new Error("EINVAL");
        }
        s.mcastIf.push(iface);
      },
      send: (msg, port, address) => {
        if (fail.send) {
          throw new Error("ENETUNREACH");
        }
        s.sent.push({ msg, port, address });
      },
      close: () => {
        if (fail.close) {
          throw new Error("ERR_SOCKET_DGRAM_NOT_RUNNING");
        }
        s.closed++;
      },
      emit: (ev, ...args) => (s.handlers[ev] ?? []).forEach(h => h(...args)),
    };
    sockets.push(s);
    return s;
  };
  return { sockets, fail, interfaces, createSocket, http, httpCalls };
});
vi.mock("node:dgram", () => ({ createSocket: () => net.createSocket() }));
vi.mock("node:os", async importOriginal => {
  const actual = await importOriginal<typeof OsModule>();
  const networkInterfaces = (): unknown => net.interfaces.value ?? actual.networkInterfaces();
  return { ...actual, default: { ...actual, networkInterfaces }, networkInterfaces };
});
vi.mock("node:http", () => ({
  get: (url: string, cb: (res: unknown) => void) => {
    net.httpCalls.push(url);
    const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    const req = {
      on: (ev: string, h: (...a: unknown[]) => void) => {
        (handlers[ev] ??= []).push(h);
        return req;
      },
      setTimeout: (ms: number, onTimeout: () => void) => {
        net.http.lastReq = { timeoutMs: ms };
        if (net.http.error?.message === "timeout") {
          onTimeout();
        }
      },
      destroy: (e: Error) => {
        net.http.lastReq = { ...(net.http.lastReq ?? {}), destroyed: e };
        (handlers.error ?? []).forEach(h => h(e));
      },
    };
    queueMicrotask(() => {
      if (net.http.error && net.http.error.message !== "timeout") {
        (handlers.error ?? []).forEach(h => h(net.http.error));
        return;
      }
      if (net.http.error?.message === "timeout") {
        return;
      }
      const resHandlers: Record<string, Array<(...a: unknown[]) => void>> = {};
      cb({
        on: (ev: string, h: (...a: unknown[]) => void) => {
          (resHandlers[ev] ??= []).push(h);
          if (ev === "end") {
            (resHandlers.data ?? []).forEach(d => d(net.http.body));
            h();
          }
        },
        // A destroyed response stream reports through its own error handler, like node's.
        destroy: (e: Error) => (resHandlers.error ?? []).forEach(h => h(e)),
      });
    });
    return req;
  },
}));
vi.mock("./lib/yxc/push-receiver", () => ({
  YxcPushReceiver: class {
    public start = vi.fn();
    public close = vi.fn();
    public registered: string[] = [];
    public register = vi.fn((ip: string) => {
      this.registered.push(ip);
      return () => undefined;
    });
    constructor(_deps: unknown) {
      mocks.pushReceivers.push(this);
    }
  },
}));

import { Yamaha } from "./main";
import { iconForModel } from "./lib/device-type";
import { MAX_HTTP_BODY_BYTES } from "./lib/util";
import { writeDiscovered } from "./lib/discovered-store";
import type { ConnectionHandle } from "./lib/controller";

/** A live connection handle the fake attempt hands back. */
interface FakeHandle extends ConnectionHandle {
  drop(reason?: Error): void;
  changes: Array<{ id: string; ack: boolean; value: unknown }>;
  closed: number;
}
function fakeHandle(): FakeHandle {
  let onDrop: (reason?: Error) => void = () => undefined;
  const h: FakeHandle = {
    changes: [],
    closed: 0,
    onDrop: cb => {
      onDrop = cb;
    },
    handleStateChange: (id, ack, value) => h.changes.push({ id, ack, value }),
    close: () => {
      h.closed++;
    },
    drop: reason => onDrop(reason),
  };
  return h;
}

/**
 * Typed access to the private members the orchestration tests drive.
 *
 * @param adapter Adapter instance under test
 */
function internalOf(adapter: Yamaha): {
  onReady(): Promise<void>;
  onUnload(cb: () => void): void;
  onStateChange(id: string, state: unknown): void;
  reportConnection(deviceId: string, connected: boolean): void;
  removeDevice(deviceId: string): Promise<void>;
  xmlPollIntervalMs(): number;
  objects: Map<string, Record<string, unknown>>;
  states: Map<string, { val: unknown; ack: boolean }>;
  foreignObjects: Map<string, Record<string, unknown>>;
  config: Record<string, unknown>;
  subscribed: string[];
  subscribeFails: Error | undefined;
  setStateFail: Error | null;
  extendObjectFail: Error | null;
  log: Record<"debug" | "info" | "warn" | "error", ReturnType<typeof vi.fn>>;
  setTimeout: ReturnType<typeof vi.fn>;
  clearTimeout: ReturnType<typeof vi.fn>;
  setInterval: ReturnType<typeof vi.fn>;
  clearInterval: ReturnType<typeof vi.fn>;
} {
  return adapter as never;
}

/** Options passed to the fake attempt for one call. */
interface AttemptCall {
  device: { id: string; ip: string };
  deps: Record<string, (...a: never[]) => unknown> & { xmlPollIntervalMs: number; knownDeviceIps: Set<string> };
}

interface Ctx {
  i: ReturnType<typeof internalOf>;
  calls: AttemptCall[];
  handles: FakeHandle[];
}

/**
 * Build an adapter with a config and a fake per-device attempt.
 *
 * @param config native config fields for this run
 * @param opts   which device ids fail to connect or never answer
 * @param opts.failIds Device ids whose fake attempt reports failure
 * @param opts.hangIds Device ids whose fake attempt never answers (stays pending)
 */
function setup(config: Record<string, unknown> = {}, opts: { failIds?: string[]; hangIds?: string[] } = {}): Ctx {
  const i = internalOf(new Yamaha());
  i.config = { devices: [{ name: "Living room", ip: "192.168.1.10" }], ...config };
  const calls: AttemptCall[] = [];
  const handles: FakeHandle[] = [];
  mocks.attemptDevice.mockImplementation((device: AttemptCall["device"], deps: AttemptCall["deps"]) => {
    calls.push({ device, deps });
    if (opts.failIds?.includes(device.id)) {
      return Promise.resolve(null);
    }
    if (opts.hangIds?.includes(device.id)) {
      return new Promise<null>(() => undefined); // an attempt that never answers
    }
    const h = fakeHandle();
    handles.push(h);
    return Promise.resolve(h);
  });
  return { i, calls, handles };
}

/** Let the supervisor's async attempt chain settle. */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.discoveredStore.devices = [];
  mocks.discoveredStore.ignored = [];
  mocks.pushReceivers.length = 0;
  mocks.discoverYamaha.mockResolvedValue([]);
  net.sockets.length = 0;
  net.httpCalls.length = 0;
  Object.keys(net.fail).forEach(k => ((net.fail as Record<string, boolean>)[k] = false));
  net.interfaces.value = null;
  net.http.body = "<root/>";
  net.http.error = null;
  net.http.lastReq = null;
});

describe("Yamaha onReady — configured devices", () => {
  it("creates each device's header objects and connects it", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await flush();

    expect(ctx.i.objects.get("Living_room")?.type).toBe("device");
    // statusStates.onlineId is what paints the green/red dot on the device node.
    expect((ctx.i.objects.get("Living_room")?.common as { statusStates?: unknown }).statusStates).toEqual({
      onlineId: "yamaha.0.Living_room.info.connection",
    });
    for (const id of [
      "Living_room.info",
      "Living_room.info.connection",
      "Living_room.info.model",
      "Living_room.info.transports",
    ]) {
      expect(ctx.i.objects.has(id)).toBe(true);
    }
    // All three protocol flags exist even for a device that never connects, so the
    // manager card renders instead of showing nothing.
    for (const proto of ["ynca", "yxc", "xml"]) {
      expect(ctx.i.objects.has(`Living_room.info.transports.${proto}`)).toBe(true);
    }
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.i.states.get("Living_room.info.connection")).toEqual({ val: true, ack: true });
    expect(ctx.i.states.get("info.connection")).toEqual({ val: true, ack: true });
    expect(ctx.i.subscribed).toEqual(["*"]);
  });

  it("survives a failing state subscription and still brings the devices up", async () => {
    // subscribeStates without a callback returns a promise, and its wildcard branch rejects for
    // anything but a plain closed database (js-controller-common-db `maybeCallbackWithError`).
    // Unawaited that is an unhandled rejection — and js-controller stops the instance for those.
    const ctx = setup();
    ctx.i.subscribeFails = new Error("objects db unreachable");
    await ctx.i.onReady();
    await flush();

    // Loud, not fatal: the device still connects and its tree still fills.
    const errors = ctx.i.log.error.mock.calls.map(call => String(call[0]));
    expect(errors.some(line => line.includes("could not subscribe to state changes"))).toBe(true);
    expect(ctx.i.states.get("Living_room.info.connection")).toEqual({ val: true, ack: true });
    expect(ctx.calls).toHaveLength(1);
  });

  it("does not overwrite a name the user changed on the device object", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    const call = (ctx.i as unknown as { extendObject: ReturnType<typeof vi.fn> }).extendObject.mock.calls.find(
      c => c[0] === "Living_room",
    );
    expect(call?.[2]).toEqual({ preserve: { common: ["name"] } });
  });

  it("skips a configured row whose object id is already taken", async () => {
    const ctx = setup({
      devices: [
        { name: "Living room", ip: "192.168.1.10" },
        { name: "Living*room", ip: "192.168.1.11" },
      ],
    });
    await ctx.i.onReady();
    await flush();
    // Two devices on one object tree would overwrite each other's values.
    expect(ctx.calls.map(c => c.device.ip)).toEqual(["192.168.1.10"]);
    expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("already used by another device"));
  });

  it("reports the adapter connected while ANY device is connected", async () => {
    const ctx = setup(
      {
        devices: [
          { name: "A", ip: "192.168.1.10" },
          { name: "B", ip: "192.168.1.11" },
        ],
      },
      { failIds: ["B"] },
    );
    await ctx.i.onReady();
    await flush();
    expect(ctx.i.states.get("info.connection")).toEqual({ val: true, ack: true });

    ctx.i.reportConnection("A", false);
    // One receiver in standby must not make the whole instance look broken — and
    // the last one going away must.
    expect(ctx.i.states.get("info.connection")).toEqual({ val: false, ack: true });
  });

  it("clears the protocol flags when a device drops", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await flush();
    const onTransports = ctx.calls[0].deps.onTransports as (names: string[]) => void;
    onTransports(["ynca", "yxc"]);
    expect(ctx.i.states.get("Living_room.info.transports.ynca")).toEqual({ val: true, ack: true });
    expect(ctx.i.states.get("Living_room.info.transports.xml")).toEqual({ val: false, ack: true });

    ctx.handles[0].drop(new Error("socket closed"));
    await flush();
    // Stale "connected" badges on a card for a receiver that is gone are worse
    // than none — the user trusts them.
    expect(ctx.i.states.get("Living_room.info.transports.ynca")).toEqual({ val: false, ack: true });
  });

  it("reports a failing start-up instead of dying on an unhandled rejection", async () => {
    const ctx = setup();
    (ctx.i as unknown as { getAdapterObjectsAsync: ReturnType<typeof vi.fn> }).getAdapterObjectsAsync.mockRejectedValue(
      new Error("objects db down"),
    );
    await expect(ctx.i.onReady()).resolves.toBeUndefined();
    expect(ctx.i.log.error).toHaveBeenCalledWith(expect.stringContaining("onReady failed: objects db down"));
  });

  it("gives every object a name in all eleven languages, never a plain string", async () => {
    // ioBroker resolves a translation object into the reader's language itself; a plain string
    // would freeze the tree in one language (core-team line, nut2 #15).
    const ctx = setup();
    await ctx.i.onReady();
    await flush();
    const name = (ctx.i.objects.get("Living_room.info.model")?.common as { name?: unknown }).name as Record<
      string,
      string
    >;
    expect(typeof name).toBe("object");
    expect(name.en).toBe("Model");
    expect(name.de).toBe("Modell");
    expect(Object.keys(name)).toHaveLength(11);
  });
});

describe("Yamaha auto-discovery", () => {
  it("scans when the device table is empty and remembers what it found", async () => {
    mocks.discoverYamaha.mockResolvedValue([{ ip: "192.168.1.20", name: "RX-V685" }]);
    const ctx = setup({ devices: [] });
    await ctx.i.onReady();
    await flush();
    expect(ctx.calls.map(c => c.device.ip)).toEqual(["192.168.1.20"]);
    // Persisting the find is the standby protection: a receiver that is off during
    // the next start would otherwise disappear from the tree.
    expect(writeDiscovered).toHaveBeenCalledWith({}, [expect.objectContaining({ ip: "192.168.1.20" })]);
  });

  it("moves a remembered device that now answers at another address instead of losing it", async () => {
    // DHCP moved the receiver. Keyed by address the merge dropped the find as an id clash and
    // the device stayed offline for good — the id, not the address, is the device.
    mocks.discoveredStore.devices = [{ id: "RX-V685", ip: "192.168.1.20" }];
    mocks.discoverYamaha.mockResolvedValue([{ ip: "192.168.1.99", name: "RX-V685" }]);
    const ctx = setup({ devices: [] });
    await ctx.i.onReady();
    await flush();
    expect(ctx.calls.map(c => c.device.ip)).toEqual(["192.168.1.20", "192.168.1.99"]);
    expect(ctx.i.log.info).toHaveBeenCalledWith(expect.stringContaining("address changed"));
    // The tree stays where it is — same id, same history, same bindings.
    expect(ctx.calls.map(c => c.device.id)).toEqual(["RX-V685", "RX-V685"]);
    // And the old address stops being offered as a multiroom link target.
    expect([...ctx.calls[1].deps.knownDeviceIps]).toEqual(["192.168.1.99"]);
  });

  it("leaves a rediscovered device alone while its address is unchanged", async () => {
    mocks.discoveredStore.devices = [{ id: "RX-V685", ip: "192.168.1.20" }];
    mocks.discoverYamaha.mockResolvedValue([{ ip: "192.168.1.20", name: "RX-V685" }]);
    const ctx = setup({ devices: [] });
    await ctx.i.onReady();
    await flush();
    expect(ctx.calls).toHaveLength(1);
  });

  it("does not set up a device the user deleted from the card list", async () => {
    mocks.discoveredStore.ignored = ["RX-V685"];
    mocks.discoverYamaha.mockResolvedValue([{ ip: "192.168.1.20", name: "RX-V685" }]);
    const ctx = setup({ devices: [] });
    await ctx.i.onReady();
    await flush();
    expect(ctx.calls).toHaveLength(0);
    // The exclusion also keeps it out of the remembered list, so nothing resurrects it later.
    expect(mocks.discoveredStore.devices).toEqual([]);
  });

  it("removeDevice stops the supervisor, drops the tree and updates the overview", async () => {
    mocks.discoveredStore.devices = [{ id: "RX-V685", ip: "192.168.1.20" }];
    const ctx = setup({ devices: [] });
    await ctx.i.onReady();
    await flush();
    ctx.i.objects.set("RX-V685.player.track", { type: "state", common: {}, native: {} });
    expect(ctx.i.states.get("info.devicesTotal")).toEqual({ val: 1, ack: true });

    await ctx.i.removeDevice("RX-V685");

    // The connection goes with it — a deleted device may not keep a supervisor running.
    expect(ctx.handles[0].closed).toBeGreaterThan(0);
    expect(ctx.i.objects.has("RX-V685")).toBe(false);
    expect(ctx.i.objects.has("RX-V685.player.track")).toBe(false);
    expect(ctx.i.states.get("info.devicesTotal")).toEqual({ val: 0, ack: true });
    expect(ctx.i.states.get("info.connection")).toEqual({ val: false, ack: true });
  });

  it("arms one throttled search while an auto-found device is offline", async () => {
    mocks.discoveredStore.devices = [{ id: "RX-V685", ip: "192.168.1.20" }];
    const ctx = setup({ devices: [] }, { failIds: ["RX-V685"] });
    await ctx.i.onReady();
    await flush();
    // Armed, and waiting out the throttle after the start-up search — not scanning at once.
    const armed = (): unknown[] => ctx.i.setTimeout.mock.calls.filter(c => Number(c[1]) > 200000);
    expect(armed()).toHaveLength(1);
    // A second drop must not stack a second search on top of the armed one.
    ctx.i.reportConnection("RX-V685", false);
    expect(armed()).toHaveLength(1);
  });

  it("keeps running the remembered devices when the scan itself fails", async () => {
    mocks.discoveredStore.devices = [{ id: "RX-V685", ip: "192.168.1.20" }];
    mocks.discoverYamaha.mockRejectedValue(new Error("no route to multicast"));
    const ctx = setup({ devices: [] });
    await ctx.i.onReady();
    await flush();
    expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("auto-discovery scan failed"));
    expect(ctx.calls.map(c => c.device.ip)).toEqual(["192.168.1.20"]);
  });

  it("does not scan at all when devices are configured", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await flush();
    // A configured table is the user's explicit choice; scanning past it would
    // add devices they deliberately left out.
    expect(mocks.discoverYamaha).not.toHaveBeenCalled();
  });

  it("starts remembered devices without waiting for the search, and adds what it finds", async () => {
    mocks.discoveredStore.devices = [{ id: "RX-V685", ip: "192.168.1.20" }];
    mocks.discoverYamaha.mockResolvedValue([{ ip: "192.168.1.21", name: "WX-021" }]);
    const ctx = setup({ devices: [] });
    await ctx.i.onReady();
    // The remembered device is already under supervision before the search settles —
    // its collect window used to gate every restart although the device was known.
    expect(ctx.calls.map(c => c.device.ip)).toContain("192.168.1.20");
    expect(ctx.i.log.info).toHaveBeenCalledWith(expect.stringContaining("network search runs in the background"));
    await flush();
    // The background search then brings the newcomer online in the running instance.
    expect(ctx.calls.map(c => c.device.ip)).toContain("192.168.1.21");
    expect(mocks.discoverYamaha).toHaveBeenCalled();
  });
});

describe("Yamaha migrations", () => {
  it("carries the previous adapter's single device over into the table", async () => {
    const ctx = setup({ devices: [], ip: "192.168.1.30" });
    ctx.i.foreignObjects.set("system.adapter.yamaha.0", { native: {} });
    await ctx.i.onReady();
    await flush();
    // Without this an upgraded instance starts with an empty table and silently
    // stops driving the receiver it had.
    expect(ctx.calls.map(c => c.device.ip)).toEqual(["192.168.1.30"]);
    expect(
      (ctx.i.foreignObjects.get("system.adapter.yamaha.0")?.native as { devices?: unknown[] }).devices,
    ).toHaveLength(1);
    expect(mocks.discoverYamaha).not.toHaveBeenCalled();
  });

  it("runs the migrated device even when the table cannot be persisted", async () => {
    const ctx = setup({ devices: [], ip: "192.168.1.30" });
    (
      ctx.i as unknown as { extendForeignObjectAsync: ReturnType<typeof vi.fn> }
    ).extendForeignObjectAsync.mockRejectedValue(new Error("objects db read-only"));
    await ctx.i.onReady();
    await flush();
    // Persisting is a convenience for the admin view, not a precondition.
    expect(ctx.calls.map(c => c.device.ip)).toEqual(["192.168.1.30"]);
    expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("could not persist the migrated device table"));
  });

  it("folds the removed zones toggle into the multiroom group", async () => {
    const ctx = setup({ group_zones: true, group_multiroom: false });
    ctx.i.foreignObjects.set("system.adapter.yamaha.0", {
      native: { group_zones: true, group_multiroom: false },
    });
    await ctx.i.onReady();
    await flush();
    // Users who had zones on but multiroom off would otherwise lose every zone
    // datapoint on the update.
    expect(ctx.i.config.group_multiroom).toBe(true);
    expect("group_zones" in ctx.i.config).toBe(false);
    const native = ctx.i.foreignObjects.get("system.adapter.yamaha.0")?.native as Record<string, unknown>;
    expect(native.group_multiroom).toBe(true);
    expect("group_zones" in native).toBe(false);
  });

  it("leaves multiroom alone when zones were off", async () => {
    const ctx = setup({ group_zones: false, group_multiroom: false });
    ctx.i.foreignObjects.set("system.adapter.yamaha.0", { native: { group_zones: false, group_multiroom: false } });
    await ctx.i.onReady();
    expect(ctx.i.config.group_multiroom).toBe(false);
    const native = ctx.i.foreignObjects.get("system.adapter.yamaha.0")?.native as Record<string, unknown>;
    expect(native.group_multiroom).toBe(false);
  });

  it("does not rewrite the instance object when the zones toggle was never there", async () => {
    const ctx = setup();
    ctx.i.foreignObjects.set("system.adapter.yamaha.0", { native: { group_multiroom: true } });
    await ctx.i.onReady();
    // Writing an instance object's native RESTARTS the adapter. Running the
    // migration unconditionally would restart the instance on every single start.
    expect(
      (ctx.i as unknown as { setForeignObjectAsync: ReturnType<typeof vi.fn> }).setForeignObjectAsync,
    ).not.toHaveBeenCalled();
    expect(ctx.i.log.info).not.toHaveBeenCalledWith(expect.stringContaining("migrated group_zones"));
  });
});

describe("Yamaha stale-object cleanup", () => {
  it("removes the tree of a device that is no longer configured", async () => {
    const ctx = setup();
    ctx.i.objects.set("Old_device", { type: "device", common: {}, native: {} });
    ctx.i.objects.set("Old_device.info.connection", { type: "state", common: {}, native: {} });
    await ctx.i.onReady();
    await flush();
    expect(ctx.i.objects.has("Old_device")).toBe(false);
    expect(ctx.i.objects.has("Old_device.info.connection")).toBe(false);
    expect(ctx.i.log.debug).toHaveBeenCalledWith(expect.stringContaining("from a previous configuration"));
  });

  it("keeps a configured device's tree even before it connects", async () => {
    const ctx = setup({ devices: [{ name: "Living room", ip: "192.168.1.10" }] }, { failIds: ["Living room"] });
    ctx.i.objects.set("Living_room.main.power", { type: "state", common: {}, native: {} });
    await ctx.i.onReady();
    await flush();
    expect(ctx.i.objects.has("Living_room.main.power")).toBe(true);
  });

  it("removes the objects of a datapoint group the user switched off", async () => {
    const ctx = setup({ group_multiroom: false });
    ctx.i.objects.set("Living_room.multiroom.group.name", { type: "state", common: {}, native: {} });
    await ctx.i.onReady();
    await flush();
    // Turning a group off has to clean up its whole subtree — leftovers would keep
    // showing values that stopped updating.
    expect(ctx.i.objects.has("Living_room.multiroom.group.name")).toBe(false);
    expect(ctx.i.log.debug).toHaveBeenCalledWith(expect.stringContaining("switched-off datapoint groups"));
  });

  it("says nothing when there was nothing to remove", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await flush();
    for (const phrase of ["previous configuration", "renamed object", "switched-off datapoint groups"]) {
      expect(ctx.i.log.debug).not.toHaveBeenCalledWith(expect.stringContaining(phrase));
    }
  });

  it("keeps cleaning up when one object cannot be deleted", async () => {
    const ctx = setup();
    ctx.i.objects.set("Old_a", { type: "device", common: {}, native: {} });
    ctx.i.objects.set("Old_b", { type: "device", common: {}, native: {} });
    const del = (ctx.i as unknown as { delObjectAsync: ReturnType<typeof vi.fn> }).delObjectAsync;
    const real = del.getMockImplementation() as (id: string) => Promise<void>;
    del.mockImplementation(async (id: string) => {
      if (id === "Old_a") {
        throw new Error("already gone with its parent");
      }
      return real(id);
    });
    await ctx.i.onReady();
    await flush();
    expect(ctx.i.objects.has("Old_b")).toBe(false);
    expect(ctx.calls).toHaveLength(1);
  });
});

describe("Yamaha datapoint balance in the log", () => {
  /**
   * Fire the settle timer the balance line waits on.
   *
   * @param ctx the test context
   * @param ctx.i Adapter internals with the mocked timer
   * @param ctx.i.setTimeout The mocked setTimeout whose 5 s call is fired
   */
  const settle = async (ctx: { i: { setTimeout: ReturnType<typeof vi.fn> } }): Promise<void> => {
    const call = ctx.i.setTimeout.mock.calls.filter(c => c[1] === 5000).at(-1);
    (call?.[0] as (() => void) | undefined)?.();
    // The settle callback awaits the orphan purge before logging the line.
    await flush();
  };

  /**
   * The adapter's real object-creation path, as a connected transport uses it.
   *
   * @param ctx the test context
   * @param ctx.calls Recorded attempt calls, the first carries the deps
   * @returns the upsert callback
   */
  const upsertOf = (ctx: {
    calls: Array<{ deps: Record<string, unknown> }>;
  }): ((id: string, def: unknown) => Promise<void>) =>
    ctx.calls[0].deps.upsertObject as (id: string, def: unknown) => Promise<void>;

  it("reports the datapoints a device brought into the tree", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await flush();
    const upsert = upsertOf(ctx);
    await upsert("Living_room.main.power", { type: "state", common: { name: "p" } });
    await upsert("Living_room.volume", { type: "state", common: { name: "v" } });
    await settle(ctx);
    expect(ctx.i.log.info).toHaveBeenCalledWith("Object tree updated: created 2 datapoint(s)");
  });

  it("stays silent on a restart that changed nothing", async () => {
    const ctx = setup();
    ctx.i.objects.set("Living_room.main.power", { type: "state", common: {}, native: {} });
    await ctx.i.onReady();
    await flush();
    await upsertOf(ctx)("Living_room.main.power", { type: "state", common: { name: "p" } });
    await settle(ctx);
    // The datapoint already existed, so touching it again is not a change. Without the
    // start-up snapshot this would report the whole tree as new on every restart.
    expect(ctx.i.log.info).not.toHaveBeenCalledWith(expect.stringContaining("Object tree updated"));
  });

  it("counts a datapoint once, however often the tree touches it again", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await flush();
    const upsert = upsertOf(ctx);
    await upsert("Living_room.main.power", { type: "state", common: { name: "p" } });
    // Every state runs through extendObject again on a reconnect (the role/unit retrofit).
    await upsert("Living_room.main.power", { type: "state", common: { name: "p" } });
    await settle(ctx);
    expect(ctx.i.log.info).toHaveBeenCalledWith("Object tree updated: created 1 datapoint(s)");
  });

  it("puts removals and additions into one line", async () => {
    const ctx = setup();
    ctx.i.objects.set("Old_device", { type: "device", common: {}, native: {} });
    ctx.i.objects.set("Old_device.volume", { type: "state", common: {}, native: {} });
    await ctx.i.onReady();
    await flush();
    await upsertOf(ctx)("Living_room.main.power", { type: "state", common: { name: "p" } });
    await settle(ctx);
    // The user made ONE change, so they read ONE result — not a removal line now and an
    // addition line later.
    expect(ctx.i.log.info).toHaveBeenCalledWith("Object tree updated: created 1 datapoint(s), removed 1 datapoint(s)");
  });

  it("counts only datapoints, not the channels and device nodes around them", async () => {
    const ctx = setup();
    ctx.i.objects.set("Old_device", { type: "device", common: {}, native: {} });
    ctx.i.objects.set("Old_device.player", { type: "channel", common: {}, native: {} });
    ctx.i.objects.set("Old_device.player.volume", { type: "state", common: {}, native: {} });
    await ctx.i.onReady();
    await flush();
    await upsertOf(ctx)("Living_room.player", { type: "channel", common: { name: "c" } });
    await settle(ctx);
    // Three objects go and one arrives, but the user only ever counts datapoints.
    expect(ctx.i.log.info).toHaveBeenCalledWith("Object tree updated: removed 1 datapoint(s)");
  });
});

describe("Yamaha transport plumbing", () => {
  it("gates object creation and values on the datapoint group", async () => {
    const ctx = setup({ group_multiroom: false });
    await ctx.i.onReady();
    await flush();
    const deps = ctx.calls[0].deps;
    const upsert = deps.upsertObject as (id: string, def: unknown) => Promise<void>;
    const setStateAck = deps.setStateAck as (id: string, value: unknown) => void;

    await upsert("Living_room.multiroom.group.name", { type: "state", common: { name: "n" } });
    setStateAck("Living_room.multiroom.group.name", "x");
    // A switched-off group must seed neither an object nor an orphan value.
    expect(ctx.i.objects.has("Living_room.multiroom.group.name")).toBe(false);
    expect(ctx.i.states.has("Living_room.multiroom.group.name")).toBe(false);

    await upsert("Living_room.main.power", { type: "state", common: { name: "p" } });
    setStateAck("Living_room.main.power", true);
    expect(ctx.i.objects.has("Living_room.main.power")).toBe(true);
    expect(ctx.i.states.get("Living_room.main.power")).toEqual({ val: true, ack: true });
  });

  it("paints the device-class silhouette once the model is reported", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await flush();
    const setStateAck = ctx.calls[0].deps.setStateAck as (id: string, value: unknown) => void;

    setStateAck("Living_room.info.model", "YSP-1600");
    await flush();
    const icon = (ctx.i.objects.get("Living_room")?.common as { icon?: string }).icon;
    expect(icon).toMatch(/^data:image\/svg\+xml;base64,/);

    const extend = (ctx.i as unknown as { extendObject: ReturnType<typeof vi.fn> }).extendObject;
    const before = extend.mock.calls.length;
    setStateAck("Living_room.info.model", "YSP-1600");
    await flush();
    // The model is reported on every reconnect; re-writing the object each time
    // churns the object DB for nothing.
    expect(extend.mock.calls.length).toBe(before);
  });

  it("does not read an empty or non-string model report as a model", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await flush();
    const setStateAck = ctx.calls[0].deps.setStateAck as (id: string, value: unknown) => void;
    const extend = (ctx.i as unknown as { extendObject: ReturnType<typeof vi.fn> }).extendObject;
    const before = extend.mock.calls.length;
    setStateAck("Living_room.info.model", "");
    setStateAck("Living_room.info.model", 42);
    await flush();
    // Neither report is a model, so neither the icon nor the name is touched — the node
    // keeps the default silhouette it was seeded with when it was created.
    expect(extend.mock.calls.length).toBe(before);
    expect((ctx.i.objects.get("Living_room")?.common as { icon?: string }).icon).toBe(iconForModel(undefined));
  });

  it("replaces the ip an upgraded instance carries as the device name with the model", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await flush();
    const setStateAck = ctx.calls[0].deps.setStateAck as (id: string, value: unknown) => void;
    // Fresh from the migration the node is called by its id — which is the receiver's ip.
    expect((ctx.i.objects.get("Living_room")?.common as { name?: string }).name).toBe("Living_room");
    setStateAck("Living_room.info.model", "RX-V481");
    await flush();
    expect((ctx.i.objects.get("Living_room")?.common as { name?: string }).name).toBe("RX-V481");
  });

  it("prefers the name the device reports over its model", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await flush();
    const deps = ctx.calls[0].deps as unknown as {
      setStateAck: (id: string, value: unknown) => void;
      onDeviceName?: (name: string) => void;
    };
    deps.setStateAck("Living_room.info.model", "RX-V481");
    await flush();
    deps.onDeviceName?.("Wohnzimmer");
    await flush();
    expect((ctx.i.objects.get("Living_room")?.common as { name?: string }).name).toBe("Wohnzimmer");

    // And a later model report does not drag it back to the model designation.
    deps.setStateAck("Living_room.info.model", "RX-V481");
    await flush();
    expect((ctx.i.objects.get("Living_room")?.common as { name?: string }).name).toBe("Wohnzimmer");
  });

  it("never overwrites a name the user typed", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await flush();
    const node = ctx.i.objects.get("Living_room") as { common: { name?: string } };
    node.common.name = "AVR Küche";
    const deps = ctx.calls[0].deps as unknown as {
      setStateAck: (id: string, value: unknown) => void;
      onDeviceName?: (name: string) => void;
    };
    deps.setStateAck("Living_room.info.model", "RX-V481");
    deps.onDeviceName?.("Wohnzimmer");
    await flush();
    expect((ctx.i.objects.get("Living_room")?.common as { name?: string }).name).toBe("AVR Küche");
  });

  it("seeds a device node with the default silhouette before any model is known", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await flush();
    // Without this an upgraded instance shows a device with no symbol at all until the
    // first model report, and a device that never answers keeps showing none.
    expect((ctx.i.objects.get("Living_room")?.common as { icon?: string }).icon).toBe(iconForModel(undefined));
  });

  it("hands the attempt the shared push receiver and the other devices' IPs", async () => {
    const ctx = setup({
      devices: [
        { name: "A", ip: "192.168.1.10" },
        { name: "B", ip: "192.168.1.11" },
      ],
    });
    await ctx.i.onReady();
    await flush();
    // The IP set is how a multiroom client is resolved back to a configured device.
    expect([...ctx.calls[0].deps.knownDeviceIps]).toEqual(["192.168.1.10", "192.168.1.11"]);
    expect(mocks.pushReceivers).toHaveLength(1);
    expect(mocks.pushReceivers[0].start).toHaveBeenCalledTimes(1);

    const register = ctx.calls[0].deps.registerPush as (ip: string, cb: () => void) => unknown;
    register("192.168.1.10", () => undefined);
    expect(mocks.pushReceivers[0].registered).toEqual(["192.168.1.10"]);
  });

  it("hands the attempt MANAGED timers, and a keepalive that can be cancelled", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await flush();
    const deps = ctx.calls[0].deps;
    const cb = (): void => undefined;

    (deps.timers as unknown as { schedule(c: () => void, ms: number): unknown }).schedule(cb, 10);
    expect(ctx.i.setTimeout).toHaveBeenCalledWith(cb, 10);
    const stop = (deps.scheduleKeepalive as (h: () => void, ms: number) => () => void)(cb, 20);
    expect(ctx.i.setInterval).toHaveBeenCalledWith(cb, 20);
    stop();
    // Native timers are not cleared on unload — js-controller SIGKILLs over them.
    expect(ctx.i.clearInterval).toHaveBeenCalled();
  });

  it("reads the XML poll interval from the config, with a sane floor", async () => {
    const ctx = setup({ xmlPollInterval: 15 });
    await ctx.i.onReady();
    await flush();
    expect(ctx.calls[0].deps.xmlPollIntervalMs).toBe(15_000);

    // A blank, zero or negative field must not turn into a hot loop against the receiver.
    for (const value of [undefined, "", 0, -5, "abc"]) {
      const c = setup({ xmlPollInterval: value });
      expect(c.i.xmlPollIntervalMs()).toBe(60_000);
    }
  });

  it("persists the YNCA capability probe on the DEVICE object, not the instance", async () => {
    const ctx = setup();
    ctx.i.objects.set("Living_room", {
      type: "device",
      common: {},
      native: { yncaAvail: { probedAt: 1, subunits: ["MAIN"] } },
    });
    await ctx.i.onReady();
    await flush();
    // Writing an INSTANCE object's native restarts the adapter — a probe result
    // stored there would restart the instance on every reconnect.
    expect(ctx.i.objects.get("Living_room")?.native).toMatchObject({ yncaAvail: expect.anything() });
    expect(ctx.i.foreignObjects.has("system.adapter.yamaha.0")).toBe(false);
  });

  it("ignores a capability snapshot that does not have the expected shape", async () => {
    const ctx = setup();
    ctx.i.objects.set("Living_room", { type: "device", common: {}, native: { yncaAvail: "garbage" } });
    await ctx.i.onReady();
    await flush();
    const cache = ctx.calls[0].deps.yncaSubunitCache as unknown as { get(): unknown };
    // A hand-edited or half-migrated object would otherwise make the YNCA layer
    // skip its capability probe and drive a receiver by a snapshot it invented.
    expect(cache.get()).toBeUndefined();
  });

  it("uses a well-formed capability snapshot so the probe is skipped on a reconnect", async () => {
    const ctx = setup();
    const snapshot = { subunits: ["MAIN"], model: "RX-V685", firmware: "1.93" };
    ctx.i.objects.set("Living_room", { type: "device", common: {}, native: { yncaAvail: snapshot } });
    await ctx.i.onReady();
    await flush();
    const cache = ctx.calls[0].deps.yncaSubunitCache as unknown as { get(): unknown };
    expect(cache.get()).toEqual(snapshot);
  });

  it("starts with an empty capability cache when the device object cannot be read", async () => {
    const ctx = setup();
    (ctx.i as unknown as { getObjectAsync: ReturnType<typeof vi.fn> }).getObjectAsync.mockRejectedValue(
      new Error("objects db down"),
    );
    await ctx.i.onReady();
    await flush();
    expect(ctx.calls).toHaveLength(1);
  });
});

describe("Yamaha state changes", () => {
  it("routes a write to the addressed device only", async () => {
    const ctx = setup({
      devices: [
        { name: "A", ip: "192.168.1.10" },
        { name: "B", ip: "192.168.1.11" },
      ],
    });
    await ctx.i.onReady();
    await flush();

    ctx.i.onStateChange("yamaha.0.A.main.power", { val: true, ack: false });
    // The id's first segment IS the device, so the write goes straight to its supervisor.
    // Offering every change to every device was wasted work on the hottest path: the
    // adapter subscribes to its whole namespace, so it sees each of its own acked writes
    // once per configured device.
    expect(ctx.handles[0].changes).toEqual([{ id: "A.main.power", ack: false, value: true }]);
    expect(ctx.handles[1].changes).toEqual([]);
  });

  it("ignores a deleted state", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await flush();
    ctx.i.onStateChange("yamaha.0.Living_room.main.power", null);
    ctx.i.onStateChange("yamaha.0.Living_room.main.power", undefined);
    expect(ctx.handles[0].changes).toEqual([]);
  });

  it("does not throw for a write before anything connected", () => {
    const ctx = setup({ devices: [] });
    expect(() => ctx.i.onStateChange("yamaha.0.x.y.z", { val: 1, ack: false })).not.toThrow();
  });
});

describe("Yamaha onUnload", () => {
  it("closes the push receiver and every connection, and always calls back", async () => {
    const ctx = setup({
      devices: [
        { name: "A", ip: "192.168.1.10" },
        { name: "B", ip: "192.168.1.11" },
      ],
    });
    await ctx.i.onReady();
    await flush();
    const cb = vi.fn();

    ctx.i.onUnload(cb);
    await flush();
    expect(mocks.pushReceivers[0].close).toHaveBeenCalledTimes(1);
    expect(ctx.handles.map(h => h.closed)).toEqual([1, 1]);
    expect(ctx.i.states.get("info.connection")).toEqual({ val: false, ack: true });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("takes every device marker and the overview down, callback last", async () => {
    const ctx = setup({
      devices: [
        { name: "A", ip: "192.168.1.10" },
        { name: "B", ip: "192.168.1.11" },
      ],
    });
    await ctx.i.onReady();
    await flush();
    const cb = vi.fn();

    ctx.i.onUnload(cb);
    await flush();

    // The per-device marker is what paints the symbol in the object tree — the
    // instance-wide info.connection alone leaves every device green.
    expect(ctx.i.states.get("A.info.connection")).toEqual({ val: false, ack: true });
    expect(ctx.i.states.get("B.info.connection")).toEqual({ val: false, ack: true });
    expect(ctx.i.states.get("info.devicesOnline")).toEqual({ val: 0, ack: true });
    expect(ctx.i.states.get("info.devicesAllOnline")).toEqual({ val: false, ack: true });
    // How many devices there are did not change because the adapter is off.
    expect(ctx.i.states.get("info.devicesTotal")).toEqual({ val: 2, ack: true });
  });

  it("still calls back when a teardown step throws", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await flush();
    mocks.pushReceivers[0].close.mockImplementation(() => {
      throw new Error("boom");
    });
    const cb = vi.fn();
    // A missed callback is a SIGKILL — js-controller does not wait.
    expect(() => ctx.i.onUnload(cb)).not.toThrow();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("unloads cleanly before anything was started", async () => {
    const ctx = setup();
    const cb = vi.fn();
    expect(() => ctx.i.onUnload(cb)).not.toThrow();
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("Yamaha device overview", () => {
  it("counts the devices and how many are connected, in the same round as the single markers", async () => {
    const ctx = setup(
      {
        devices: [
          { name: "A", ip: "192.168.1.10" },
          { name: "B", ip: "192.168.1.11" },
        ],
      },
      { failIds: ["B"] },
    );
    await ctx.i.onReady();
    await flush();

    expect(ctx.i.states.get("info.devicesTotal")).toEqual({ val: 2, ack: true });
    expect(ctx.i.states.get("info.devicesOnline")).toEqual({ val: 1, ack: true });
    expect(ctx.i.states.get("info.devicesAllOnline")).toEqual({ val: false, ack: true });

    ctx.i.reportConnection("B", true);
    expect(ctx.i.states.get("info.devicesOnline")).toEqual({ val: 2, ack: true });
    expect(ctx.i.states.get("info.devicesAllOnline")).toEqual({ val: true, ack: true });
  });

  it("marks a device that never answers as disconnected at startup", async () => {
    // ioBroker keeps the last value forever: without the startup stamp a device that was
    // connected before a crash stays green for good while it never answers again.
    const ctx = setup({ devices: [{ name: "A", ip: "192.168.1.10" }] }, { failIds: ["A"] });
    ctx.i.states.set("A.info.connection", { val: true, ack: true });

    await ctx.i.onReady();
    await flush();

    expect(ctx.i.states.get("A.info.connection")).toEqual({ val: false, ack: true });
    expect(ctx.i.states.get("info.devicesOnline")).toEqual({ val: 0, ack: true });
  });
});

describe("Yamaha SSDP search", () => {
  /**
   * Run onReady in auto mode with the REAL search/fetch wired into a fake
   * discovery, so the ssdpSearch and fetchUrl bodies actually execute.
   *
   * @param config extra native config for this run
   * @returns the context plus the captured search/fetch callbacks
   */
  async function withRealSearch(config: Record<string, unknown> = {}): Promise<{
    ctx: Ctx;
    search: (target: string, ms: number) => Promise<Array<{ location: string; address: string }>>;
    fetch: (url: string) => Promise<string>;
  }> {
    let search!: (target: string, ms: number) => Promise<Array<{ location: string; address: string }>>;
    let fetchUrl!: (url: string) => Promise<string>;
    mocks.discoverYamaha.mockImplementation((deps?: unknown) => {
      const d = deps as {
        search: typeof search;
        fetch: typeof fetchUrl;
      };
      search = d.search;
      fetchUrl = d.fetch;
      return Promise.resolve([]);
    });
    const ctx = setup({ devices: [], ...config });
    await ctx.i.onReady();
    await flush();
    return { ctx, search, fetch: fetchUrl };
  }

  it("searches on every routable interface when none is configured", async () => {
    net.interfaces.value = {
      en0: [{ address: "192.168.1.5", family: "IPv4", internal: false }],
      en1: [{ address: "10.0.0.5", family: "IPv4", internal: false }],
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    };
    const { ctx, search } = await withRealSearch();
    const pending = search("urn:schemas-upnp-org:device:MediaRenderer:1", 3000);

    // On a multi-homed host the default route often is NOT the AV network — a
    // single socket would never reach the receiver.
    expect(net.sockets.map(s => s.bindAddr).sort()).toEqual(["10.0.0.5", "192.168.1.5"]);
    // Binding only sets the SOURCE address; the egress interface is IP_MULTICAST_IF.
    expect(net.sockets.flatMap(s => s.mcastIf).sort()).toEqual(["10.0.0.5", "192.168.1.5"]);

    // The burst: multicast is lossy, one dropped request must not hide a receiver.
    const bursts = ctx.i.setTimeout.mock.calls.filter(c => typeof c[1] === "number" && c[1] < 3000);
    expect(bursts.length).toBeGreaterThanOrEqual(6);
    for (const [cb] of bursts) {
      (cb as () => void)();
    }
    expect(net.sockets[0].sent).toHaveLength(3);
    expect(net.sockets[0].sent[0]).toMatchObject({ port: 1900, address: "239.255.255.250" });
    expect(net.sockets[0].sent[0].msg).toContain("ST: urn:schemas-upnp-org:device:MediaRenderer:1");

    net.sockets[0].emit("message", Buffer.from("HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.20/desc.xml\r\n"), {
      address: "192.168.1.20",
    });
    const finish = ctx.i.setTimeout.mock.calls.filter(c => c[1] === 3000).at(-1);
    (finish?.[0] as () => void)();
    await expect(pending).resolves.toEqual([{ location: "http://192.168.1.20/desc.xml", address: "192.168.1.20" }]);
    // Every socket has to be closed, or the instance leaks a UDP handle per scan.
    expect(net.sockets.every(s => s.closed === 1)).toBe(true);
  });

  it("searches only on the configured interface", async () => {
    net.interfaces.value = {
      en0: [{ address: "192.168.1.5", family: "IPv4", internal: false }],
      en1: [{ address: "10.0.0.5", family: "IPv4", internal: false }],
    };
    const { ctx, search } = await withRealSearch({ networkInterface: "10.0.0.5" });
    void search("x", 5000);
    expect(net.sockets.map(s => s.bindAddr)).toEqual(["10.0.0.5"]);
    void ctx;
  });

  it("falls back to the default route when no interface is usable", async () => {
    net.interfaces.value = { lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }] };
    const { search } = await withRealSearch();
    void search("x", 5000);
    expect(net.sockets).toHaveLength(1);
    expect(net.sockets[0].bindAddr).toBeUndefined();
    // Without a chosen interface, pinning the egress would be a guess.
    expect(net.sockets[0].mcastIf).toEqual([]);
  });

  it("keeps searching on the other interfaces when one socket fails", async () => {
    net.interfaces.value = {
      en0: [{ address: "192.168.1.5", family: "IPv4", internal: false }],
      en1: [{ address: "10.0.0.5", family: "IPv4", internal: false }],
    };
    const { ctx, search } = await withRealSearch();
    const pending = search("x", 5000);
    net.sockets[0].emit("error", new Error("EADDRNOTAVAIL"));
    // A stale selected IP after a DHCP change must not kill the whole scan — and
    // the message has to point at the setting the user can fix.
    expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("check the Network Interface setting"));
    const finish = ctx.i.setTimeout.mock.calls.filter(c => c[1] === 5000).at(-1);
    (finish?.[0] as () => void)();
    await expect(pending).resolves.toEqual([]);
  });

  it("survives an interface that refuses the egress pin and a send on a dead socket", async () => {
    net.interfaces.value = { en0: [{ address: "192.168.1.5", family: "IPv4", internal: false }] };
    net.fail.mcastIf = true;
    const { ctx, search } = await withRealSearch();
    const pending = search("x", 5000);
    expect(ctx.i.log.info).toHaveBeenCalledWith(expect.stringContaining("could not pin multicast egress"));

    net.fail.send = true;
    const burst = ctx.i.setTimeout.mock.calls.filter(c => c[1] === 0).at(-1);
    expect(() => (burst?.[0] as () => void)()).not.toThrow();
    const finish = ctx.i.setTimeout.mock.calls.filter(c => c[1] === 5000).at(-1);
    (finish?.[0] as () => void)();
    await expect(pending).resolves.toEqual([]);
  });

  it("stops sending as soon as the collect window closed", async () => {
    net.interfaces.value = { en0: [{ address: "192.168.1.5", family: "IPv4", internal: false }] };
    const { ctx, search } = await withRealSearch();
    const pending = search("x", 5000);
    const bursts = ctx.i.setTimeout.mock.calls.filter(c => c[1] === 0 || c[1] === 1000 || c[1] === 2000);
    const finish = ctx.i.setTimeout.mock.calls.filter(c => c[1] === 5000).at(-1);

    (finish?.[0] as () => void)();
    await expect(pending).resolves.toEqual([]);
    net.sockets[0].sent.length = 0;
    // Every burst timer is still pending when the window closes. Sending on the
    // closed socket throws inside dgram — the guard is what keeps that out of the
    // adapter's timer callback.
    for (const [cb] of bursts) {
      expect(() => (cb as () => void)()).not.toThrow();
    }
    expect(net.sockets[0].sent).toEqual([]);
  });

  it("closes each socket exactly once, even if the settle runs twice", async () => {
    net.interfaces.value = {
      en0: [{ address: "192.168.1.5", family: "IPv4", internal: false }],
      en1: [{ address: "10.0.0.5", family: "IPv4", internal: false }],
    };
    const { ctx, search } = await withRealSearch();
    const pending = search("x", 5000);
    const finish = ctx.i.setTimeout.mock.calls.filter(c => c[1] === 5000).at(-1);
    (finish?.[0] as () => void)();
    (finish?.[0] as () => void)();
    await expect(pending).resolves.toEqual([]);
    // Closing an already-closed dgram socket throws; doing it per interface per
    // stray timer turns one scan into a stream of exceptions in the callback.
    expect(net.sockets.map(s => s.closed)).toEqual([1, 1]);
  });

  it("resolves even when closing the socket throws", async () => {
    net.interfaces.value = { en0: [{ address: "192.168.1.5", family: "IPv4", internal: false }] };
    net.fail.close = true;
    const { ctx, search } = await withRealSearch();
    const pending = search("x", 5000);
    const finish = ctx.i.setTimeout.mock.calls.filter(c => c[1] === 5000).at(-1);
    // A socket the OS already tore down must not leave the caller hanging.
    (finish?.[0] as () => void)();
    await expect(pending).resolves.toEqual([]);
  });

  it("ignores responses without a LOCATION header", async () => {
    net.interfaces.value = { en0: [{ address: "192.168.1.5", family: "IPv4", internal: false }] };
    const { ctx, search } = await withRealSearch();
    const pending = search("x", 5000);
    net.sockets[0].emit("message", Buffer.from("HTTP/1.1 200 OK\r\nSERVER: something\r\n"), { address: "1.2.3.4" });
    const finish = ctx.i.setTimeout.mock.calls.filter(c => c[1] === 5000).at(-1);
    (finish?.[0] as () => void)();
    await expect(pending).resolves.toEqual([]);
  });
});

describe("Yamaha description fetch", () => {
  async function realFetch(): Promise<(url: string) => Promise<string>> {
    let fetchUrl!: (url: string) => Promise<string>;
    mocks.discoverYamaha.mockImplementation((deps?: unknown) => {
      fetchUrl = (deps as { fetch: typeof fetchUrl }).fetch;
      return Promise.resolve([]);
    });
    const ctx = setup({ devices: [] });
    await ctx.i.onReady();
    await flush();
    return fetchUrl;
  }

  it("returns the body of the description document", async () => {
    const fetchUrl = await realFetch();
    net.http.body = "<root><device><modelName>RX-V685</modelName></device></root>";
    await expect(fetchUrl("http://192.168.1.20/desc.xml")).resolves.toContain("RX-V685");
    expect(net.httpCalls).toContain("http://192.168.1.20/desc.xml");
  });

  it("rejects instead of hanging on a device that never answers", async () => {
    const fetchUrl = await realFetch();
    net.http.error = new Error("timeout");
    // Discovery collects from several addresses; one dead device holding the
    // request open would stall the whole scan.
    await expect(fetchUrl("http://192.168.1.99/desc.xml")).rejects.toThrow(/fetch timed out/);
    expect(net.http.lastReq?.timeoutMs).toBe(4000);
  });

  it("rejects on a transport error", async () => {
    const fetchUrl = await realFetch();
    net.http.error = new Error("ECONNREFUSED");
    await expect(fetchUrl("http://192.168.1.99/desc.xml")).rejects.toThrow("ECONNREFUSED");
  });

  it("rejects a description that streams past the size cap instead of buffering it", async () => {
    const fetchUrl = await realFetch();
    // A description document is a few KB. Whatever answers on that address with more is
    // not a Yamaha — and buffering it without a cap grows the process without bound.
    net.http.body = "x".repeat(MAX_HTTP_BODY_BYTES + 1);
    await expect(fetchUrl("http://192.168.1.20/desc.xml")).rejects.toThrow(/too large/);
  });
});

describe("Yamaha never-filled purge (once per adapter version, after connect)", () => {
  const settle = (ctx: { i: { setTimeout: ReturnType<typeof vi.fn> } }): void => {
    const call = ctx.i.setTimeout.mock.calls.filter(c => c[1] === 5000).at(-1);
    (call?.[0] as (() => void) | undefined)?.();
  };

  it("removes read states that never carried a value and stamps the device with the version", async () => {
    const ctx = setup();
    ctx.i.objects.set("Living_room", { type: "device", common: {}, native: {} });
    // Orphan of an earlier version: readable, no value ever.
    ctx.i.objects.set("Living_room.sound.direct", { type: "state", common: { read: true }, native: {} });
    // A filled state, a button and a user-linked state must survive.
    ctx.i.objects.set("Living_room.volume", { type: "state", common: { read: true }, native: {} });
    ctx.i.states.set("Living_room.volume", { val: -40, ack: true, lc: 5 } as never);
    ctx.i.objects.set("Living_room.player.play", { type: "state", common: { read: false, write: true }, native: {} });
    ctx.i.objects.set("Living_room.multiroom.zone2.soundProgram", {
      type: "state",
      common: { read: true, custom: { "history.0": { enabled: true } } },
      native: {},
    });
    await ctx.i.onReady();
    await flush();
    settle(ctx);
    await flush();
    expect(ctx.i.objects.has("Living_room.sound.direct")).toBe(false);
    expect(ctx.i.objects.has("Living_room.volume")).toBe(true);
    expect(ctx.i.objects.has("Living_room.player.play")).toBe(true);
    // A recording setting is user business — never a factor in whether the adapter keeps a datapoint.
    expect(ctx.i.objects.has("Living_room.multiroom.zone2.soundProgram")).toBe(false);
    expect((ctx.i.objects.get("Living_room")?.native as { purgeVersion?: string }).purgeVersion).toBe("0.0.0-test");
    expect(ctx.i.log.debug).toHaveBeenCalledWith(expect.stringContaining("never-filled"));
  });

  it("removes a folder left empty by the tree rework, even when the version purge already ran", async () => {
    const ctx = setup();
    // The stamp says the once-per-version orphan sweep is done — the empty-folder sweep still
    // has to run, otherwise `player.server` (emptied by the v2.0.0 migration, no datapoint of
    // its own in the new tree) stays in the tree for good.
    ctx.i.objects.set("Living_room", { type: "device", common: {}, native: { purgeVersion: "0.0.0-test" } });
    ctx.i.objects.set("Living_room.player", { type: "channel", common: {}, native: {} });
    ctx.i.objects.set("Living_room.player.track", { type: "state", common: { read: true }, native: {} });
    ctx.i.states.set("Living_room.player.track", { val: "", ack: true, lc: 7 } as never);
    ctx.i.objects.set("Living_room.player.server", { type: "channel", common: {}, native: {} });
    ctx.i.objects.set("Living_room.player.usb", { type: "channel", common: {}, native: {} });
    ctx.i.objects.set("Living_room.player.usb.preset", {
      type: "state",
      common: { read: false, write: true },
      native: {},
    });
    await ctx.i.onReady();
    await flush();
    settle(ctx);
    await flush();
    expect(ctx.i.objects.has("Living_room.player.server")).toBe(false);
    // The folders that still carry datapoints stay.
    expect(ctx.i.objects.has("Living_room.player")).toBe(true);
    expect(ctx.i.objects.has("Living_room.player.usb")).toBe(true);
    expect(ctx.i.log.debug).toHaveBeenCalledWith(expect.stringContaining("empty folder"));
  });

  it("leaves an offline device's folders alone — its tree is only swept once it answers", async () => {
    // No transport answers, so the device never reports connected.
    const ctx = setup({}, { failIds: ["Living_room"] });
    ctx.i.objects.set("Living_room", { type: "device", common: {}, native: {} });
    ctx.i.objects.set("Living_room.player.server", { type: "channel", common: {}, native: {} });
    await ctx.i.onReady();
    await flush();
    settle(ctx);
    await flush();
    expect(ctx.i.objects.has("Living_room.player.server")).toBe(true);
  });

  it("runs ONCE per version: a device already stamped with the current version is not swept again", async () => {
    const ctx = setup();
    ctx.i.objects.set("Living_room", { type: "device", common: {}, native: { purgeVersion: "0.0.0-test" } });
    // Would be purged on a version change — but the stamp says this version already ran,
    // so a fresh state merely waiting for its first value must not flap on every start.
    ctx.i.objects.set("Living_room.tuner.rdsText", { type: "state", common: { read: true }, native: {} });
    await ctx.i.onReady();
    await flush();
    settle(ctx);
    await flush();
    expect(ctx.i.objects.has("Living_room.tuner.rdsText")).toBe(true);
    expect(ctx.i.log.debug).not.toHaveBeenCalledWith(expect.stringContaining("never-filled"));
  });

  it("a version CHANGE re-arms the sweep; a device that never connected is left alone", async () => {
    const ctx = setup(
      {
        devices: [
          { name: "Living room", ip: "192.168.1.10" },
          { name: "Attic", ip: "192.168.1.11" },
        ],
      },
      { failIds: ["Attic"] },
    );
    ctx.i.objects.set("Living_room", { type: "device", common: {}, native: { purgeVersion: "1.7.0" } });
    ctx.i.objects.set("Living_room.hdmi.out2", { type: "state", common: { read: true }, native: {} });
    ctx.i.objects.set("Attic", { type: "device", common: {}, native: { purgeVersion: "1.7.0" } });
    ctx.i.objects.set("Attic.sound.direct", { type: "state", common: { read: true }, native: {} });
    await ctx.i.onReady();
    await flush();
    settle(ctx);
    await flush();
    expect(ctx.i.objects.has("Living_room.hdmi.out2")).toBe(false);
    expect((ctx.i.objects.get("Living_room")?.native as { purgeVersion?: string }).purgeVersion).toBe("0.0.0-test");
    // The offline device keeps its tree AND its old stamp — its sweep runs when it connects.
    expect(ctx.i.objects.has("Attic.sound.direct")).toBe(true);
    expect((ctx.i.objects.get("Attic")?.native as { purgeVersion?: string }).purgeVersion).toBe("1.7.0");
  });
});

describe("Yamaha guarded database writes (audit 2026-09-02 — a hiccup must not restart the instance)", () => {
  const writeWarnings = (ctx: Ctx): string[] =>
    ctx.i.log.warn.mock.calls.map(c => String(c[0])).filter(m => m.includes("could not write"));

  it("logs a failed state write once at warn, repeats at debug, and re-arms after a success", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await flush();
    const setStateAck = ctx.calls[0].deps.setStateAck as (id: string, value: unknown) => void;
    // js-controller turns an unhandled promise rejection into an adapter stop (exit code 6),
    // and setState rejects whenever the states database is not reachable for a moment. A
    // bare `void setState` on a device-pushed value would have restarted the instance.
    ctx.i.setStateFail = new Error("States database not connected");
    setStateAck("Living_room.volume", -30);
    setStateAck("Living_room.mute", true);
    await flush();
    expect(writeWarnings(ctx)).toHaveLength(1);
    expect(writeWarnings(ctx)[0]).toContain("could not write state Living_room.volume");
    expect(ctx.i.log.debug).toHaveBeenCalledWith(expect.stringContaining("could not write state Living_room.mute"));
    // A successful write re-arms the warning for the next outage.
    ctx.i.setStateFail = null;
    setStateAck("Living_room.volume", -29);
    await flush();
    ctx.i.setStateFail = new Error("connection is closed");
    setStateAck("Living_room.volume", -28);
    await flush();
    expect(writeWarnings(ctx)).toHaveLength(2);
  });

  it("observes the connection markers and the overview the same way", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await flush();
    ctx.i.setStateFail = new Error("States database not connected");
    ctx.i.reportConnection("Living_room", false);
    await flush();
    expect(writeWarnings(ctx)).toHaveLength(1);
  });

  it("observes the persistence writes of the per-device caches too", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await flush();
    ctx.i.extendObjectFail = new Error("Objects database not connected");
    const cache = ctx.calls[0].deps.yncaSubunitCache as unknown as { set(snapshot: unknown): void };
    cache.set({ subunits: ["MAIN"], model: "RX", firmware: "1.0" });
    const memory = ctx.calls[0].deps.probeMemory as unknown as { set(key: string, value: unknown): void };
    memory.set("features", { zones: [] });
    await flush();
    expect(writeWarnings(ctx)).toHaveLength(1);
    expect(writeWarnings(ctx)[0]).toContain("could not write device object Living_room");
  });

  it("stays silent about failed writes while unloading — the database goes down with the adapter", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await flush();
    const setStateAck = ctx.calls[0].deps.setStateAck as (id: string, value: unknown) => void;
    ctx.i.onUnload(vi.fn());
    ctx.i.setStateFail = new Error("connection is closed");
    setStateAck("Living_room.volume", -30);
    await flush();
    expect(writeWarnings(ctx)).toEqual([]);
  });
});

describe("Yamaha protocol flags at start and stop (audit 2026-09-02)", () => {
  it("resets stale protocol flags at startup — a crash must not leave 'YNCA connected' on the card", async () => {
    // ioBroker keeps the last value: after a crash the card would show a green YNCA badge
    // next to a red connection dot, for good if the device never answers again. The attempt
    // here never answers — so the reset must come from the start itself, not from the
    // disconnect path a failed attempt would take.
    const ctx = setup({ devices: [{ name: "A", ip: "192.168.1.10" }] }, { hangIds: ["A"] });
    ctx.i.states.set("A.info.transports.ynca", { val: true, ack: true });
    ctx.i.states.set("A.info.transports.yxc", { val: true, ack: true });
    await ctx.i.onReady();
    await flush();
    expect(ctx.calls).toHaveLength(1);
    for (const proto of ["ynca", "yxc", "xml"]) {
      expect(ctx.i.states.get(`A.info.transports.${proto}`)).toEqual({ val: false, ack: true });
    }
  });

  it("takes the protocol flags down on unload, with the connection", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await flush();
    (ctx.calls[0].deps.onTransports as (names: string[]) => void)(["ynca", "yxc"]);
    expect(ctx.i.states.get("Living_room.info.transports.ynca")).toEqual({ val: true, ack: true });
    ctx.i.onUnload(vi.fn());
    await flush();
    for (const proto of ["ynca", "yxc", "xml"]) {
      expect(ctx.i.states.get(`Living_room.info.transports.${proto}`)).toEqual({ val: false, ack: true });
    }
  });
});

describe("Yamaha teardown races (audit 2026-09-02)", () => {
  it("does not start a device the background search hands over after unload", async () => {
    mocks.discoveredStore.devices = [{ id: "RX-V685", ip: "192.168.1.20" }];
    let release: (found: Array<{ ip: string; name: string }>) => void = () => undefined;
    mocks.discoverYamaha.mockImplementation(() => new Promise(resolve => (release = resolve)));
    const ctx = setup({ devices: [] });
    await ctx.i.onReady();
    expect(ctx.calls.map(c => c.device.ip)).toEqual(["192.168.1.20"]);
    ctx.i.onUnload(vi.fn());
    // The search outlived the adapter: a device started now would hold sockets and timers
    // on an instance that is already gone.
    release([{ ip: "192.168.1.21", name: "WX-021" }]);
    await flush();
    expect(ctx.calls.map(c => c.device.ip)).toEqual(["192.168.1.20"]);
    // Nor does a stopped adapter announce a find it will not act on.
    expect(ctx.i.log.info).not.toHaveBeenCalledWith(expect.stringContaining("discovery found"));
  });

  it("does not bring the instance up when the initial network search ends after unload", async () => {
    // First setup without remembered devices: onReady waits for the search. A stop in that
    // window used to be ignored — the push socket, the subscriptions and every found device
    // came up afterwards on a dead instance, with no onUnload left to close them.
    let release: (found: Array<{ ip: string; name: string }>) => void = () => undefined;
    mocks.discoverYamaha.mockImplementation(() => new Promise(resolve => (release = resolve)));
    const ctx = setup({ devices: [] });
    const ready = ctx.i.onReady();
    await flush();
    ctx.i.onUnload(vi.fn());
    release([{ ip: "192.168.1.21", name: "WX-021" }]);
    await ready;
    await flush();
    expect(ctx.calls).toEqual([]);
    expect(mocks.pushReceivers).toHaveLength(0);
    expect(ctx.i.subscribed).toEqual([]);
  });

  it("refuses to arm timers and keepalives for the transports after unload", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await flush();
    const deps = ctx.calls[0].deps;
    ctx.i.onUnload(vi.fn());
    ctx.i.setTimeout.mockClear();
    ctx.i.setInterval.mockClear();
    // A connect attempt still in flight resolves into a closing adapter — the framework
    // would refuse the timer with a warn line per attempt, so the deps refuse it quietly.
    const timer = (deps.timers as unknown as { schedule(cb: () => void, ms: number): unknown }).schedule(
      () => undefined,
      10,
    );
    expect(timer).toBeUndefined();
    expect(ctx.i.setTimeout).not.toHaveBeenCalled();
    const stop = (deps.scheduleKeepalive as (h: () => void, ms: number) => () => void)(() => undefined, 20);
    expect(ctx.i.setInterval).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });
});

describe("Yamaha probe memory persistence (audit 2026-09-02)", () => {
  it("restores the remembered device answers from the device object", async () => {
    const ctx = setup();
    ctx.i.objects.set("Living_room", {
      type: "device",
      common: {},
      native: { probeCache: JSON.stringify({ xmlModel: "RX-V771", features: { zones: [] } }) },
    });
    await ctx.i.onReady();
    await flush();
    const memory = ctx.calls[0].deps.probeMemory as unknown as { remembered(key: string): unknown };
    // This is what makes a restart fast — without it every start re-asks everything.
    expect(memory.remembered("xmlModel")).toBe("RX-V771");
    expect(memory.remembered("features")).toEqual({ zones: [] });
  });

  it("starts with an empty memory when the stored value is not a JSON object", async () => {
    for (const stored of ["not json", JSON.stringify([1, 2]), JSON.stringify("text"), 42]) {
      const ctx = setup();
      ctx.i.objects.set("Living_room", { type: "device", common: {}, native: { probeCache: stored } });
      await ctx.i.onReady();
      await flush();
      const memory = ctx.calls[0].deps.probeMemory as unknown as { remembered(key: string): unknown };
      // A hand-edited or half-written object must not feed the tree from invented answers —
      // not even an array's or a string's index positions as keys.
      expect(memory.remembered("xmlModel")).toBeUndefined();
      expect(memory.remembered("0")).toBeUndefined();
    }
  });
});
