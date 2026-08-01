import { createSocket } from "node:dgram";

/** The UDP port MusicCast devices push unsolicited events to. */
const YXC_PUSH_PORT = 41100;

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

/** Logger the push receiver needs. */
interface Logger {
  debug: (message: string) => void;
  warn: (message: string) => void;
}

/**
 * The single UDP receiver for all MusicCast (YXC) devices. Yamaha devices send
 * unsolicited events to `<client-ip>:41100`; one socket serves every device and
 * routes each event to the handler registered for its source IP. If the port is
 * already taken (another MusicCast consumer on the host), it warns and lets the
 * adapter run poll-only rather than crashing onReady.
 */
export class YxcPushReceiver {
  private socket: YxcPushSocket | undefined;
  private readonly handlers = new Map<string, (event: unknown) => void>();

  /**
   * @param log logger for diagnostics
   * @param factory socket factory (defaults to a node:dgram socket)
   */
  public constructor(
    private readonly log: Logger,
    private readonly factory: PushSocketFactory = defaultFactory,
  ) {}

  /**
   * Register a handler for pushes from a device IP.
   *
   * @param ip the device IP, matched against the UDP source address
   * @param onPush invoked with each parsed push event from that IP
   */
  public register(ip: string, onPush: (event: unknown) => void): void {
    this.handlers.set(ip, onPush);
  }

  /** Open the shared socket and start listening on :41100. */
  public start(): void {
    const socket = this.factory();
    this.socket = socket;
    socket.onError(err => {
      this.log.warn(`YXC push port unavailable — MusicCast devices are polled, not pushed: ${err.message}`);
      this.socket = undefined;
    });
    socket.onMessage((payload, address) => this.dispatch(payload, address));
    socket.onListening(() => this.log.debug(`YXC push receiver listening on :${YXC_PUSH_PORT}`));
    socket.bind(YXC_PUSH_PORT);
  }

  /** Close the socket synchronously — safe to call from onUnload. */
  public close(): void {
    this.socket?.close();
    this.socket = undefined;
  }

  /**
   * Route one datagram to the handler for its source IP, ignoring unknown
   * senders and malformed payloads.
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
      this.log.debug(`ignoring malformed YXC push from ${address}`);
      return;
    }
    handler(event);
  }
}
