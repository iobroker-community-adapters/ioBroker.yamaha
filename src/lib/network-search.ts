import { createSocket } from "node:dgram";
import { get as httpGet, type ClientRequest } from "node:http";
import { networkInterfaces } from "node:os";
import { errText } from "./err-text";
import { searchInterfaces } from "./network-interfaces";
import { ssdpHeader } from "./ssdp-header";
import { readDeviceResponse } from "./util";

/** Abort a discovery description fetch after this long, so a dead device cannot hang it. */
const FETCH_TIMEOUT_MS = 4000;
/** How often the discovery M-SEARCH is repeated — multicast is lossy, one dropped packet must not hide a receiver. */
const SSDP_SEARCH_BURST = 3;
/** Spacing between the repeated M-SEARCH sends, inside the collect window. */
const SSDP_SEARCH_INTERVAL_MS = 1000;

/** One answer to an M-SEARCH: where the description is, and who answered. */
export interface SearchResponder {
  /** The description URL (`LOCATION`). */
  location: string;
  /** The answering address. */
  address: string;
}

/** What the search needs from the adapter. */
export interface NetworkSearchDeps {
  /** The configured network interface (empty: every interface). */
  networkInterface(): string | undefined;
  /** The adapter's timer — it refuses new timers once the stop began. */
  setTimeout(callback: () => void, ms: number): unknown;
  /** Adapter log. */
  log: { info(message: string): void };
  /** A search problem, said once per key and then at debug. */
  warnOnce(key: string, message: string): void;
  /** Whether the adapter is stopping — then nothing is opened any more. */
  stopping(): boolean;
  /** The searches in flight, each one's finish — the adapter's unload ends them (audit 2026-09-29, E4). */
  searches: Set<() => void>;
  /** The description fetches in flight — the adapter's unload destroys them. */
  fetches: Set<ClientRequest>;
}

/**
 * The network half of discovery: the SSDP M-SEARCH and the fetch of a device's description — taken out of the adapter
 * class (review 2026-10-05, D). Neither opens anything once the adapter stops: a search started while the instance was
 * already unloading kept its sockets bound in the host process of compact mode (A12).
 */
export class NetworkSearch {
  /**
   * @param deps the adapter surface
   */
  public constructor(private readonly deps: NetworkSearchDeps) {}

  /**
   * Run an SSDP M-SEARCH and collect the responders' description URL and address.
   *
   * With a configured network interface the search leaves exactly that one; left empty it
   * leaves EVERY non-internal IPv4 interface at once (one socket each), because multicast
   * egress otherwise follows only the host's default route — on a multi-homed host whose
   * default route is not the AV network that means the receiver is never reached and nothing
   * is found. Responders from all interfaces are merged into one list; the caller
   * de-duplicates by address.
   *
   * @param target the search target (device type)
   * @param timeoutMs how long to collect responses
   * @returns the responders — none at once when the adapter is stopping
   */
  public search(target: string, timeoutMs: number): Promise<SearchResponder[]> {
    if (this.deps.stopping()) {
      return Promise.resolve([]);
    }
    return new Promise(resolve => {
      const bindAddrs = searchInterfaces(this.deps.networkInterface(), networkInterfaces());
      const responders: SearchResponder[] = [];
      const sockets: ReturnType<typeof createSocket>[] = [];
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.deps.searches.delete(finish);
        for (const socket of sockets) {
          try {
            socket.close();
          } catch {
            // already closed
          }
        }
        resolve(responders);
      };
      // Open one search socket bound to a single interface (or the default route when bindAddr
      // is undefined). Every socket shares the responders list and the one settle timeout.
      const searchFrom = (bindAddr: string | undefined): void => {
        const socket = createSocket("udp4");
        sockets.push(socket);
        socket.on("message", (msg, rinfo) => {
          const location = ssdpHeader(msg.toString(), "LOCATION");
          if (location) {
            responders.push({ location, address: rinfo.address });
          }
        });
        socket.on("error", err => {
          // One interface failing (typically a stale selected IP after a DHCP change) must not
          // kill the search on the others — warn and drop just this socket; the timeout still
          // resolves whatever the rest found.
          this.deps.warnOnce(
            `socket|${bindAddr ?? ""}`,
            `discovery socket failed${bindAddr ? ` on interface ${bindAddr}` : ""}: ${errText(err)}${
              bindAddr ? " — check the Network Interface setting" : ""
            }`,
          );
          try {
            socket.close();
          } catch {
            // already closed
          }
        });
        const sendSearch = (): void => {
          if (settled) {
            return;
          }
          const msearch = `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 3\r\nST: ${target}\r\n\r\n`;
          try {
            socket.send(msearch, 1900, "239.255.255.250");
          } catch {
            // socket already closed by an error above
          }
        };
        socket.bind(0, bindAddr, () => {
          // Pin OUTGOING multicast to this interface. bind() only sets the source address; the
          // egress interface is IP_MULTICAST_IF — without it the OS uses its default route, so
          // the search can leave the wrong NIC on a multi-homed host (Node dgram docs).
          if (bindAddr) {
            try {
              socket.setMulticastInterface(bindAddr);
            } catch {
              this.deps.log.info(
                `discovery: could not pin multicast egress to ${bindAddr} — using the default interface`,
              );
            }
          }
          // Multicast is lossy and a single request can be dropped — repeat the M-SEARCH a few
          // times inside the collect window so one lost packet does not hide a receiver.
          for (let i = 0; i < SSDP_SEARCH_BURST; i++) {
            this.deps.setTimeout(sendSearch, i * SSDP_SEARCH_INTERVAL_MS);
          }
        });
      };
      this.deps.searches.add(finish);
      // Configured → that one interface; empty → every non-internal IPv4; none usable → default route.
      if (bindAddrs.length === 0) {
        searchFrom(undefined);
      } else {
        for (const bindAddr of bindAddrs) {
          searchFrom(bindAddr);
        }
      }
      this.deps.setTimeout(finish, timeoutMs);
    });
  }

  /**
   * Fetch a URL over HTTP and resolve its body.
   *
   * @param url the URL to fetch
   * @returns the response body — rejects for a status outside 2xx, and at once when the adapter is stopping
   */
  public fetch(url: string): Promise<string> {
    if (this.deps.stopping()) {
      return Promise.reject(new Error(`not fetched, the adapter is stopping: ${url}`));
    }
    return new Promise((resolve, reject) => {
      const req = httpGet(url, res => {
        // Bytes decoded once (a friendlyName "Küche" split inside a character became "K��che" — and a
        // second id for the same device, audit 2026-09-24 A20), capped, and the status judged: a booting
        // receiver's 404/503 is no description, so the NOTIFY retry asks again instead of judging it
        // "no Yamaha" for good (review 2026-10-05, A32).
        readDeviceResponse(res, url).then(resolve, reject);
      });
      this.deps.fetches.add(req);
      req.on("close", () => this.deps.fetches.delete(req));
      req.on("error", reject);
      req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error(`fetch timed out: ${url}`)));
    });
  }
}
