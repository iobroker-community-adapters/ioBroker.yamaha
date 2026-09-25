import type { Mock } from "vitest";
import { parseSsdpNotify, SsdpListener } from "./ssdp-listener";

// dgram is mocked so the bind/membership wiring and the failure paths are unit-testable
// without a real socket — the same double the sister adapter fakeroku uses for its responder.
const dgramMock = vi.hoisted(() => {
  interface FakeSocket {
    options: unknown;
    boundTo: Array<{ port: unknown; address: unknown }>;
    membership: Array<[string, string | undefined]>;
    closed: number;
    handlers: Record<string, Array<(...a: unknown[]) => void>>;
    once: (ev: string, cb: (...a: unknown[]) => void) => FakeSocket;
    on: (ev: string, cb: (...a: unknown[]) => void) => FakeSocket;
    removeListener: (ev: string, cb: (...a: unknown[]) => void) => FakeSocket;
    bind: (port: unknown, cb?: () => void) => FakeSocket;
    addMembership: (addr: string, iface?: string) => void;
    close: () => void;
    emit: (ev: string, ...args: unknown[]) => void;
  }
  const sockets: FakeSocket[] = [];
  const fail = { bind: false, join: false, close: false };
  const make = (options?: unknown): FakeSocket => {
    const s: FakeSocket = {
      options,
      boundTo: [],
      membership: [],
      closed: 0,
      handlers: {},
      once: (ev, cb) => s.on(ev, cb),
      on: (ev, cb) => {
        (s.handlers[ev] ??= []).push(cb);
        return s;
      },
      removeListener: (ev, cb) => {
        s.handlers[ev] = (s.handlers[ev] ?? []).filter(h => h !== cb);
        return s;
      },
      bind: (port, cb) => {
        s.boundTo.push({ port, address: typeof cb === "function" ? undefined : cb });
        if (fail.bind) {
          s.emit("error", new Error("EADDRINUSE"));
        } else if (typeof cb === "function") {
          cb();
        }
        return s;
      },
      addMembership: (addr, iface) => {
        if (fail.join) {
          throw new Error("ENODEV");
        }
        s.membership.push([addr, iface]);
      },
      close: () => {
        if (fail.close) {
          throw new Error("ERR_SOCKET_DGRAM_NOT_RUNNING");
        }
        s.closed++;
      },
      emit: (ev, ...args) => {
        (s.handlers[ev] ?? []).forEach(h => h(...args));
      },
    };
    sockets.push(s);
    return s;
  };
  return { sockets, make, fail };
});
vi.mock("node:dgram", () => ({ createSocket: (options: unknown) => dgramMock.make(options) }));

const { sockets, fail } = dgramMock;

function log(): { debug: Mock; info: Mock; warn: Mock } {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

beforeEach(() => {
  sockets.length = 0;
  fail.bind = false;
  fail.join = false;
  fail.close = false;
});

describe("parseSsdpNotify", () => {
  const alive = [
    "NOTIFY * HTTP/1.1",
    "HOST: 239.255.255.250:1900",
    "CACHE-CONTROL: max-age=1800",
    "LOCATION: http://10.47.88.7:49154/desc.xml",
    "NT: upnp:rootdevice",
    "NTS: ssdp:alive",
    "USN: uuid:00000000-0000-1000-8000-00a0de0a1b2c::upnp:rootdevice",
    "",
    "",
  ].join("\r\n");

  test("reads an alive notify", () => {
    expect(parseSsdpNotify(alive)).toEqual({
      nts: "alive",
      location: "http://10.47.88.7:49154/desc.xml",
      nt: "upnp:rootdevice",
      usn: "uuid:00000000-0000-1000-8000-00a0de0a1b2c::upnp:rootdevice",
    });
  });

  test("header names are case-insensitive, values are trimmed", () => {
    expect(parseSsdpNotify("NOTIFY * HTTP/1.1\r\nnts:  ssdp:alive \r\nLocation: http://x/d.xml  \r\n\r\n")).toEqual({
      nts: "alive",
      location: "http://x/d.xml",
    });
  });

  test("reads a byebye without location", () => {
    expect(parseSsdpNotify("NOTIFY * HTTP/1.1\r\nNTS: ssdp:byebye\r\nUSN: uuid:x::upnp:rootdevice\r\n\r\n")).toEqual({
      nts: "byebye",
      usn: "uuid:x::upnp:rootdevice",
    });
  });

  test("ignores an M-SEARCH, a search response and a NOTIFY with an unknown NTS", () => {
    expect(parseSsdpNotify('M-SEARCH * HTTP/1.1\r\nMAN: "ssdp:discover"\r\n\r\n')).toBeUndefined();
    expect(parseSsdpNotify("HTTP/1.1 200 OK\r\nLOCATION: http://x/d.xml\r\n\r\n")).toBeUndefined();
    expect(parseSsdpNotify("NOTIFY * HTTP/1.1\r\nNTS: ssdp:update\r\n\r\n")).toBeUndefined();
  });
});

describe("SsdpListener", () => {
  test("binds 1900 with reuseAddr (the port is shared with other SSDP services) and joins the group on every interface", async () => {
    const listener = new SsdpListener({ interfaces: ["10.0.0.5", "192.168.1.5"], log: log(), onAlive: vi.fn() });
    await listener.start();
    expect(sockets[0].options).toEqual({ type: "udp4", reuseAddr: true });
    expect(sockets[0].boundTo).toEqual([{ port: 1900, address: undefined }]);
    expect(sockets[0].membership).toEqual([
      ["239.255.255.250", "10.0.0.5"],
      ["239.255.255.250", "192.168.1.5"],
    ]);
  });

  test("without interfaces it joins on the OS default", async () => {
    await new SsdpListener({ interfaces: [], log: log(), onAlive: vi.fn() }).start();
    expect(sockets[0].membership).toEqual([["239.255.255.250", undefined]]);
  });

  test("hands an alive notify to the callback with the sender address, and drops byebye and noise", async () => {
    const onAlive = vi.fn();
    await new SsdpListener({ interfaces: [], log: log(), onAlive }).start();
    sockets[0].emit(
      "message",
      Buffer.from("NOTIFY * HTTP/1.1\r\nNTS: ssdp:alive\r\nLOCATION: http://1.2.3.4/d.xml\r\n\r\n"),
      {
        address: "1.2.3.4",
      },
    );
    sockets[0].emit("message", Buffer.from("NOTIFY * HTTP/1.1\r\nNTS: ssdp:byebye\r\n\r\n"), { address: "1.2.3.4" });
    sockets[0].emit("message", Buffer.from('M-SEARCH * HTTP/1.1\r\nMAN: "ssdp:discover"\r\n\r\n'), {
      address: "1.2.3.5",
    });
    expect(onAlive).toHaveBeenCalledTimes(1);
    expect(onAlive).toHaveBeenCalledWith({ nts: "alive", location: "http://1.2.3.4/d.xml" }, "1.2.3.4");
  });

  test("a callback that throws does not take the socket down", async () => {
    const l = log();
    const onAlive = vi.fn(() => {
      throw new Error("boom");
    });
    await new SsdpListener({ interfaces: [], log: l, onAlive }).start();
    sockets[0].emit("message", Buffer.from("NOTIFY * HTTP/1.1\r\nNTS: ssdp:alive\r\n\r\n"), { address: "1.2.3.4" });
    expect(l.warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
    expect(sockets[0].closed).toBe(0);
  });

  test("rejects start on a bind error", async () => {
    fail.bind = true;
    await expect(new SsdpListener({ interfaces: [], log: log(), onAlive: vi.fn() }).start()).rejects.toThrow(
      "EADDRINUSE",
    );
  });

  test("warns on a failed join and keeps listening", async () => {
    fail.join = true;
    const l = log();
    await new SsdpListener({ interfaces: ["10.0.0.5"], log: l, onAlive: vi.fn() }).start();
    expect(l.warn).toHaveBeenCalledWith(expect.stringContaining("multicast join failed on 10.0.0.5"));
  });

  test("a socket error after start is reported once, and close is idempotent", async () => {
    const l = log();
    const listener = new SsdpListener({ interfaces: [], log: l, onAlive: vi.fn() });
    await listener.start();
    sockets[0].emit("error", new Error("ENETDOWN"));
    sockets[0].emit("error", new Error("ENETDOWN"));
    expect(l.warn.mock.calls.filter(c => String(c[0]).includes("ENETDOWN"))).toHaveLength(1);
    listener.close();
    listener.close();
    expect(sockets[0].closed).toBe(1);
  });

  test("close survives a socket that is already gone", async () => {
    const listener = new SsdpListener({ interfaces: [], log: log(), onAlive: vi.fn() });
    await listener.start();
    fail.close = true;
    expect(() => listener.close()).not.toThrow();
  });
});
