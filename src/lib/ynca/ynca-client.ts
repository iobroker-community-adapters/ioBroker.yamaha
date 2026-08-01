import { connect } from "node:net";
import { LineBuffer } from "./line-buffer";
import { decodeLine, encodeCommand, encodeGet } from "./protocol";
import { ReconnectStrategy } from "./reconnect-strategy";
import { buildCapabilities, type YncaCapabilities } from "./capability";

/** The YNCA control port (TCP). */
export const YNCA_PORT = 50000;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
/** Fail the initial connect after this long so a non-YNCA device falls through fast. */
const CONNECT_TIMEOUT_MS = 5000;

/**
 * A small delay used to pace the init sweep.
 *
 * @param ms milliseconds to wait
 * @returns a promise that resolves after the delay
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/** A decoded message from the receiver. */
export interface YncaMessage {
  /** The subunit that reported (e.g. `MAIN`, `ZONE2`, `TUN`). */
  subunit: string;
  /** The function name (e.g. `PWR`, `VOL`). */
  func: string;
  /** The reported value. */
  value: string;
}

/** The minimal socket surface the client needs — abstracted so tests can inject a fake. */
export interface YncaSocket {
  /** Write raw data to the socket. */
  write(data: string): void;
  /** Close the socket. */
  destroy(): void;
  /** Register a handler for received data chunks. */
  onData(handler: (chunk: string) => void): void;
  /** Register a handler for the connect event. */
  onConnect(handler: () => void): void;
  /** Register a handler for the close event. */
  onClose(handler: () => void): void;
  /** Register a handler for socket errors. */
  onError(handler: (err: Error) => void): void;
}

/** Creates a socket connected to host:port. */
export type SocketFactory = (host: string, port: number) => YncaSocket;

/**
 * Default factory backed by node:net.
 *
 * @param host the receiver IP or hostname
 * @param port the TCP port
 * @returns a socket wrapper over a node:net connection
 */
function defaultFactory(host: string, port: number): YncaSocket {
  const socket = connect({ host, port });
  // Guard the initial connect: a device that never answers (a MusicCast-only
  // speaker has no YNCA port) must fail fast so main.ts can fall back to YXC
  // instead of hanging onReady. Cleared on connect; reconnect covers later drops.
  socket.setTimeout(CONNECT_TIMEOUT_MS);
  socket.on("timeout", () => socket.destroy(new Error("connect timeout")));
  socket.on("connect", () => socket.setTimeout(0));
  return {
    write: data => {
      socket.write(data);
    },
    destroy: () => {
      socket.destroy();
    },
    onData: handler => {
      socket.on("data", (chunk: Buffer) => handler(chunk.toString()));
    },
    onConnect: handler => {
      socket.on("connect", handler);
    },
    onClose: handler => {
      socket.on("close", handler);
    },
    onError: handler => {
      socket.on("error", handler);
    },
  };
}

/**
 * A YNCA transport client for one receiver over TCP. Only one YNCA connection per
 * receiver is allowed, so a dropped connection is fully closed before a fresh one
 * is opened, with exponential backoff.
 */
export class YncaClient {
  private socket: YncaSocket | undefined;
  private readonly lineBuffer = new LineBuffer();
  private readonly messageHandlers: Array<(message: YncaMessage) => void> = [];
  private readonly reconnect = new ReconnectStrategy(RECONNECT_BASE_MS, RECONNECT_MAX_MS);
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reachable = false;
  private closed = false;

  /**
   * @param host the receiver IP or hostname
   * @param factory socket factory (defaults to a node:net socket)
   */
  public constructor(
    private readonly host: string,
    private readonly factory: SocketFactory = defaultFactory,
  ) {}

  /**
   * Open the connection. Resolves on the first successful connect, rejects if the
   * first connection attempt errors before connecting.
   *
   * @returns a promise that resolves once connected
   */
  public connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.openSocket(resolve, reject);
    });
  }

  private openSocket(onFirstConnect?: () => void, onFirstError?: (err: Error) => void): void {
    const socket = this.factory(this.host, YNCA_PORT);
    this.socket = socket;
    socket.onConnect(() => {
      this.reachable = true;
      this.reconnect.reset();
      onFirstConnect?.();
    });
    socket.onData(chunk => this.handleData(chunk));
    socket.onClose(() => this.handleClose());
    socket.onError(err => {
      if (!this.reachable) {
        onFirstError?.(err);
      }
    });
  }

  private handleData(chunk: string): void {
    for (const line of this.lineBuffer.push(chunk)) {
      const response = decodeLine(line);
      if (response.status === "ok") {
        const message: YncaMessage = { subunit: response.subunit, func: response.func, value: response.value };
        for (const handler of this.messageHandlers) {
          handler(message);
        }
      }
    }
  }

  private handleClose(): void {
    this.reachable = false;
    if (this.closed) {
      return;
    }
    // Fully close the old socket before scheduling a reopen — the receiver allows
    // only one YNCA connection, so a lingering socket would refuse the new one.
    this.socket?.destroy();
    this.socket = undefined;
    this.reconnectTimer = setTimeout(() => this.openSocket(), this.reconnect.nextDelay());
  }

  /**
   * Send a PUT command.
   *
   * @param subunit target subunit (e.g. `MAIN`)
   * @param func function name (e.g. `PWR`)
   * @param value value to set
   */
  public send(subunit: string, func: string, value: string): void {
    this.socket?.write(`${encodeCommand(subunit, func, value)}\r\n`);
  }

  /**
   * Send a GET request.
   *
   * @param subunit target subunit
   * @param func function name
   */
  public get(subunit: string, func: string): void {
    this.socket?.write(`${encodeGet(subunit, func)}\r\n`);
  }

  /**
   * Register a handler for decoded messages from the receiver.
   *
   * @param handler called with each ok message
   */
  public onMessage(handler: (message: YncaMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  /**
   * Run an init sweep: send a GET for each requested function (paced by
   * `spacingMs`), collect the responses, and build a capability report once the
   * device has settled.
   *
   * @param gets the subunit/function pairs to query
   * @param spacingMs delay between GETs (YNCA needs ~100 ms between commands)
   * @param settleMs how long to wait after the last GET before building the report
   * @returns the assembled capabilities
   */
  public async readCapabilities(
    gets: Array<{ subunit: string; func: string }>,
    spacingMs = 100,
    settleMs = 500,
  ): Promise<YncaCapabilities> {
    const collected: YncaMessage[] = [];
    const collector = (message: YncaMessage): void => {
      collected.push(message);
    };
    this.messageHandlers.push(collector);
    try {
      for (const request of gets) {
        this.get(request.subunit, request.func);
        await delay(spacingMs);
      }
      await delay(settleMs);
      return buildCapabilities(collected);
    } finally {
      const index = this.messageHandlers.indexOf(collector);
      if (index >= 0) {
        this.messageHandlers.splice(index, 1);
      }
    }
  }

  /** Whether the connection is currently up. */
  public isReachable(): boolean {
    return this.reachable;
  }

  /** Close the connection permanently (no reconnect). Synchronous — safe to call from onUnload. */
  public close(): void {
    this.closed = true;
    this.reachable = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.socket?.destroy();
    this.socket = undefined;
  }
}
