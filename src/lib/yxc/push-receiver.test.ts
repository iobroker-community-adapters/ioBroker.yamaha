import { vi } from "vitest";

/** node:dgram is mocked so the DEFAULT socket factory (the production path) is testable. */
const dgramMock = vi.hoisted(() => ({
  sockets: [] as Array<{
    bound: number | undefined;
    closed: number;
    handlers: Record<string, Array<(...a: unknown[]) => void>>;
    emit: (ev: string, ...a: unknown[]) => void;
  }>,
}));
vi.mock("node:dgram", () => ({
  createSocket: () => {
    const s = {
      bound: undefined as number | undefined,
      closed: 0,
      handlers: {} as Record<string, Array<(...a: unknown[]) => void>>,
      on(ev: string, cb: (...a: unknown[]) => void) {
        (s.handlers[ev] ??= []).push(cb);
        return s;
      },
      bind(port: number) {
        s.bound = port;
      },
      close() {
        s.closed++;
      },
      emit(ev: string, ...a: unknown[]) {
        (s.handlers[ev] ?? []).forEach(h => h(...a));
      },
    };
    dgramMock.sockets.push(s);
    return s;
  },
}));

import { YxcPushReceiver } from "./push-receiver";
import type { YxcPushSocket } from "./push-receiver";

class FakeSocket implements YxcPushSocket {
  public boundPort: number | undefined;
  public closed = false;
  private messageHandler?: (payload: string, address: string) => void;
  private errorHandler?: (err: Error) => void;
  private listeningHandler?: () => void;

  public onMessage(handler: (payload: string, address: string) => void): void {
    this.messageHandler = handler;
  }
  public onError(handler: (err: Error) => void): void {
    this.errorHandler = handler;
  }
  public onListening(handler: () => void): void {
    this.listeningHandler = handler;
  }
  public bind(port: number): void {
    this.boundPort = port;
  }
  public close(): void {
    this.closed = true;
  }
  public emitListening(): void {
    this.listeningHandler?.();
  }
  public emitMessage(payload: string, address: string): void {
    this.messageHandler?.(payload, address);
  }
  public emitError(err: Error): void {
    this.errorHandler?.(err);
  }
}

/** Deps that record warnings and collect scheduled rebinds so tests fire them manually. */
function makeDeps(): {
  deps: ConstructorParameters<typeof YxcPushReceiver>[0];
  warnings: string[];
  infos: string[];
  /** The delays the receiver asked for, in order. */
  delays: number[];
  cancelled: number;
  fireScheduled: () => void;
  scheduledCount: () => number;
} {
  const warnings: string[] = [];
  const infos: string[] = [];
  const delays: number[] = [];
  const scheduled: Array<() => void> = [];
  const out = {
    warnings,
    infos,
    delays,
    cancelled: 0,
    fireScheduled: () => scheduled.shift()?.(),
    scheduledCount: () => scheduled.length,
    deps: {
      log: { debug: () => {}, info: (m: string) => infos.push(m), warn: (m: string) => warnings.push(m) },
      schedule: (cb: () => void, ms: number) => {
        scheduled.push(cb);
        delays.push(ms);
        return scheduled.length as unknown as ioBroker.Timeout;
      },
      cancel: () => {
        out.cancelled++;
      },
    },
  };
  return out;
}

describe("YxcPushReceiver", () => {
  test("binds the shared socket to :41100", () => {
    const fake = new FakeSocket();
    new YxcPushReceiver(makeDeps().deps, () => fake).start();
    expect(fake.boundPort).toBe(41100);
  });

  test("routes a push to the handler registered for its source ip", () => {
    const fake = new FakeSocket();
    const receiver = new YxcPushReceiver(makeDeps().deps, () => fake);
    const seen: unknown[] = [];
    receiver.register("192.168.1.5", e => seen.push(e));
    receiver.start();
    fake.emitMessage(JSON.stringify({ main: { power: "on" } }), "192.168.1.5");
    expect(seen).toEqual([{ main: { power: "on" } }]);
  });

  test("register returns an unregister that stops routing to that ip", () => {
    const fake = new FakeSocket();
    const receiver = new YxcPushReceiver(makeDeps().deps, () => fake);
    let called = false;
    const unregister = receiver.register("192.168.1.5", () => {
      called = true;
    });
    receiver.start();
    unregister();
    fake.emitMessage("{}", "192.168.1.5");
    expect(called).toBe(false);
  });

  test("ignores a push from an unregistered ip", () => {
    const fake = new FakeSocket();
    const receiver = new YxcPushReceiver(makeDeps().deps, () => fake);
    receiver.register("192.168.1.5", () => {
      throw new Error("must not be called");
    });
    receiver.start();
    expect(() => fake.emitMessage("{}", "10.0.0.9")).not.toThrow();
  });

  test("survives a malformed payload without calling the handler", () => {
    const fake = new FakeSocket();
    const receiver = new YxcPushReceiver(makeDeps().deps, () => fake);
    let called = false;
    receiver.register("192.168.1.5", () => {
      called = true;
    });
    receiver.start();
    expect(() => fake.emitMessage("not json{{", "192.168.1.5")).not.toThrow();
    expect(called).toBe(false);
  });

  test("a bind-time error warns once, runs poll-only and tries the port again every five minutes", () => {
    // The other MusicCast consumer holding the port may stop later; until 2.10.0 only a
    // restart of this adapter ever found the port free again.
    const sockets: FakeSocket[] = [];
    const d = makeDeps();
    const receiver = new YxcPushReceiver(d.deps, () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    });
    receiver.start(); // bind, but 'listening' never fires → bind failed
    sockets[0].emitError(new Error("EADDRINUSE"));
    expect(d.warnings).toHaveLength(1);
    expect(d.warnings[0]).toMatch(/unavailable/);
    expect(sockets[0].closed).toBe(true); // closed, not orphaned
    expect(receiver.isListening()).toBe(false);
    expect(d.delays).toEqual([300000]);
    // Still taken: no second warning, the next try is armed again.
    d.fireScheduled();
    sockets[1].emitError(new Error("EADDRINUSE"));
    expect(d.warnings).toHaveLength(1);
    expect(d.delays).toEqual([300000, 300000]);
    // Free at last: listening, and one line says so.
    d.fireScheduled();
    sockets[2].emitListening();
    expect(receiver.isListening()).toBe(true);
    expect(d.infos).toHaveLength(1);
    expect(d.infos[0]).toMatch(/41100/);
    expect(d.scheduledCount()).toBe(0);
  });

  test("closing while a bind retry is pending cancels it", () => {
    const fake = new FakeSocket();
    const d = makeDeps();
    const receiver = new YxcPushReceiver(d.deps, () => fake);
    receiver.start();
    fake.emitError(new Error("EADDRINUSE"));
    expect(d.scheduledCount()).toBe(1);
    receiver.close();
    expect(d.cancelled).toBeGreaterThanOrEqual(1);
  });

  test("the first successful bind says nothing at info — only a recovery does", () => {
    const fake = new FakeSocket();
    const d = makeDeps();
    new YxcPushReceiver(d.deps, () => fake).start();
    fake.emitListening();
    expect(d.infos).toEqual([]);
  });

  test("a runtime error after listening closes the socket and rebinds a fresh one", () => {
    const sockets: FakeSocket[] = [];
    const d = makeDeps();
    const receiver = new YxcPushReceiver(d.deps, () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    });
    receiver.start();
    sockets[0].emitListening(); // socket came up
    sockets[0].emitError(new Error("EIO")); // runtime fault
    expect(sockets[0].closed).toBe(true);
    expect(d.warnings[0]).toMatch(/rebinding/);
    expect(d.scheduledCount()).toBe(1);
    d.fireScheduled(); // the rebind runs
    expect(sockets).toHaveLength(2);
    expect(sockets[1].boundPort).toBe(41100);
  });

  test("close closes the socket", () => {
    const fake = new FakeSocket();
    const receiver = new YxcPushReceiver(makeDeps().deps, () => fake);
    receiver.start();
    receiver.close();
    expect(fake.closed).toBe(true);
  });
});

describe("YxcPushReceiver routing beyond the literal address (audit 2026-09-24, C2/C19)", () => {
  // A row that kept the hostname the 0.5.x adapter used never received an event: they come from
  // the numeric address.
  test("a hostname registration is resolved and routes by the resolved address", async () => {
    const fake = new FakeSocket();
    const d = makeDeps();
    const receiver = new YxcPushReceiver(
      { ...d.deps, resolve: host => Promise.resolve(host === "yamaha.fritz.box" ? "192.168.1.5" : undefined) },
      () => fake,
    );
    const seen: unknown[] = [];
    receiver.register("yamaha.fritz.box", e => seen.push(e));
    await new Promise(resolve => setImmediate(resolve));
    receiver.start();
    fake.emitMessage(JSON.stringify({ main: { power: "on" } }), "192.168.1.5");
    expect(seen).toEqual([{ main: { power: "on" } }]);
  });

  // YXC Basic Rev 1.10 §11.3: every event carries the device_id getDeviceInfo reports.
  test("routes by device_id when the source address is not registered", () => {
    const fake = new FakeSocket();
    const receiver = new YxcPushReceiver(makeDeps().deps, () => fake);
    const seen: unknown[] = [];
    receiver.register("192.168.1.5", e => seen.push(e), "00a0de0a1b2c");
    receiver.start();
    fake.emitMessage(JSON.stringify({ device_id: "00A0DE0A1B2C", main: { volume: 40 } }), "10.0.0.9");
    fake.emitMessage(JSON.stringify({ device_id: "000000000000", main: { volume: 1 } }), "10.0.0.9");
    expect(seen).toEqual([{ device_id: "00A0DE0A1B2C", main: { volume: 40 } }]);
  });

  // A reconnect registers again before the old connection's cleanup runs; the old unregister
  // deleted by address and took the new handler with it.
  test("an old unregister does not remove a newer registration of the same device", () => {
    const fake = new FakeSocket();
    const receiver = new YxcPushReceiver(makeDeps().deps, () => fake);
    const seen: string[] = [];
    const oldUnregister = receiver.register("192.168.1.5", () => seen.push("old"));
    receiver.register("192.168.1.5", () => seen.push("new"));
    oldUnregister();
    receiver.start();
    fake.emitMessage("{}", "192.168.1.5");
    expect(seen).toEqual(["new"]);
  });
});

describe("YxcPushReceiver on a real dgram socket", () => {
  beforeEach(() => {
    dgramMock.sockets.length = 0;
  });

  test("binds the MusicCast push port and routes a datagram by its source IP", () => {
    const seen: Array<{ ip: string; payload: string }> = [];
    const logs: string[] = [];
    const receiver = new YxcPushReceiver({
      log: { debug: m => logs.push(m), info: m => logs.push(m), warn: m => logs.push(m) },
      schedule: () => 1 as unknown as ioBroker.Timeout,
      cancel: () => {},
    });
    receiver.register("192.168.1.10", payload => seen.push({ ip: "192.168.1.10", payload: JSON.stringify(payload) }));
    receiver.start();
    const socket = dgramMock.sockets[0];
    // 41100 is the port the adapter announces in X-AppPort. Binding anything else
    // means no device ever pushes and everything falls back to polling.
    expect(socket.bound).toBe(41100);

    socket.emit("listening");
    socket.emit("message", Buffer.from(JSON.stringify({ main: { power: "on" } })), { address: "192.168.1.10" });
    expect(seen).toHaveLength(1);
    // A datagram from a device nobody registered belongs to another instance or
    // another adapter on the same host — it must not reach this device's handler.
    socket.emit("message", Buffer.from("{}"), { address: "10.0.0.1" });
    expect(seen).toHaveLength(1);

    receiver.close();
    expect(socket.closed).toBe(1);
  });

  test("keeps the adapter running when the push port is already taken", () => {
    const logs: string[] = [];
    const receiver = new YxcPushReceiver({
      log: { debug: m => logs.push(m), info: m => logs.push(m), warn: m => logs.push(m) },
      schedule: () => 1 as unknown as ioBroker.Timeout,
      cancel: () => {},
    });
    receiver.start();
    dgramMock.sockets[0].emit("error", new Error("EADDRINUSE"));
    // A second yamaha instance (or another MusicCast app) holds :41100. Pushes are
    // an optimisation; polling still works, so this must not be fatal.
    expect(logs.some(l => l.includes("unavailable"))).toBe(true);
    expect(() => receiver.close()).not.toThrow();
  });
});
