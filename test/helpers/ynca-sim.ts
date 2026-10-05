import type { YncaSocket, YncaTimers } from "../../src/lib/ynca/ynca-client";

/**
 * A simulated YNCA receiver behind a socket: it answers every line written to it after `latency` ms, in wire order,
 * from its value table — a GET with the value (or `@UNDEFINED` for a function it does not have), a PUT that changes a
 * value with the new value. A test-only device for the real client, so a whole controller start runs against it.
 */
export class SimSocket implements YncaSocket {
  /** Every line written, without its terminator. */
  public written: string[] = [];
  public destroyed = false;
  private dataHandler?: (chunk: Uint8Array | string) => void;
  private connectHandler?: () => void;
  private closeHandler?: () => void;

  /**
   * @param latency how long the device takes to answer a line, in ms
   * @param values the device's functions: `SUBUNIT:FUNC` → value
   * @param refuse the functions it answers with a refusal (`@UNDEFINED` to a GET, `@RESTRICTED` to a PUT)
   */
  public constructor(
    public latency: number,
    public values: Record<string, string>,
    public refuse: ReadonlySet<string> = new Set(),
  ) {}

  /**
   * Lines the client writes — each answered after the latency.
   *
   * @param data the written bytes
   */
  public write(data: string | Uint8Array): void {
    const text = typeof data === "string" ? data : Buffer.from(data).toString("latin1");
    for (const line of text.split(/\r\n/).filter(part => part.length > 0)) {
      this.written.push(line);
      const match = /^@([A-Z0-9]+):([A-Z0-9]+)=(.*)$/.exec(line);
      if (!match) {
        continue;
      }
      const [, subunit, func, value] = match;
      const key = `${subunit}:${func}`;
      let answer: string | undefined;
      if (value === "?") {
        answer = this.refuse.has(key) || this.values[key] === undefined ? "@UNDEFINED" : `@${key}=${this.values[key]}`;
      } else if (this.refuse.has(key)) {
        answer = "@RESTRICTED";
      } else if (this.values[key] !== value) {
        this.values[key] = value;
        answer = `@${key}=${value}`;
      }
      if (answer !== undefined) {
        const reply = `${answer}\r\n`;
        setTimeout(() => this.dataHandler?.(reply), this.latency);
      }
    }
  }

  /** Recorded only. */
  public destroy(): void {
    this.destroyed = true;
  }

  /**
   * The client's data handler.
   *
   * @param handler called with every chunk the device sends
   */
  public onData(handler: (chunk: Uint8Array | string) => void): void {
    this.dataHandler = handler;
  }

  /**
   * The client's connect handler.
   *
   * @param handler called on {@link emitConnect}
   */
  public onConnect(handler: () => void): void {
    this.connectHandler = handler;
  }

  /**
   * The client's close handler.
   *
   * @param handler called on {@link emitClose}
   */
  public onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  /** The simulated socket never errors. */
  public onError(): void {}

  /** The socket connected. */
  public emitConnect(): void {
    this.connectHandler?.();
  }

  /**
   * A chunk the device sends on its own.
   *
   * @param chunk the bytes
   */
  public emitData(chunk: string): void {
    this.dataHandler?.(chunk);
  }

  /** The device closed the connection. */
  public emitClose(): void {
    this.closeHandler?.();
  }
}

/** Timers on the global clock, so `vi.useFakeTimers()` drives them (the adapter injects its own). */
export const simTimers: YncaTimers = {
  schedule: (handler: () => void, ms: number): ioBroker.Timeout =>
    setTimeout(handler, ms) as unknown as ioBroker.Timeout,
  cancel: (handle: ioBroker.Timeout | undefined): void =>
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
};
