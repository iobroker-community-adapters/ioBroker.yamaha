import { createSocket, type Socket } from "node:dgram";
import { errorMessage } from "./util";

/**
 * Passive SSDP: hear the `NOTIFY ssdp:alive` a UPnP device multicasts when it comes up. A
 * receiver that boots on a new address announces itself within seconds — the active M-SEARCH
 * (`main.ts` `ssdpSearch`) only hears what it asked for, and only when it asks. The listener
 * reports; what a report means (a known device moved, a newcomer, the periodic alive of a
 * running device) the adapter decides (`main.ts` `onSsdpAlive`).
 *
 * Socket shape as the sister adapter fakeroku's responder: `reuseAddr` because port 1900 is
 * shared with every other SSDP service on the host, a wildcard bind, and the group joined on
 * each interface the search leaves from. No own timers.
 */

const SSDP_PORT = 1900;
const MULTICAST_ADDR = "239.255.255.250";

/** What a NOTIFY says, reduced to the headers the adapter reads. */
export interface SsdpNotify {
  /** Coming up, or going away. */
  nts: "alive" | "byebye";
  /** The description URL (alive only). */
  location?: string;
  /** The unique service name (`uuid:…::upnp:rootdevice`). */
  usn?: string;
  /** The notification type (`upnp:rootdevice`, a device or service type). */
  nt?: string;
}

/**
 * One header's value, trimmed — header names are case-insensitive (RFC 2616 / UPnP DA).
 *
 * @param message the datagram text
 * @param name the header name
 * @returns the value, or undefined
 */
function header(message: string, name: string): string | undefined {
  const match = new RegExp(`^${name}:\\s*(.*?)\\s*$`, "im").exec(message);
  return match?.[1] || undefined;
}

/**
 * Read a NOTIFY datagram. Anything else on the group — M-SEARCH requests, search responses —
 * is not a notification and yields nothing.
 *
 * @param message the datagram text
 * @returns the notification, or undefined
 */
export function parseSsdpNotify(message: string): SsdpNotify | undefined {
  if (!/^NOTIFY \* HTTP\/1\.1/im.test(message)) {
    return undefined;
  }
  const nts = header(message, "NTS");
  if (nts !== "ssdp:alive" && nts !== "ssdp:byebye") {
    return undefined;
  }
  const location = header(message, "LOCATION");
  const usn = header(message, "USN");
  const nt = header(message, "NT");
  return {
    nts: nts === "ssdp:alive" ? "alive" : "byebye",
    ...(location ? { location } : {}),
    ...(usn ? { usn } : {}),
    ...(nt ? { nt } : {}),
  };
}

/** What the listener needs from the adapter. */
export interface SsdpListenerDeps {
  /** The interface addresses to join the group on; empty = the OS default. */
  interfaces: readonly string[];
  /** Adapter log. */
  log: { debug(message: string): void; info(message: string): void; warn(message: string): void };
  /**
   * A device announced itself.
   *
   * @param notify what it said
   * @param address where it said it from
   */
  onAlive(notify: SsdpNotify, address: string): void;
}

/** The passive half of discovery: one socket on the SSDP group, reporting every alive. */
export class SsdpListener {
  private socket: Socket | undefined;
  private failed = false;

  /**
   * @param deps interfaces, log and the alive callback
   */
  public constructor(private readonly deps: SsdpListenerDeps) {}

  /**
   * Bind on 1900 and join the group. Rejects on a bind error — the caller decides what the
   * adapter does without a listener (it searches periodically, as before).
   */
  public async start(): Promise<void> {
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const onBindError = (err: Error): void => reject(err);
      socket.once("error", onBindError);
      socket.bind(SSDP_PORT, () => {
        socket.removeListener("error", onBindError);
        this.joinGroup(socket);
        socket.on("error", (err: Error) => this.onSocketError(err));
        socket.on("message", (msg, rinfo) => this.onMessage(msg.toString("utf8"), rinfo.address));
        resolve();
      });
    });
    const joined = this.deps.interfaces.length > 0 ? this.deps.interfaces.join(", ") : "default interface";
    this.deps.log.debug(`SSDP listener on :${SSDP_PORT} (join: ${joined})`);
  }

  /** Close the socket. Synchronous and idempotent — safe from onUnload. */
  public close(): void {
    const socket = this.socket;
    this.socket = undefined;
    try {
      socket?.close();
    } catch {
      // already closed
    }
  }

  /**
   * Join the group on every interface — a failure on one warns and does not stop the others.
   *
   * @param socket the bound socket
   */
  private joinGroup(socket: Socket): void {
    const interfaces: Array<string | undefined> =
      this.deps.interfaces.length > 0 ? [...this.deps.interfaces] : [undefined];
    for (const iface of interfaces) {
      try {
        socket.addMembership(MULTICAST_ADDR, iface);
      } catch (e) {
        this.deps.log.warn(
          `SSDP multicast join failed on ${iface ?? "the default interface"}: ${errorMessage(e)} — address changes on that network are found by the periodic search only`,
        );
      }
    }
  }

  /**
   * A socket error after the bind: said once; the adapter keeps its periodic search.
   *
   * @param err the error
   */
  private onSocketError(err: Error): void {
    if (this.failed) {
      return;
    }
    this.failed = true;
    this.deps.log.warn(
      `SSDP listener failed: ${errorMessage(err)} — address changes are found by the periodic search only`,
    );
  }

  /**
   * One datagram from the group: only an alive reaches the adapter.
   *
   * @param message the datagram text
   * @param address the sender
   */
  private onMessage(message: string, address: string): void {
    const notify = parseSsdpNotify(message);
    if (!notify || notify.nts !== "alive") {
      return;
    }
    try {
      this.deps.onAlive(notify, address);
    } catch (e) {
      // The callback is the adapter's; a throw there must not end the socket's message loop.
      this.deps.log.warn(`SSDP listener: alive from ${address} not handled (${errorMessage(e)})`);
    }
  }
}
