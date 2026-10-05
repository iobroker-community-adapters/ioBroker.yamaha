import { describe, expect, it } from "vitest";
import type { HandleCapture } from "./types";
import {
  DiagnosticsHandler,
  musiccastStatus,
  type DiagnosticsDeviceState,
  type DiagnosticsHost,
} from "./diagnostics-handler";
import { LogRing } from "./log-ring";
import { diagnosticsFileName } from "./report";

/**
 * An ioBroker with the objects and states a test gives it.
 *
 * @param options what it holds
 * @param options.devices the running devices
 * @param options.objects the objects by id
 * @param options.states the state values by id
 */
function makeHost(
  options: {
    devices?: DiagnosticsDeviceState[];
    objects?: Record<string, ioBroker.Object>;
    states?: Record<string, unknown>;
  } = {},
): DiagnosticsHost & { lines: string[] } {
  const objects = options.objects ?? {};
  const states = options.states ?? {};
  const lines: string[] = [];
  const ring = new LogRing();
  ring.add("info", "rx-v6a-2b3c: ready (YNCA, MusicCast)");
  ring.add("debug", "wx-030-f504: swept");
  return {
    lines,
    namespace: "yamaha.0",
    version: "3.3.0",
    hostName: "iobroker",
    startedAt: 0,
    config: { discovery: "auto" },
    logRing: ring,
    pushPort: () => ({ listening: true, blocked: false }),
    devices: () => options.devices ?? [],
    getForeignObjectAsync: id => Promise.resolve(id in objects ? structuredClone(objects[id]) : null),
    getForeignStateAsync: id =>
      Promise.resolve(id in states ? ({ val: states[id], ack: true } as ioBroker.State) : null),
    getObjectViewAsync: (_design, _search, params) =>
      Promise.resolve({
        rows: Object.entries(objects)
          .filter(([id]) => id >= params.startkey && id <= params.endkey)
          .map(([id, value]) => ({ id, value: structuredClone(value) })),
      }),
    log: { info: m => lines.push(m), warn: m => lines.push(m), debug: m => lines.push(m) },
  };
}

function device(over: Partial<DiagnosticsDeviceState> = {}): DiagnosticsDeviceState {
  return {
    id: "rx-v6a-2b3c",
    ip: "192.168.178.40",
    model: "RX-V6A",
    label: "Wohnzimmer",
    identity: { serial: "0A1B2B3C" },
    connected: true,
    capture: () =>
      Promise.resolve<HandleCapture>({
        live: ["ynca", "yxc"],
        missing: [],
        owners: { power: "yxc" },
        tree: { shared: {}, transports: ["ynca", "yxc"] } as unknown as HandleCapture["tree"],
        captures: [
          {
            transport: "yxc",
            startedAt: "",
            durationMs: 1,
            complete: true,
            asked: 1,
            answers: { "system/getDeviceInfo": { system_id: "0A1B2B3C", model_name: "RX-V6A" } },
          },
        ],
      }),
    ...over,
  };
}

const instance = (enabled: boolean): ioBroker.Object => ({ common: { enabled } }) as unknown as ioBroker.Object;

describe("DiagnosticsHandler", () => {
  it("lists every running device, connected or not", () => {
    const handler = new DiagnosticsHandler(
      makeHost({ devices: [device(), device({ id: "wx-030-f504", label: undefined, connected: false })] }),
    );
    expect(handler.list()).toEqual([
      { value: "rx-v6a-2b3c", label: "Wohnzimmer (rx-v6a-2b3c)", connected: true },
      { value: "wx-030-f504", label: "wx-030-f504", connected: false },
    ]);
  });

  it("hands back one device's report as a file — pseudonymised, with the live read and the musiccast adapter", async () => {
    const host = makeHost({
      devices: [device(), device({ id: "wx-030-f504", ip: "192.168.178.41", connected: false })],
      objects: {
        "system.adapter.musiccast": { common: { version: "1.2.3" } } as unknown as ioBroker.Object,
        "system.adapter.musiccast.0": instance(true),
        "yamaha.0.rx-v6a-2b3c.power": {
          common: { type: "boolean", role: "switch.power", write: true },
        } as unknown as ioBroker.Object,
      },
      states: { "system.adapter.musiccast.0.alive": true, "yamaha.0.rx-v6a-2b3c.power": true },
    });
    const answer = await new DiagnosticsHandler(host, () => Date.UTC(2026, 9, 5, 8, 0, 0)).handle({
      action: "export",
      device: "rx-v6a-2b3c",
    });
    const { fileName, content } = answer as { fileName: string; content: string };
    expect(fileName).toBe("yamaha_rx-v6a-2b3c_v3.3.0_2026-10-05_080000.json");
    const report = JSON.parse(content) as Record<string, any>;
    expect(report.environment.musiccast).toEqual({
      status: "running",
      installed: true,
      version: "1.2.3",
      instances: [{ instance: "musiccast.0", enabled: true, alive: true }],
    });
    expect(report.connection.owners).toEqual({ power: "yxc" });
    expect(report.captures.yxc.answers["system/getDeviceInfo"].model_name).toBe("RX-V6A");
    expect(report.objectTree).toEqual([expect.objectContaining({ id: "power", role: "switch.power", val: true })]);
    // This device's log lines, not the other device's.
    expect(report.recentLogs.map((l: { msg: string }) => l.msg)).toEqual(["rx-v6a-2b3c: ready (YNCA, MusicCast)"]);
    for (const secret of ["192.168.178.40", "0A1B2B3C", "Wohnzimmer"]) {
      expect(content, secret).not.toContain(secret);
    }
  });

  it("says when the device is not connected instead of failing", async () => {
    const host = makeHost({ devices: [device({ connected: false, capture: () => Promise.resolve(undefined) })] });
    const answer = (await new DiagnosticsHandler(host).export("rx-v6a-2b3c")) as { content: string };
    expect(JSON.parse(answer.content).connection).toEqual({ note: "not connected — no live read" });
  });

  it("runs one report per device at a time", async () => {
    let release: () => void = () => {};
    const slow = device({ capture: () => new Promise(resolve => (release = () => resolve(undefined))) });
    const handler = new DiagnosticsHandler(makeHost({ devices: [slow] }));
    const first = handler.export("rx-v6a-2b3c");
    expect(await handler.export("rx-v6a-2b3c")).toEqual({ error: expect.stringContaining("being made") });
    release();
    expect(await first).toHaveProperty("fileName");
  });

  it("answers an unknown device or action with an error", async () => {
    const handler = new DiagnosticsHandler(makeHost());
    expect(await handler.handle({ action: "export", device: "nope" })).toEqual({ error: "unknown device 'nope'" });
    expect(await handler.handle({ action: "x" })).toEqual({ error: "unknown diagnostics action 'x'" });
    expect(await handler.handle(null)).toEqual({ error: "unknown diagnostics action 'undefined'" });
  });
});

describe("musiccastStatus", () => {
  it("tells installed, switched off, switched on but not running and running apart", () => {
    expect(musiccastStatus(false, [])).toBe("not installed");
    expect(musiccastStatus(true, [])).toBe("installed, no instance");
    expect(musiccastStatus(true, [{ instance: "musiccast.0", enabled: false, alive: false }])).toBe(
      "installed, switched off",
    );
    expect(musiccastStatus(true, [{ instance: "musiccast.0", enabled: true, alive: false }])).toBe(
      "switched on, not running",
    );
    expect(
      musiccastStatus(true, [
        { instance: "musiccast.0", enabled: false, alive: false },
        { instance: "musiccast.1", enabled: true, alive: true },
      ]),
    ).toBe("running");
  });

  it("reads an instance that exists without the adapter object as installed", async () => {
    const host = makeHost({ devices: [device()], objects: { "system.adapter.musiccast.0": instance(false) } });
    const answer = (await new DiagnosticsHandler(host).export("rx-v6a-2b3c")) as { content: string };
    expect(JSON.parse(answer.content).environment.musiccast.status).toBe("installed, switched off");
  });
});

describe("diagnosticsFileName", () => {
  it("names model, device, version and time", () => {
    expect(diagnosticsFileName("wx-030-f504", "3.3.0", new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe(
      "yamaha_wx-030-f504_v3.3.0_2026-01-02_030405.json",
    );
  });
});
