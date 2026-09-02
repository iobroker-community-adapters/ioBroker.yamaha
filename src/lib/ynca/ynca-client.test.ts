import { vi } from "vitest";
import { CommandGate } from "../lifecycle/command-gate";

/** node:net is mocked so the DEFAULT socket factory (the production path) is testable. */
const netMock = vi.hoisted(() => ({
  sockets: [] as Array<{
    options: Record<string, unknown>;
    timeouts: number[];
    written: string[];
    destroyed: Error | undefined | true;
    handlers: Record<string, Array<(...a: unknown[]) => void>>;
    emit: (ev: string, ...a: unknown[]) => void;
  }>,
}));
vi.mock("node:net", () => ({
  connect: (options: Record<string, unknown>) => {
    const s = {
      options,
      timeouts: [] as number[],
      written: [] as string[],
      destroyed: undefined as Error | undefined | true,
      handlers: {} as Record<string, Array<(...a: unknown[]) => void>>,
      on(ev: string, cb: (...a: unknown[]) => void) {
        (s.handlers[ev] ??= []).push(cb);
        return s;
      },
      setTimeout(ms: number) {
        s.timeouts.push(ms);
      },
      write(data: string) {
        s.written.push(data);
      },
      destroy(e?: Error) {
        s.destroyed = e ?? true;
      },
      emit(ev: string, ...a: unknown[]) {
        (s.handlers[ev] ?? []).forEach(h => h(...a));
      },
    };
    netMock.sockets.push(s);
    return s;
  },
}));

import { YncaClient } from "./ynca-client";
import type { YncaSocket } from "./ynca-client";

// Test timers back onto the global clock so vi.useFakeTimers() drives them; in
// production the adapter injects this.setTimeout (the lib uses no native timer).
const testTimers = {
  schedule: (handler: () => void, ms: number): ioBroker.Timeout =>
    setTimeout(handler, ms) as unknown as ioBroker.Timeout,
  cancel: (handle: ioBroker.Timeout | undefined): void =>
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
};

/**
 * A real command gate for the client under test. Spacing is 0 here so the tests assert
 * the client's own behaviour; the gate's pacing has its own test suite.
 *
 * @returns a gate wired to the test timers
 */
const testGate = (): CommandGate => new CommandGate({ minSpacingMs: 0, timers: testTimers });

/** Let the gate's queue drain — writes are queued, not written synchronously any more. */
const drain = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

class FakeSocket implements YncaSocket {
  public written: string[] = [];
  public destroyed = false;
  private dataHandler?: (chunk: string) => void;
  private connectHandler?: () => void;
  private closeHandler?: () => void;
  private errorHandler?: (err: Error) => void;

  public write(data: string): void {
    this.written.push(data);
  }
  public destroy(): void {
    this.destroyed = true;
  }
  public onData(handler: (chunk: string) => void): void {
    this.dataHandler = handler;
  }
  public onConnect(handler: () => void): void {
    this.connectHandler = handler;
  }
  public onClose(handler: () => void): void {
    this.closeHandler = handler;
  }
  public onError(handler: (err: Error) => void): void {
    this.errorHandler = handler;
  }

  public emitConnect(): void {
    this.connectHandler?.();
  }
  public emitData(chunk: string): void {
    this.dataHandler?.(chunk);
  }
  public emitClose(): void {
    this.closeHandler?.();
  }
  public emitError(err: Error): void {
    this.errorHandler?.(err);
  }
}

function fixtureFactory(): { factory: (host: string, port: number) => YncaSocket; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    factory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  };
}

describe("YncaClient", () => {
  test("resolves connect on the socket connect event and is reachable", async () => {
    const { factory, sockets } = fixtureFactory();
    const client = new YncaClient("1.2.3.4", testTimers, testGate(), factory);
    const connected = client.connect();
    sockets[0].emitConnect();
    await expect(connected).resolves.toBeUndefined();
    expect(client.isReachable()).toBe(true);
  });

  test("sends a command as a CRLF-terminated YNCA line", async () => {
    const { factory, sockets } = fixtureFactory();
    const client = new YncaClient("1.2.3.4", testTimers, testGate(), factory);
    const connected = client.connect();
    sockets[0].emitConnect();
    await connected;
    client.send("MAIN", "PWR", "On");
    expect(sockets[0].written).toContain("@MAIN:PWR=On\r\n");
  });

  test("sends a GET as =? terminated line", async () => {
    const { factory, sockets } = fixtureFactory();
    const client = new YncaClient("1.2.3.4", testTimers, testGate(), factory);
    const connected = client.connect();
    sockets[0].emitConnect();
    await connected;
    client.get("SYS", "MODELNAME");
    expect(sockets[0].written).toContain("@SYS:MODELNAME=?\r\n");
  });

  test("decodes incoming ok lines into messages", async () => {
    const { factory, sockets } = fixtureFactory();
    const client = new YncaClient("1.2.3.4", testTimers, testGate(), factory);
    const messages: unknown[] = [];
    client.onMessage(m => messages.push(m));
    const connected = client.connect();
    sockets[0].emitConnect();
    await connected;
    sockets[0].emitData("@MAIN:VOL=-30.0\r\n");
    expect(messages).toEqual([{ subunit: "MAIN", func: "VOL", value: "-30.0" }]);
  });

  test("ignores @UNDEFINED / @RESTRICTED lines", async () => {
    const { factory, sockets } = fixtureFactory();
    const client = new YncaClient("1.2.3.4", testTimers, testGate(), factory);
    const messages: unknown[] = [];
    client.onMessage(m => messages.push(m));
    const connected = client.connect();
    sockets[0].emitConnect();
    await connected;
    sockets[0].emitData("@UNDEFINED\r\n@RESTRICTED\r\n");
    expect(messages).toEqual([]);
  });

  test("close destroys the socket and marks unreachable", async () => {
    const { factory, sockets } = fixtureFactory();
    const client = new YncaClient("1.2.3.4", testTimers, testGate(), factory);
    const connected = client.connect();
    sockets[0].emitConnect();
    await connected;
    client.close();
    expect(sockets[0].destroyed).toBe(true);
    expect(client.isReachable()).toBe(false);
  });

  test("fires onDrop after an unexpected close and destroys the old socket, without reopening itself", async () => {
    const { factory, sockets } = fixtureFactory();
    const client = new YncaClient("1.2.3.4", testTimers, testGate(), factory);
    let dropped = 0;
    client.onDrop(() => dropped++);
    const connected = client.connect();
    sockets[0].emitConnect();
    await connected;

    sockets[0].emitClose();

    expect(client.isReachable()).toBe(false);
    expect(sockets[0].destroyed).toBe(true); // old socket closed (1 connection/receiver)
    expect(dropped).toBe(1); // the supervisor owns reconnect now
    expect(sockets).toHaveLength(1); // the client does not reopen on its own
  });

  test("delivers a drop that happened before onDrop was registered", async () => {
    const { factory, sockets } = fixtureFactory();
    const client = new YncaClient("1.2.3.4", testTimers, testGate(), factory);
    const connected = client.connect();
    sockets[0].emitConnect();
    await connected;

    // The socket drops in the window between connect and the supervisor wiring onDrop —
    // widened by the multi-transport boot (YXC + XML connect and the whole tree upsert
    // run before the handle's onDrop reaches this client). The drop must not be lost.
    sockets[0].emitClose();
    let dropped = 0;
    client.onDrop(() => dropped++);

    expect(dropped).toBe(1); // the latched drop fires as soon as onDrop registers
  });

  test("does not fire onDrop after an explicit close", async () => {
    const { factory, sockets } = fixtureFactory();
    const client = new YncaClient("1.2.3.4", testTimers, testGate(), factory);
    let dropped = 0;
    client.onDrop(() => dropped++);
    const connected = client.connect();
    sockets[0].emitConnect();
    await connected;

    client.close();
    sockets[0].emitClose(); // the socket's close event may still fire after destroy()

    expect(dropped).toBe(0);
    expect(sockets).toHaveLength(1);
  });

  test("readCapabilities sweeps the requested gets and builds capabilities from the responses", async () => {
    vi.useFakeTimers();
    try {
      const { factory, sockets } = fixtureFactory();
      const client = new YncaClient("1.2.3.4", testTimers, testGate(), factory);
      const connected = client.connect();
      sockets[0].emitConnect();
      await connected;

      const capsPromise = client.readCapabilities([
        { subunit: "SYS", func: "MODELNAME" },
        { subunit: "MAIN", func: "PWR" },
      ]);
      await vi.advanceTimersByTimeAsync(100);
      sockets[0].emitData("@SYS:MODELNAME=RX-A810\r\n");
      await vi.advanceTimersByTimeAsync(100);
      sockets[0].emitData("@MAIN:PWR=Standby\r\n");
      await vi.advanceTimersByTimeAsync(100);
      // The sweep ends on a CONFIRMED marker, not a guessed settle window: it asks
      // @SYS:VERSION=? last and finishes the moment the device answers it.
      expect(sockets[0].written).toContain("@SYS:VERSION=?\r\n");
      sockets[0].emitData("@SYS:VERSION=1.23\r\n");
      await vi.advanceTimersByTimeAsync(10);

      const caps = await capsPromise;
      expect(caps.model).toBe("RX-A810");
      expect(caps.subunits.MAIN?.PWR).toBe("Standby");
      expect(sockets[0].written).toContain("@SYS:MODELNAME=?\r\n");
      expect(sockets[0].written).toContain("@MAIN:PWR=?\r\n");
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  test("polls @SYS:MODELNAME=? as a keepalive every 30 s once started (after the sweep)", async () => {
    vi.useFakeTimers();
    try {
      const { factory, sockets } = fixtureFactory();
      const client = new YncaClient("1.2.3.4", testTimers, testGate(), factory);
      void client.connect();
      sockets[0].emitConnect();
      sockets[0].written.length = 0;

      // Not armed by connect alone — the controller starts it after the sweep.
      await vi.advanceTimersByTimeAsync(30000);
      expect(sockets[0].written).toEqual([]);

      client.startKeepalive();
      // The keepalive is a command like any other: it goes through the gate, so it lands
      // on the wire one queue turn later.
      await vi.advanceTimersByTimeAsync(30000);
      expect(sockets[0].written).toEqual(["@SYS:MODELNAME=?\r\n"]); // first keepalive
      await vi.advanceTimersByTimeAsync(30000);
      expect(sockets[0].written).toHaveLength(2); // self-rescheduled, still polling
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  test("cancels the keepalive on drop and on close, so no timer outlives the connection", () => {
    vi.useFakeTimers();
    try {
      const dropFx = fixtureFactory();
      const dropClient = new YncaClient("1.2.3.4", testTimers, testGate(), dropFx.factory);
      dropClient.onDrop(() => {});
      void dropClient.connect();
      dropFx.sockets[0].emitConnect();
      dropClient.startKeepalive();
      expect(vi.getTimerCount()).toBe(1); // keepalive armed
      dropFx.sockets[0].emitClose();
      expect(vi.getTimerCount()).toBe(0); // cancelled on drop

      const closeFx = fixtureFactory();
      const closeClient = new YncaClient("1.2.3.4", testTimers, testGate(), closeFx.factory);
      void closeClient.connect();
      closeFx.sockets[0].emitConnect();
      closeClient.startKeepalive();
      expect(vi.getTimerCount()).toBe(1);
      closeClient.close();
      expect(vi.getTimerCount()).toBe(0); // cancelled on close
    } finally {
      vi.useRealTimers();
    }
  });

  test("readCapabilities throws on a mid-sweep drop instead of returning a partial report", async () => {
    vi.useFakeTimers();
    try {
      const { factory, sockets } = fixtureFactory();
      const client = new YncaClient("1.2.3.4", testTimers, testGate(), factory);
      const connected = client.connect();
      sockets[0].emitConnect();
      await connected;
      const sweep = client.readCapabilities([
        { subunit: "SYS", func: "MODELNAME" },
        { subunit: "MAIN", func: "PWR" },
      ]);
      const assertion = expect(sweep).rejects.toThrow(/connection lost/); // attach handler now
      sockets[0].emitClose(); // drops while suspended at the first delay
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("onDrop receives the last socket error as the reason", async () => {
    const { factory, sockets } = fixtureFactory();
    const client = new YncaClient("1.2.3.4", testTimers, testGate(), factory);
    let reason: Error | undefined;
    client.onDrop(r => (reason = r));
    const connected = client.connect();
    sockets[0].emitConnect();
    await connected;
    sockets[0].emitError(new Error("ECONNRESET"));
    sockets[0].emitClose();
    expect(reason?.message).toBe("ECONNRESET");
  });

  test("does not fire onDrop for a socket that never connected (connect timeout)", async () => {
    const { factory, sockets } = fixtureFactory();
    const client = new YncaClient("1.2.3.4", testTimers, testGate(), factory);
    let dropped = 0;
    client.onDrop(() => dropped++);
    const connected = client.connect();
    sockets[0].emitError(new Error("connect timeout")); // errors before ever connecting
    sockets[0].emitClose();
    await expect(connected).rejects.toThrow(/connect timeout/);
    expect(dropped).toBe(0);
  });
});

describe("YncaClient on a real TCP socket", () => {
  beforeEach(() => {
    netMock.sockets.length = 0;
  });

  test("connects to the YNCA port and arms a connect deadline it clears on connect", async () => {
    const client = new YncaClient("192.168.1.10", testTimers, testGate());
    const connecting = client.connect();
    const socket = netMock.sockets[0];
    expect(socket.options).toEqual({ host: "192.168.1.10", port: 50000 });
    // A MusicCast-only speaker has no YNCA port and never answers. Without the
    // deadline the whole start-up hangs instead of falling back to YXC.
    expect(socket.timeouts).toEqual([5000]);

    socket.emit("connect");
    // Cleared on connect, or a quiet receiver would be torn down mid-session.
    expect(socket.timeouts).toEqual([5000, 0]);
    await connecting;
    client.close();
    expect(socket.destroyed).toBeTruthy();
  });

  test("tears the socket down when the device never answers", async () => {
    const client = new YncaClient("192.168.1.99", testTimers, testGate());
    const connecting = client.connect();
    const socket = netMock.sockets[0];
    socket.emit("timeout");
    expect((socket.destroyed as Error).message).toBe("connect timeout");
    socket.emit("error", socket.destroyed);
    socket.emit("close");
    await expect(connecting).rejects.toBeDefined();
    client.close();
  });

  test("writes a command out and hands received bytes to the message handler", async () => {
    const client = new YncaClient("192.168.1.10", testTimers, testGate());
    const messages: unknown[] = [];
    client.onMessage(m => messages.push(m));
    const connecting = client.connect();
    const socket = netMock.sockets[0];
    socket.emit("connect");
    await connecting;

    socket.written.length = 0;
    client.get("MAIN", "PWR");
    expect(socket.written.join("")).toContain("@MAIN:PWR=?");

    socket.emit("data", Buffer.from("@MAIN:PWR=On\r\n"));
    expect(messages).toContainEqual(expect.objectContaining({ subunit: "MAIN", func: "PWR", value: "On" }));
    client.close();
  });
});

describe("YncaClient refusal attribution (#615)", () => {
  it("attributes a @RESTRICTED right after a user PUT to that command", async () => {
    const { factory, sockets } = fixtureFactory();
    const client = new YncaClient("10.0.0.2", testTimers, testGate(), factory);
    const connect = client.connect();
    sockets[0].emitConnect();
    await connect;
    const refusals: Array<{ command: string; verdict: string }> = [];
    client.onRefusal((command, verdict) => refusals.push({ command, verdict }));
    client.send("MAIN", "SCENE", "Scene 1");
    await drain();
    // The 2012 generation's answer to a scene recall (ynca-python PRACTICALITIES).
    sockets[0].emitData("@RESTRICTED\r\n");
    expect(refusals).toEqual([{ command: "@MAIN:SCENE=Scene 1", verdict: "restricted" }]);
  });

  it("does not blame a user write for a sweep's @UNDEFINED noise", async () => {
    const { factory, sockets } = fixtureFactory();
    const client = new YncaClient("10.0.0.2", testTimers, testGate(), factory);
    const connect = client.connect();
    sockets[0].emitConnect();
    await connect;
    const refusals: string[] = [];
    client.onRefusal(command => refusals.push(command));
    // A background GET answered with @UNDEFINED — no user write pending, no refusal report.
    client.get("MAIN", "SCENE1NAME");
    await drain();
    sockets[0].emitData("@UNDEFINED\r\n");
    expect(refusals).toEqual([]);
  });

  it("reports one refusal once — a second @RESTRICTED is not re-attributed", async () => {
    const { factory, sockets } = fixtureFactory();
    const client = new YncaClient("10.0.0.2", testTimers, testGate(), factory);
    const connect = client.connect();
    sockets[0].emitConnect();
    await connect;
    const refusals: string[] = [];
    client.onRefusal(command => refusals.push(command));
    client.send("MAIN", "SCENE", "Scene 2");
    await drain();
    sockets[0].emitData("@RESTRICTED\r\n@RESTRICTED\r\n");
    expect(refusals).toEqual(["@MAIN:SCENE=Scene 2"]);
  });
});
