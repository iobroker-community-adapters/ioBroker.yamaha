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
  fireScheduled: () => void;
  scheduledCount: () => number;
} {
  const warnings: string[] = [];
  const scheduled: Array<() => void> = [];
  return {
    warnings,
    fireScheduled: () => scheduled.shift()?.(),
    scheduledCount: () => scheduled.length,
    deps: {
      log: { debug: () => {}, warn: m => warnings.push(m) },
      schedule: cb => {
        scheduled.push(cb);
        return scheduled.length as unknown as ioBroker.Timeout;
      },
      cancel: () => {},
    },
  };
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

  test("a bind-time error warns, closes the socket and runs poll-only without a rebind", () => {
    const fake = new FakeSocket();
    const d = makeDeps();
    const receiver = new YxcPushReceiver(d.deps, () => fake);
    receiver.start(); // bind, but 'listening' never fires → bind failed
    fake.emitError(new Error("EADDRINUSE"));
    expect(d.warnings).toHaveLength(1);
    expect(d.warnings[0]).toMatch(/unavailable/);
    expect(fake.closed).toBe(true); // closed, not orphaned
    expect(d.scheduledCount()).toBe(0); // a bind failure is not retried
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

describe("YxcPushReceiver on a real dgram socket", () => {
  beforeEach(() => {
    dgramMock.sockets.length = 0;
  });

  test("binds the MusicCast push port and routes a datagram by its source IP", () => {
    const seen: Array<{ ip: string; payload: string }> = [];
    const logs: string[] = [];
    const receiver = new YxcPushReceiver({
      log: { debug: m => logs.push(m), warn: m => logs.push(m) },
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
      log: { debug: m => logs.push(m), warn: m => logs.push(m) },
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
