import { YncaClient } from "./ynca-client";
import type { YncaSocket } from "./ynca-client";

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
    const client = new YncaClient("1.2.3.4", factory);
    const connected = client.connect();
    sockets[0].emitConnect();
    await expect(connected).resolves.toBeUndefined();
    expect(client.isReachable()).toBe(true);
  });

  test("sends a command as a CRLF-terminated YNCA line", async () => {
    const { factory, sockets } = fixtureFactory();
    const client = new YncaClient("1.2.3.4", factory);
    const connected = client.connect();
    sockets[0].emitConnect();
    await connected;
    client.send("MAIN", "PWR", "On");
    expect(sockets[0].written).toContain("@MAIN:PWR=On\r\n");
  });

  test("sends a GET as =? terminated line", async () => {
    const { factory, sockets } = fixtureFactory();
    const client = new YncaClient("1.2.3.4", factory);
    const connected = client.connect();
    sockets[0].emitConnect();
    await connected;
    client.get("SYS", "MODELNAME");
    expect(sockets[0].written).toContain("@SYS:MODELNAME=?\r\n");
  });

  test("decodes incoming ok lines into messages", async () => {
    const { factory, sockets } = fixtureFactory();
    const client = new YncaClient("1.2.3.4", factory);
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
    const client = new YncaClient("1.2.3.4", factory);
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
    const client = new YncaClient("1.2.3.4", factory);
    const connected = client.connect();
    sockets[0].emitConnect();
    await connected;
    client.close();
    expect(sockets[0].destroyed).toBe(true);
    expect(client.isReachable()).toBe(false);
  });

  test("reconnects after an unexpected close, opening a fresh socket only after the old one is destroyed", async () => {
    vi.useFakeTimers();
    try {
      const { factory, sockets } = fixtureFactory();
      const client = new YncaClient("1.2.3.4", factory);
      const connected = client.connect();
      sockets[0].emitConnect();
      await connected;

      sockets[0].emitClose();
      expect(client.isReachable()).toBe(false);
      expect(sockets).toHaveLength(1); // not reopened synchronously
      expect(sockets[0].destroyed).toBe(true); // old socket closed first (1 connection/receiver)

      await vi.advanceTimersByTimeAsync(1000); // backoff base delay
      expect(sockets).toHaveLength(2); // fresh socket opened
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not reconnect after an explicit close", async () => {
    vi.useFakeTimers();
    try {
      const { factory, sockets } = fixtureFactory();
      const client = new YncaClient("1.2.3.4", factory);
      const connected = client.connect();
      sockets[0].emitConnect();
      await connected;
      client.close();
      await vi.advanceTimersByTimeAsync(60000);
      expect(sockets).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
