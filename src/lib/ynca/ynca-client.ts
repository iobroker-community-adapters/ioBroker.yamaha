import { connect } from "node:net";
import { LineBuffer } from "./line-buffer";
import { decodeLine, encodeCommand, encodeGet, type YncaMessage } from "./protocol";
import { buildCapabilities, type YncaCapabilities } from "./capability";

/** The YNCA control port (TCP). */
export const YNCA_PORT = 50000;

/** Fail the initial connect after this long so a non-YNCA device falls through fast. */
const CONNECT_TIMEOUT_MS = 5000;

/**
 * Poll a keepalive this often while connected. The receiver closes an idle YNCA
 * socket after roughly a minute, so — with no keepalive — the connection drops and
 * the supervisor reconnects on a loop. The ynca protocol keeps it open by polling
 * `@SYS:MODELNAME=?` (supported by every model); the reference lib (python `ynca`)
 * uses the same 30 s interval.
 */
const KEEPALIVE_INTERVAL_MS = 30000;

/** Adapter-managed timers so the client leaks no native timers past onUnload. */
export interface YncaTimers {
  /** Schedule a one-shot timer; returns a handle to cancel it. */
  schedule(handler: () => void, ms: number): ioBroker.Timeout | undefined;
  /** Cancel a scheduled timer. */
  cancel(handle: ioBroker.Timeout | undefined): void;
}

/**
 * A small delay used to pace the init sweep.
 *
 * @param timers adapter-managed timers
 * @param ms milliseconds to wait
 * @returns a promise that resolves after the delay
 */
function delay(timers: YncaTimers, ms: number): Promise<void> {
  return new Promise(resolve => {
    timers.schedule(resolve, ms);
  });
}

// YncaMessage is the canonical shape defined in ./protocol; re-exported so existing
// importers keep resolving it from the client.
export type { YncaMessage };

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
 * is opened; reconnect and its backoff live one level up, in the supervisor.
 */
export class YncaClient {
  private socket: YncaSocket | undefined;
  private readonly lineBuffer = new LineBuffer();
  private readonly messageHandlers: Array<(message: YncaMessage) => void> = [];
  private dropHandler: ((reason?: Error) => void) | undefined;
  private reachable = false;
  private everReachable = false;
  private closed = false;
  private keepaliveTimer: ioBroker.Timeout | undefined;
  private lastError: Error | undefined;
  /** A genuine drop that fired before onDrop was registered — delivered once it is. */
  private pendingDrop = false;

  /**
   * @param host the receiver IP or hostname
   * @param timers adapter-managed timers, so no native timer outlives onUnload
   * @param factory socket factory (defaults to a node:net socket)
   */
  public constructor(
    private readonly host: string,
    private readonly timers: YncaTimers,
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
      this.everReachable = true;
      // Keepalive is started by the controller AFTER the init sweep (startKeepalive),
      // not here — a 30 s poll firing into the paced sweep would break its spacing.
      onFirstConnect?.();
    });
    socket.onData(chunk => this.handleData(chunk));
    socket.onClose(() => this.handleClose());
    socket.onError(err => {
      // Remember the cause so a later drop can report why; before the first connect
      // it also rejects the connect() promise.
      this.lastError = err;
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
    this.stopKeepalive();
    if (this.closed) {
      return;
    }
    // Fully close the old socket — the receiver allows only one YNCA connection, so
    // a lingering one would refuse the fresh connection. Reconnect lives one level
    // up in the supervisor (single level): report the drop and let it re-attempt,
    // which rebuilds/re-seeds through a fresh controller.
    this.socket?.destroy();
    this.socket = undefined;
    // Only a genuine drop (we were connected) fires onDrop; a socket that never
    // connected already rejected connect() and must not also signal a drop. If the
    // supervisor has not wired onDrop yet (its multi-transport boot registers it only
    // after every transport connected and the tree was built), latch the drop so it is
    // delivered the moment onDrop registers — otherwise this transport dies unnoticed.
    if (this.everReachable) {
      if (this.dropHandler) {
        this.dropHandler(this.lastError);
      } else {
        this.pendingDrop = true;
      }
    }
  }

  /**
   * Start the keepalive poll. Call once, AFTER the init sweep has finished — not on
   * connect — so the 30 s `@SYS:MODELNAME=?` poll never fires a command into the
   * paced sweep and breaks the ~100 ms spacing the receiver needs. The poll keeps
   * the otherwise-idle YNCA socket open (the ynca-spec keepalive, supported by every
   * model); it self-reschedules and is stopped on drop and on close.
   */
  public startKeepalive(): void {
    this.keepaliveTimer = this.timers.schedule(() => {
      this.get("SYS", "MODELNAME");
      this.startKeepalive();
    }, KEEPALIVE_INTERVAL_MS);
  }

  /** Cancel the keepalive timer, if any. */
  private stopKeepalive(): void {
    this.timers.cancel(this.keepaliveTimer);
    this.keepaliveTimer = undefined;
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
   * Register the handler called once when an established connection drops (not on an
   * explicit close, and not for a socket that never connected). The supervisor uses
   * it to reconnect; the optional reason is the last socket error, for logging.
   *
   * @param handler called on an unexpected drop, with the last error if any
   */
  public onDrop(handler: (reason?: Error) => void): void {
    this.dropHandler = handler;
    if (this.pendingDrop) {
      this.pendingDrop = false;
      handler(this.lastError);
    }
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
        // A drop mid-sweep makes get() a silent no-op; without this check the loop
        // would run to the end and hand back a partial report as if it were complete.
        if (!this.reachable) {
          throw new Error("connection lost during capability sweep");
        }
        this.get(request.subunit, request.func);
        await delay(this.timers, spacingMs);
      }
      if (!this.reachable) {
        throw new Error("connection lost during capability sweep");
      }
      await delay(this.timers, settleMs);
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
    this.stopKeepalive();
    this.socket?.destroy();
    this.socket = undefined;
  }
}
