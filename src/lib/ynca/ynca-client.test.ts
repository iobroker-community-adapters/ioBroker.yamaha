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
    const client = new YncaClient("1.2.3.4", testTimers, factory);
    const connected = client.connect();
    sockets[0].emitConnect();
    await expect(connected).resolves.toBeUndefined();
    expect(client.isReachable()).toBe(true);
  });

  test("sends a command as a CRLF-terminated YNCA line", async () => {
    const { factory, sockets } = fixtureFactory();
    const client = new YncaClient("1.2.3.4", testTimers, factory);
    const connected = client.connect();
    sockets[0].emitConnect();
    await connected;
    client.send("MAIN", "PWR", "On");
    expect(sockets[0].written).toContain("@MAIN:PWR=On\r\n");
  });

  test("sends a GET as =? terminated line", async () => {
    const { factory, sockets } = fixtureFactory();
    const client = new YncaClient("1.2.3.4", testTimers, factory);
    const connected = client.connect();
    sockets[0].emitConnect();
    await connected;
    client.get("SYS", "MODELNAME");
    expect(sockets[0].written).toContain("@SYS:MODELNAME=?\r\n");
  });

  test("decodes incoming ok lines into messages", async () => {
    const { factory, sockets } = fixtureFactory();
    const client = new YncaClient("1.2.3.4", testTimers, factory);
    const messages: unknown[] = [];
    client.onMessage((m) => messages.push(m));
    const connected = client.connect();
    sockets[0].emitConnect();
    await connected;
    sockets[0].emitData("@MAIN:VOL=-30.0\r\n");
    expect(messages).toEqual([{ subunit: "MAIN", func: "VOL", value: "-30.0" }]);
  });

  test("ignores @UNDEFINED / @RESTRICTED lines", async () => {
    const { factory, sockets } = fixtureFactory();
    const client = new YncaClient("1.2.3.4", testTimers, factory);
    const messages: unknown[] = [];
    client.onMessage((m) => messages.push(m));
    const connected = client.connect();
    sockets[0].emitConnect();
    await connected;
    sockets[0].emitData("@UNDEFINED\r\n@RESTRICTED\r\n");
    expect(messages).toEqual([]);
  });

  test("close destroys the socket and marks unreachable", async () => {
    const { factory, sockets } = fixtureFactory();
    const client = new YncaClient("1.2.3.4", testTimers, factory);
    const connected = client.connect();
    sockets[0].emitConnect();
    await connected;
    client.close();
    expect(sockets[0].destroyed).toBe(true);
    expect(client.isReachable()).toBe(false);
  });

  test("fires onDrop after an unexpected close and destroys the old socket, without reopening itself", async () => {
    const { factory, sockets } = fixtureFactory();
    const client = new YncaClient("1.2.3.4", testTimers, factory);
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

  test("does not fire onDrop after an explicit close", async () => {
    const { factory, sockets } = fixtureFactory();
    const client = new YncaClient("1.2.3.4", testTimers, factory);
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
      const client = new YncaClient("1.2.3.4", testTimers, factory);
      const connected = client.connect();
      sockets[0].emitConnect();
      await connected;

      const capsPromise = client.readCapabilities(
        [
          { subunit: "SYS", func: "MODELNAME" },
          { subunit: "MAIN", func: "PWR" },
        ],
        100,
        300,
      );
      await vi.advanceTimersByTimeAsync(100);
      sockets[0].emitData("@SYS:MODELNAME=RX-A810\r\n");
      await vi.advanceTimersByTimeAsync(100);
      sockets[0].emitData("@MAIN:PWR=Standby\r\n");
      await vi.advanceTimersByTimeAsync(300);

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
});
