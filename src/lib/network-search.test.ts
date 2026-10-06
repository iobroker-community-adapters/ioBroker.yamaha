import { vi } from "vitest";

/** A fake http.get answering with a status and a body, and a fake dgram socket that records its traffic. */
const net = vi.hoisted(() => ({
  status: 200,
  body: "",
  sockets: [] as Array<{ handlers: Record<string, (...a: unknown[]) => void>; closed: boolean }>,
}));
vi.mock("node:http", () => ({
  // http.get(url, options, cb) — the options carry the source address where one is picked.
  get: (_url: string, _options: unknown, cb: (res: unknown) => void) => {
    const req = { on: () => req, setTimeout: () => req, destroy: () => undefined };
    queueMicrotask(() => {
      const handlers: Record<string, (...a: unknown[]) => void> = {};
      cb({
        statusCode: net.status,
        on: (ev: string, h: (...a: unknown[]) => void) => {
          handlers[ev] = h;
          if (ev === "end") {
            handlers.data?.(Buffer.from(net.body));
            h();
          }
        },
        destroy: () => undefined,
      });
    });
    return req;
  },
}));
vi.mock("node:dgram", () => ({
  createSocket: () => {
    const socket = {
      handlers: {} as Record<string, (...a: unknown[]) => void>,
      closed: false,
      on: (ev: string, h: (...a: unknown[]) => void) => {
        socket.handlers[ev] = h;
        return socket;
      },
      bind: (_port: number, _addr: string | undefined, cb: () => void) => cb(),
      setMulticastInterface: () => undefined,
      send: () => undefined,
      close: () => {
        socket.closed = true;
      },
    };
    net.sockets.push(socket);
    return socket;
  },
}));

import { NetworkSearch, type NetworkSearchDeps } from "./network-search";
import { probeDescription } from "./discovery";
import { HttpStatusError } from "./util";

function search(over: Partial<NetworkSearchDeps> = {}): { network: NetworkSearch; timers: Array<() => void> } {
  const timers: Array<() => void> = [];
  const network = new NetworkSearch({
    networkInterface: () => "192.168.1.2",
    setTimeout: callback => timers.push(callback),
    log: { info: () => undefined },
    warnOnce: () => undefined,
    stopping: () => false,
    searches: new Set(),
    fetches: new Set(),
    ...over,
  });
  return { network, timers };
}

const DESCRIPTION =
  "<root><device><manufacturer>Yamaha Corporation</manufacturer><friendlyName>Kitchen</friendlyName></device></root>";

beforeEach(() => {
  net.status = 200;
  net.body = DESCRIPTION;
  net.sockets.length = 0;
});

describe("NetworkSearch.fetch — the description of a device", () => {
  // Review 2026-10-05, A32: a booting receiver answers 404/503 before its description is up. Taken as a body, the
  // announcement was judged "no Yamaha" for a minute; rejected, the NOTIFY path asks again after five seconds.
  test("a 503 rejects with the status, and the description probe reads it as 'ask again', not as 'no Yamaha'", async () => {
    net.status = 503;
    const { network } = search();
    await expect(network.fetch("http://192.168.1.20/desc.xml")).rejects.toBeInstanceOf(HttpStatusError);
    const log = { debug: vi.fn(), warn: vi.fn() };
    const found = await probeDescription(
      { fetch: url => network.fetch(url), log },
      "http://192.168.1.20/desc.xml",
      "192.168.1.20",
    );
    expect(found).toBeUndefined(); // undefined = could not be read → the 5-second retry; null would be final
  });

  test("a 200 description of a Yamaha is a device", async () => {
    const { network } = search();
    const log = { debug: vi.fn(), warn: vi.fn() };
    await expect(
      probeDescription({ fetch: url => network.fetch(url), log }, "http://192.168.1.20/desc.xml", "192.168.1.20"),
    ).resolves.toMatchObject({ ip: "192.168.1.20", name: "Kitchen" });
  });

  test("nothing is fetched while the adapter stops", async () => {
    const { network } = search({ stopping: () => true });
    await expect(network.fetch("http://192.168.1.20/desc.xml")).rejects.toThrow(/stopping/);
  });
});

describe("NetworkSearch.search — the M-SEARCH", () => {
  test("takes LOCATION only as a header of its own line", async () => {
    const { network, timers } = search();
    const pending = network.search("upnp:rootdevice", 5000);
    const message = net.sockets[0].handlers.message;
    message(Buffer.from("HTTP/1.1 200 OK\r\nX-LOCATION: http://10.0.0.9/x.xml\r\nST: upnp:rootdevice\r\n\r\n"), {
      address: "10.0.0.9",
    });
    message(Buffer.from("HTTP/1.1 200 OK\r\nLocation: http://10.0.0.5/desc.xml\r\n\r\n"), { address: "10.0.0.5" });
    timers.at(-1)!(); // the collect window ends
    await expect(pending).resolves.toEqual([{ location: "http://10.0.0.5/desc.xml", address: "10.0.0.5" }]);
    expect(net.sockets[0].closed).toBe(true);
  });

  test("opens nothing while the adapter stops", async () => {
    const { network } = search({ stopping: () => true });
    await expect(network.search("upnp:rootdevice", 5000)).resolves.toEqual([]);
    expect(net.sockets).toHaveLength(0);
  });

  test("a search in flight is registered, and its finish ends it", async () => {
    const searches = new Set<() => void>();
    const { network } = search({ searches });
    const pending = network.search("upnp:rootdevice", 5000);
    expect(searches.size).toBe(1);
    [...searches][0]();
    await expect(pending).resolves.toEqual([]);
    expect(searches.size).toBe(0);
  });
});
