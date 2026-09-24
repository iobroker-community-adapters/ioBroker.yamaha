import { createSocket } from "node:dgram";
import { isIPv4, resolveIPv4 } from "../network-interfaces";
import { errorMessage } from "../util";

/** The UDP port MusicCast devices push unsolicited events to. */
const YXC_PUSH_PORT = 41100;

/** Rebind this long after a runtime socket error. */
const REBIND_DELAY_MS = 10000;

/**
 * Try the port again this often while another program holds it. The other MusicCast consumer
 * may stop later; without the retry only a restart of this adapter ever found the port free.
 */
const BIND_RETRY_DELAY_MS = 5 * 60 * 1000;

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
  log: { debug: (message: string) => void; info: (message: string) => void; warn: (message: string) => void };
  /** Schedule the rebind after a runtime socket error; returns a cancellable handle. */
  schedule(handler: () => void, ms: number): ioBroker.Timeout | undefined;
  /** Cancel a scheduled rebind. */
  cancel(handle: ioBroker.Timeout | undefined): void;
  /** Resolve a hostname registration to its IPv4 address (default: DNS; injectable for tests). */
  resolve?(host: string): Promise<string | undefined>;
}

/**
 * The single UDP receiver for all MusicCast (YXC) devices. Yamaha devices send
 * unsolicited events to `<client-ip>:41100`; one socket serves every device and
 * routes each event to the handler registered for its source IP.
 *
 * Error handling separates the two failure modes: a bind-time failure (the port is
 * already taken by another MusicCast consumer) is expected — it warns once, runs
 * poll-only and tries the port again every few minutes. A runtime error on an
 * already-listening socket closes the socket and rebinds after a short delay, so a
 * transient fault does not silently drop all devices to poll-only forever.
 * Registrations survive a rebind; the controllers notice a late bind by themselves
 * (they ask `isListening()` at every keepalive).
 */
export class YxcPushReceiver {
  private socket: YxcPushSocket | undefined;
  private readonly handlers = new Map<string, (event: unknown) => void>();
  /**
   * The same handlers by the MusicCast `device_id` the events carry (YXC Basic Rev 1.10 §11.3, from
   * API 1.17) — the fallback when the source address is not the registered one (audit 2026-09-24, C2).
   */
  private readonly byDeviceId = new Map<string, (event: unknown) => void>();
  private listening = false;
  private closed = false;
  private retryTimer: ioBroker.Timeout | undefined;
  /** Whether a bind failed since the last successful listen — the warning is given once, the recovery once. */
  private bindFailed = false;

  /**
   * @param deps adapter logger and timer callbacks
   * @param factory socket factory (defaults to a node:dgram socket)
   */
  public constructor(
    private readonly deps: YxcPushReceiverDeps,
    private readonly factory: PushSocketFactory = defaultFactory,
  ) {}

  /**
   * Register a handler for pushes from a device.
   *
   * A hostname is resolved first: the events arrive from the numeric address, and a row that kept
   * the name the 0.5.x adapter used never received one (audit 2026-09-24, C2).
   *
   * @param host the device address or hostname, matched against the UDP source address
   * @param onPush invoked with each parsed push event from that device
   * @param deviceId the device's MusicCast `device_id`, when known — matched against the events'
   * @returns a function that unregisters THIS handler (a later registration of the same device stays)
   */
  public register(host: string, onPush: (event: unknown) => void, deviceId?: string): () => void {
    const addresses: string[] = [];
    let active = true;
    const add = (ip: string): void => {
      this.handlers.set(ip, onPush);
      addresses.push(ip);
    };
    if (isIPv4(host)) {
      add(host);
    } else {
      void (this.deps.resolve ?? resolveIPv4)(host).then(ip => {
        if (ip && active) {
          add(ip);
        } else if (!ip) {
          this.deps.log.debug(`YXC push: ${host} does not resolve — its events are routed by device id only`);
        }
      });
    }
    const id = deviceId?.toUpperCase();
    if (id) {
      this.byDeviceId.set(id, onPush);
    }
    return () => {
      active = false;
      // Only this registration: a reconnect registers again BEFORE the old connection's cleanup
      // runs, and deleting by address took the new handler with it (audit 2026-09-24, C19).
      for (const ip of addresses) {
        if (this.handlers.get(ip) === onPush) {
          this.handlers.delete(ip);
        }
      }
      if (id && this.byDeviceId.get(id) === onPush) {
        this.byDeviceId.delete(id);
      }
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
      if (this.bindFailed) {
        this.bindFailed = false;
        this.deps.log.info(`YXC push port :${YXC_PUSH_PORT} became available — MusicCast devices are pushed again`);
      }
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
      // Bind-time failure: another MusicCast consumer holds the port. Expected — said once,
      // then tried again quietly until the port is free.
      const line = `YXC push port :${YXC_PUSH_PORT} unavailable — MusicCast devices are polled, not pushed: ${errorMessage(err)}`;
      if (this.bindFailed) {
        this.deps.log.debug(line);
      } else {
        this.bindFailed = true;
        this.deps.log.warn(line);
      }
      this.retryTimer = this.deps.schedule(() => this.start(), BIND_RETRY_DELAY_MS);
      return;
    }
    // Runtime error on a socket that was listening — not normal; rebind after a delay
    // (registrations survive). listening resets so a failed rebind falls back cleanly.
    this.listening = false;
    this.deps.log.warn(`YXC push socket error, rebinding in ${REBIND_DELAY_MS / 1000}s: ${errorMessage(err)}`);
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
    const byAddress = this.handlers.get(address);
    if (!byAddress && this.byDeviceId.size === 0) {
      return;
    }
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      this.deps.log.debug(`ignoring malformed YXC push from ${address}`);
      return;
    }
    const deviceId = (event as { device_id?: unknown } | null)?.device_id;
    const handler =
      byAddress ?? (typeof deviceId === "string" ? this.byDeviceId.get(deviceId.toUpperCase()) : undefined);
    handler?.(event);
  }
}
