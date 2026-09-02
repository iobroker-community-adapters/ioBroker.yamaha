import { connect } from "node:net";
import { LineBuffer } from "./line-buffer";
import { decodeLine, encodeCommand, encodeGet, type YncaMessage } from "./protocol";
import { buildCapabilities, type YncaCapabilities } from "./capability";
import { CommandGateClosedError, type CommandGate } from "../lifecycle/command-gate";

/** The YNCA control port (TCP). */
export const YNCA_PORT = 50000;

/**
 * How long to wait for the sweep's closing marker before giving up on it. The sweep sends
 * `@SYS:VERSION=?` last and treats its answer as "the device has worked through the whole
 * batch" — the reference implementation uses the same marker (`ynca-python`
 * `subunit.py`: "Use SYS:VERSION as a sync since it is available on all receivers").
 * A fixed settle window instead of a marker silently loses functions on a busy receiver.
 */
const SWEEP_MARKER_TIMEOUT_MS = 5000;

/** Fail the initial connect after this long so a non-YNCA device falls through fast. */
const CONNECT_TIMEOUT_MS = 5000;

/**
 * How long after a user PUT a `@RESTRICTED`/`@UNDEFINED` line is still attributed to
 * it. Generous against a busy receiver, short enough that a sweep's refusals (which
 * follow their own GETs within the 100 ms spacing) never blame an old user write.
 */
const REFUSAL_ATTRIBUTION_MS = 2000;

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
  private refusalHandler: ((command: string, verdict: "restricted" | "undefined") => void) | undefined;
  /** The last user PUT actually written, so a refusal right after it can be attributed. */
  private lastUserWrite: { line: string; at: number } | undefined;
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
   * @param gate the device's command gate — EVERY line this client puts on the wire goes
   *   through it, so the specification's 100 ms spacing holds across user writes, the init
   *   sweep, the keepalive and browsing alike
   * @param factory socket factory (defaults to a node:net socket)
   */
  public constructor(
    private readonly host: string,
    private readonly timers: YncaTimers,
    private readonly gate: CommandGate,
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
      } else if (response.status === "restricted" || response.status === "undefined") {
        // A refusal carries no subunit, so it cannot be matched to a request by content.
        // But user PUTs are serialized through the gate, and the refusal arrives on their
        // heels — a refusal shortly after a user write is that write's verdict. Before
        // this, the device saying "I will not do that" was silently discarded and a dead
        // button (#615's scene recall) produced no trace at all. Background GETs are not
        // tracked: an init sweep legitimately collects hundreds of @UNDEFINED answers.
        const write = this.lastUserWrite;
        if (write && Date.now() - write.at <= REFUSAL_ATTRIBUTION_MS) {
          this.lastUserWrite = undefined;
          this.refusalHandler?.(write.line, response.status);
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
   * Send a PUT command. Queued as a USER command: a button press must not sit behind a
   * ~190-line init sweep.
   *
   * @param subunit target subunit (e.g. `MAIN`)
   * @param func function name (e.g. `PWR`)
   * @param value value to set
   */
  public send(subunit: string, func: string, value: string): void {
    const line = encodeCommand(subunit, func, value);
    void this.writeLine(line, "user").then(() => {
      // Recorded AFTER the gate actually wrote it — the refusal window starts on the wire,
      // not in the queue (a queued write behind a sweep would otherwise expire unseen).
      this.lastUserWrite = { line, at: Date.now() };
    });
  }

  /**
   * Register the handler called when the device REFUSES a user command
   * (`@RESTRICTED`: not possible right now / not allowed; `@UNDEFINED`: this model
   * does not know the function). The controller logs it — a dead button must leave
   * a trace.
   *
   * @param handler called with the refused command line and the device's verdict
   */
  public onRefusal(handler: (command: string, verdict: "restricted" | "undefined") => void): void {
    this.refusalHandler = handler;
  }

  /**
   * Send a GET request (background priority — reads yield to user commands).
   *
   * @param subunit target subunit
   * @param func function name
   */
  public get(subunit: string, func: string): void {
    void this.writeLine(encodeGet(subunit, func), "background");
  }

  /**
   * Put one line on the wire through the command gate — the single choke point that keeps
   * the specification's spacing. NEVER rejects: a closed gate is the normal teardown path,
   * and a socket write that fails reports through the socket's own error/close handlers
   * (the drop the supervisor reconnects on). A rejection here would surface as an
   * unhandled promise rejection in the fire-and-forget send()/get() callers — and
   * js-controller stops the adapter on those.
   *
   * @param line the encoded YNCA line (without the terminator)
   * @param priority user command or background read
   * @returns resolves once the line was written, or once it is clear it never will be
   */
  private writeLine(line: string, priority: "user" | "background"): Promise<void> {
    return this.gate
      .run(() => {
        this.socket?.write(`${line}\r\n`);
      }, priority)
      .catch((e: unknown) => {
        if (!(e instanceof CommandGateClosedError)) {
          this.lastError = e instanceof Error ? e : new Error(String(e));
        }
      });
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
   * Run an init sweep: send a GET for each requested function and collect the responses.
   *
   * Pacing is the command gate's job — every GET goes through it, so the sweep is spaced
   * against user writes and the keepalive instead of only against itself.
   *
   * The end of the sweep is CONFIRMED, not guessed: after the last GET the sweep sends
   * `@SYS:VERSION=?` as a closing marker and waits for its answer (every receiver answers
   * it — the reference implementation syncs on the same function). A fixed settle window
   * would silently drop the functions of a busy receiver that answers a moment late, and
   * those datapoints would then never be created.
   *
   * @param gets the subunit/function pairs to query
   * @returns the assembled capabilities
   */
  public async readCapabilities(gets: Array<{ subunit: string; func: string }>): Promise<YncaCapabilities> {
    const collected: YncaMessage[] = [];
    let markerSeen: (() => void) | undefined;
    const collector = (message: YncaMessage): void => {
      collected.push(message);
      if (message.subunit === "SYS" && message.func === "VERSION") {
        markerSeen?.();
      }
    };
    this.messageHandlers.push(collector);
    try {
      for (const request of gets) {
        // A drop mid-sweep makes the write a silent no-op; without this check the loop
        // would run to the end and hand back a partial report as if it were complete.
        if (!this.reachable) {
          throw new Error("connection lost during capability sweep");
        }
        await this.writeLine(encodeGet(request.subunit, request.func), "background");
      }
      if (!this.reachable) {
        throw new Error("connection lost during capability sweep");
      }
      await this.awaitSweepMarker(handler => (markerSeen = handler));
      return buildCapabilities(collected);
    } finally {
      const index = this.messageHandlers.indexOf(collector);
      if (index >= 0) {
        this.messageHandlers.splice(index, 1);
      }
    }
  }

  /**
   * Send the closing marker and wait for the device to answer it — or for the timeout,
   * so an unusual firmware that stays silent costs a delay, never the whole connection.
   *
   * @param arm registers the resolve callback with the sweep's collector
   * @returns resolves when the marker was answered or the wait timed out
   */
  private async awaitSweepMarker(arm: (handler: () => void) => void): Promise<void> {
    let settled = false;
    const answered = new Promise<void>(resolve => {
      arm(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
    });
    await this.writeLine(encodeGet("SYS", "VERSION"), "background");
    await Promise.race([
      answered,
      this.gate.delay(SWEEP_MARKER_TIMEOUT_MS).then(() => {
        settled = true;
      }),
    ]);
  }

  /** Whether the connection is currently up. */
  public isReachable(): boolean {
    return this.reachable;
  }

  /**
   * Close the connection permanently (no reconnect). Synchronous — safe to call from
   * onUnload. Closing the gate empties its queue and aborts its signal, so a sweep or a
   * browse walk that is still awaiting ends instead of hanging on a cancelled timer.
   */
  public close(): void {
    this.closed = true;
    this.reachable = false;
    this.stopKeepalive();
    this.gate.close();
    this.socket?.destroy();
    this.socket = undefined;
  }
}
