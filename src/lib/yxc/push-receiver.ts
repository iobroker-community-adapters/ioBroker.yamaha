import { createSocket } from "node:dgram";

/** The UDP port MusicCast devices push unsolicited events to. */
const YXC_PUSH_PORT = 41100;

/** Rebind this long after a runtime socket error (a bind-time failure is not retried). */
const REBIND_DELAY_MS = 10000;

/** The parts of a UDP socket the push receiver uses (a seam for testing). */
export interface YxcPushSocket {
  /** Register a handler for received datagrams (payload text + source address). */
  onMessage(handler: (payload: string, address: string) => void): void;
  /** Register a handler for socket errors (e.g. the port already in use). */
  onError(handler: (err: Error) => void): void;
  /** Register a handler for the listening event. */
  onListening(handler: () => void): void;
  /** Bind the socket to a port. */
  bind(port: number): void;
  /** Close the socket. */
  close(): void;
}

/** Creates the shared UDP socket. */
export type PushSocketFactory = () => YxcPushSocket;

/**
 * Default factory backed by node:dgram.
 *
 * @returns a socket wrapper over a node:dgram udp4 socket
 */
function defaultFactory(): YxcPushSocket {
  const socket = createSocket("udp4");
  return {
    onMessage: handler => {
      socket.on("message", (msg: Buffer, rinfo) => handler(msg.toString(), rinfo.address));
    },
    onError: handler => {
      socket.on("error", handler);
    },
    onListening: handler => {
      socket.on("listening", handler);
    },
    bind: port => {
      socket.bind(port);
    },
    close: () => {
      socket.close();
    },
  };
}

/** The callbacks the push receiver needs from the adapter. */
export interface YxcPushReceiverDeps {
  /** Diagnostics. */
  log: { debug: (message: string) => void; warn: (message: string) => void };
  /** Schedule the rebind after a runtime socket error; returns a cancellable handle. */
  schedule(handler: () => void, ms: number): ioBroker.Timeout | undefined;
  /** Cancel a scheduled rebind. */
  cancel(handle: ioBroker.Timeout | undefined): void;
}

/**
 * The single UDP receiver for all MusicCast (YXC) devices. Yamaha devices send
 * unsolicited events to `<client-ip>:41100`; one socket serves every device and
 * routes each event to the handler registered for its source IP.
 *
 * Error handling separates the two failure modes: a bind-time failure (the port is
 * already taken by another MusicCast consumer) is expected — it warns and runs
 * poll-only, no retry. A runtime error on an already-listening socket closes the
 * socket and rebinds after a delay, so a transient fault does not silently drop all
 * devices to poll-only forever. Registrations survive a rebind.
 */
export class YxcPushReceiver {
  private socket: YxcPushSocket | undefined;
  private readonly handlers = new Map<string, (event: unknown) => void>();
  private listening = false;
  private closed = false;
  private retryTimer: ioBroker.Timeout | undefined;

  /**
   * @param deps adapter logger and timer callbacks
   * @param factory socket factory (defaults to a node:dgram socket)
   */
  public constructor(
    private readonly deps: YxcPushReceiverDeps,
    private readonly factory: PushSocketFactory = defaultFactory,
  ) {}

  /**
   * Register a handler for pushes from a device IP.
   *
   * @param ip the device IP, matched against the UDP source address
   * @param onPush invoked with each parsed push event from that IP
   * @returns a function that unregisters this handler
   */
  public register(ip: string, onPush: (event: unknown) => void): () => void {
    this.handlers.set(ip, onPush);
    return () => {
      this.handlers.delete(ip);
    };
  }

  /** Open the shared socket and start listening on :41100. */
  public start(): void {
    const socket = this.factory();
    this.socket = socket;
    socket.onError(err => this.handleError(err));
    socket.onMessage((payload, address) => this.dispatch(payload, address));
    socket.onListening(() => {
      this.listening = true;
      this.deps.log.debug(`YXC push receiver listening on :${YXC_PUSH_PORT}`);
    });
    socket.bind(YXC_PUSH_PORT);
  }

  private handleError(err: Error): void {
    // Close the failed socket rather than orphaning it — node:dgram does not close it
    // on 'error', and a lingering reference makes close() below a silent no-op.
    this.socket?.close();
    this.socket = undefined;
    if (this.closed) {
      return;
    }
    if (!this.listening) {
      // Bind-time failure: another MusicCast consumer holds the port. Expected.
      this.deps.log.warn(
        `YXC push port :${YXC_PUSH_PORT} unavailable — MusicCast devices are polled, not pushed: ${err.message}`,
      );
      return;
    }
    // Runtime error on a socket that was listening — not normal; rebind after a delay
    // (registrations survive). listening resets so a failed rebind falls back cleanly.
    this.listening = false;
    this.deps.log.warn(`YXC push socket error, rebinding in ${REBIND_DELAY_MS / 1000}s: ${err.message}`);
    this.retryTimer = this.deps.schedule(() => this.start(), REBIND_DELAY_MS);
  }

  /**
   * Whether events are actually arriving — i.e. the socket is bound and devices can push.
   * When the port is taken by another MusicCast application the adapter runs poll-only,
   * and the controllers have to widen their polling to compensate.
   *
   * @returns true while the receiver is listening
   */
  public isListening(): boolean {
    return this.listening && !this.closed;
  }

  /** Close the socket and cancel any pending rebind. Synchronous — safe from onUnload. */
  public close(): void {
    this.closed = true;
    this.deps.cancel(this.retryTimer);
    this.retryTimer = undefined;
    this.socket?.close();
    this.socket = undefined;
  }

  /**
   * Route one datagram to the handler for its source IP, ignoring unknown senders
   * and malformed payloads.
   *
   * @param payload the datagram payload text
   * @param address the source IP
   */
  private dispatch(payload: string, address: string): void {
    const handler = this.handlers.get(address);
    if (!handler) {
      return;
    }
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      this.deps.log.debug(`ignoring malformed YXC push from ${address}`);
      return;
    }
    handler(event);
  }
}
