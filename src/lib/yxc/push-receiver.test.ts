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
    this.listeningHandler?.();
  }
  public close(): void {
    this.closed = true;
  }
  public emitMessage(payload: string, address: string): void {
    this.messageHandler?.(payload, address);
  }
  public emitError(err: Error): void {
    this.errorHandler?.(err);
  }
}

const silentLog = { debug: (): void => {}, warn: (): void => {} };

describe("YxcPushReceiver", () => {
  test("binds the shared socket to :41100", () => {
    const fake = new FakeSocket();
    new YxcPushReceiver(silentLog, () => fake).start();
    expect(fake.boundPort).toBe(41100);
  });

  test("routes a push to the handler registered for its source ip", () => {
    const fake = new FakeSocket();
    const receiver = new YxcPushReceiver(silentLog, () => fake);
    const seen: unknown[] = [];
    receiver.register("192.168.1.5", e => seen.push(e));
    receiver.start();
    fake.emitMessage(JSON.stringify({ main: { power: "on" } }), "192.168.1.5");
    expect(seen).toEqual([{ main: { power: "on" } }]);
  });

  test("ignores a push from an unregistered ip", () => {
    const fake = new FakeSocket();
    const receiver = new YxcPushReceiver(silentLog, () => fake);
    receiver.register("192.168.1.5", () => {
      throw new Error("must not be called");
    });
    receiver.start();
    expect(() => fake.emitMessage("{}", "10.0.0.9")).not.toThrow();
  });

  test("survives a malformed payload without calling the handler", () => {
    const fake = new FakeSocket();
    const receiver = new YxcPushReceiver(silentLog, () => fake);
    let called = false;
    receiver.register("192.168.1.5", () => {
      called = true;
    });
    receiver.start();
    expect(() => fake.emitMessage("not json{{", "192.168.1.5")).not.toThrow();
    expect(called).toBe(false);
  });

  test("survives a bind error (port in use) with a warning, not a throw", () => {
    const fake = new FakeSocket();
    const warnings: string[] = [];
    const receiver = new YxcPushReceiver({ debug: () => {}, warn: m => warnings.push(m) }, () => fake);
    receiver.start();
    expect(() => fake.emitError(new Error("EADDRINUSE"))).not.toThrow();
    expect(warnings).toHaveLength(1);
  });

  test("close closes the socket", () => {
    const fake = new FakeSocket();
    const receiver = new YxcPushReceiver(silentLog, () => fake);
    receiver.start();
    receiver.close();
    expect(fake.closed).toBe(true);
  });
});
