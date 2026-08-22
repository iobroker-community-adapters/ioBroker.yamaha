import { vi } from "vitest";

/**
 * The default poster talks to the receiver over node:http. It is mocked here so
 * the request shape (host, port, path, method, timeout) and the timeout/error
 * handling are provable without a device — the class's own seam covers the rest.
 */
const httpMock = vi.hoisted(() => ({
  requests: [] as Array<{ options: Record<string, unknown>; written: string[]; ended: boolean; destroyed?: Error }>,
  body: "<YAMAHA_AV/>",
  mode: "ok" as "ok" | "error" | "timeout",
}));
vi.mock("node:http", () => ({
  request: (options: Record<string, unknown>, cb: (res: unknown) => void) => {
    const entry = { options, written: [] as string[], ended: false, destroyed: undefined as Error | undefined };
    httpMock.requests.push(entry);
    const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    const req = {
      on: (ev: string, h: (...a: unknown[]) => void) => {
        (handlers[ev] ??= []).push(h);
        return req;
      },
      write: (b: string) => entry.written.push(b),
      end: () => {
        entry.ended = true;
        queueMicrotask(() => {
          if (httpMock.mode === "error") {
            (handlers.error ?? []).forEach(h => h(new Error("ECONNREFUSED")));
            return;
          }
          if (httpMock.mode === "timeout") {
            (handlers.timeout ?? []).forEach(h => h());
            return;
          }
          const resHandlers: Record<string, Array<(...a: unknown[]) => void>> = {};
          cb({
            on: (ev: string, h: (...a: unknown[]) => void) => {
              (resHandlers[ev] ??= []).push(h);
              if (ev === "end") {
                (resHandlers.data ?? []).forEach(d => d(httpMock.body));
                h();
              }
            },
          });
        });
      },
      destroy: (e: Error) => {
        entry.destroyed = e;
        (handlers.error ?? []).forEach(h => h(e));
      },
    };
    return req;
  },
}));

import { XmlClient } from "./xml-client";

describe("XmlClient", () => {
  test("send posts a PUT envelope to the control endpoint", async () => {
    const posts: Array<{ ip: string; body: string }> = [];
    const client = new XmlClient("1.2.3.4", async (ip, body) => {
      posts.push({ ip, body });
      return "";
    });
    await client.send("Main_Zone", "<Power_Control><Power>On</Power></Power_Control>");
    expect(posts).toEqual([
      {
        ip: "1.2.3.4",
        body: '<YAMAHA_AV cmd="PUT"><Main_Zone><Power_Control><Power>On</Power></Power_Control></Main_Zone></YAMAHA_AV>',
      },
    ]);
  });

  test("getStatus posts a Basic_Status GET and parses the response", async () => {
    const client = new XmlClient(
      "1.2.3.4",
      async () =>
        "<YAMAHA_AV><Main_Zone><Basic_Status><Power_Control><Power>On</Power></Power_Control></Basic_Status></Main_Zone></YAMAHA_AV>",
    );
    expect(await client.getStatus("Main_Zone")).toEqual({ power: true });
  });
});

describe("XmlClient default HTTP poster", () => {
  beforeEach(() => {
    httpMock.requests.length = 0;
    httpMock.body = "<YAMAHA_AV/>";
    httpMock.mode = "ok";
  });

  test("POSTs the body to the receiver's control endpoint on port 80", async () => {
    httpMock.body = "<Model_Name>RX-V771</Model_Name>";
    await expect(new XmlClient("192.168.1.10").getModelName()).resolves.toBe("RX-V771");
    const req = httpMock.requests[0];
    // The path and the method ARE the protocol — a GET, or the wrong path, gets a
    // 404 from every receiver and the transport looks simply absent.
    expect(req.options).toMatchObject({
      host: "192.168.1.10",
      port: 80,
      path: "/YamahaRemoteControl/ctrl",
      method: "POST",
      timeout: 5000,
    });
    expect(req.written[0]).toContain('<YAMAHA_AV cmd="GET">');
    expect(req.ended).toBe(true);
  });

  test("fails fast instead of hanging when the receiver does not answer", async () => {
    httpMock.mode = "timeout";
    // The poll runs on a timer: a request that never settles stacks up one pending
    // socket per interval for as long as the device is unplugged.
    await expect(new XmlClient("192.168.1.99").getModelName()).rejects.toThrow("XML request timeout");
    expect(httpMock.requests[0].destroyed?.message).toBe("XML request timeout");
  });

  test("rejects on a transport error", async () => {
    httpMock.mode = "error";
    await expect(new XmlClient("192.168.1.99").getModelName()).rejects.toThrow("ECONNREFUSED");
  });
});
