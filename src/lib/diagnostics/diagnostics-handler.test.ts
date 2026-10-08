import { TrafficRecorder } from "./traffic-recorder";
import { describe, expect, it } from "vitest";
import type { HandleCapture } from "./types";
import {
  answeredSomething,
  musiccastStatus,
  YamahaReportSource,
  type DiagnosticsDeviceState,
  type DiagnosticsHost,
} from "./diagnostics-handler";
import { ReportJobs } from "./report-jobs";
import { LogRing } from "./log-ring";

/**
 * An ioBroker with the objects and states a test gives it.
 *
 * @param options what it holds
 * @param options.devices the running devices
 * @param options.objects the objects by id
 * @param options.states the state values by id
 * @param options.bulk whether it offers the bulk state read
 * @param options.lc when a state last changed, by id
 */
function makeHost(
  options: {
    devices?: DiagnosticsDeviceState[];
    objects?: Record<string, ioBroker.Object>;
    states?: Record<string, unknown>;
    bulk?: boolean;
    lc?: Record<string, number>;
  } = {},
): DiagnosticsHost & { lines: string[]; reads: { one: string[]; bulk: Array<string | string[]> } } {
  const objects = options.objects ?? {};
  const states = options.states ?? {};
  const lines: string[] = [];
  const reads = { one: [] as string[], bulk: [] as Array<string | string[]> };
  const ring = new LogRing();
  ring.add("info", "rx-v6a-2b3c: ready (YNCA, MusicCast)");
  ring.add("debug", "wx-030-f504: swept");
  const state = (id: string): ioBroker.State =>
    ({
      val: states[id],
      ack: true,
      ...(options.lc?.[id] === undefined ? {} : { lc: options.lc[id] }),
    }) as ioBroker.State;
  return {
    lines,
    reads,
    namespace: "yamaha.0",
    version: "3.3.0",
    hostName: "iobroker",
    startedAt: 0,
    config: { discovery: "auto" },
    logRing: ring,
    pushPort: () => ({ listening: true, blocked: false }),
    devices: () => options.devices ?? [],
    getForeignObjectAsync: id => Promise.resolve(id in objects ? structuredClone(objects[id]) : null),
    getForeignStateAsync: id => {
      reads.one.push(id);
      return Promise.resolve(id in states ? state(id) : null);
    },
    ...(options.bulk
      ? {
          getForeignStatesAsync: (pattern: string | string[]) => {
            reads.bulk.push(pattern);
            const wanted = (id: string): boolean =>
              Array.isArray(pattern) ? pattern.includes(id) : id.startsWith(pattern.replace(/\*$/, ""));
            return Promise.resolve(
              Object.fromEntries(
                Object.keys(states)
                  .filter(wanted)
                  .map(id => [id, state(id)]),
              ),
            );
          },
        }
      : {}),
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

/**
 * One report through the fleet master, as the card asks for it: start, then the result once it is done.
 *
 * @param host the running adapter
 * @param id the device id
 * @param now the clock
 * @param jobs the report jobs of a running adapter (a new one when not given)
 * @returns the report or why there is none
 */
async function exportReport(
  host: DiagnosticsHost,
  id: string,
  now?: () => number,
  jobs = new ReportJobs(new YamahaReportSource(host), now),
): Promise<{ fileName: string; content: string } | { error: string }> {
  const started = jobs.start(id);
  if ("error" in started) {
    return started;
  }
  for (;;) {
    const answer = jobs.result(started.job);
    if (!("pending" in answer) && !("gone" in answer)) {
      return answer;
    }
    await new Promise(resolve => setImmediate(resolve));
  }
}

describe("YamahaReportSource", () => {
  it("lists every running device, connected or not", () => {
    const jobs = new ReportJobs(
      new YamahaReportSource(
        makeHost({ devices: [device(), device({ id: "wx-030-f504", label: undefined, connected: false })] }),
      ),
    );
    expect(jobs.list()).toEqual([
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
    const answer = await exportReport(host, "rx-v6a-2b3c", () => Date.UTC(2026, 9, 5, 8, 0, 0));
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

  // Review 2026-10-05, B3: an id taken from a typed room name left in the file name and the content.
  it("names the file after the device id and replaces an id taken from a typed name in the content", async () => {
    const host = makeHost({
      devices: [device({ id: "kueche", ip: "192.168.178.41", model: undefined, label: "Küche", identity: undefined })],
    });
    host.logRing.add("info", "kueche: no reachable transport");
    const answer = (await exportReport(host, "kueche", () => Date.UTC(2026, 9, 5, 8, 0, 0))) as {
      fileName: string;
      content: string;
    };
    expect(answer.fileName).toBe("yamaha_kueche_v3.3.0_2026-10-05_080000.json");
    expect(answer.content).not.toContain("kueche");
    expect(answer.content).not.toContain("Küche");
    expect(answer.content).toContain("device-1: no reachable transport");
  });

  // Review 2026-10-05, B8: one state read per datapoint — 900 round trips for a three-protocol receiver.
  it("reads the device's values in one bulk read where the adapter offers it", async () => {
    const objects: Record<string, ioBroker.Object> = {
      "system.adapter.musiccast.0": instance(true),
    };
    const states: Record<string, unknown> = {
      "system.adapter.musiccast.0.alive": true,
      "yamaha.0.rx-v6a-2b3c.info.transports.yxc": true,
    };
    for (let i = 0; i < 50; i++) {
      objects[`yamaha.0.rx-v6a-2b3c.dp${i}`] = { common: { type: "number" } } as unknown as ioBroker.Object;
      states[`yamaha.0.rx-v6a-2b3c.dp${i}`] = i;
    }
    const host = makeHost({ devices: [device()], objects, states, bulk: true });
    const answer = (await exportReport(host, "rx-v6a-2b3c")) as { content: string };
    const report = JSON.parse(answer.content) as {
      objectTree: Array<{ id: string; val: unknown }>;
      device: { transports: Record<string, boolean> };
      environment: { musiccast: { status: string } };
    };
    expect(host.reads.one).toEqual([]);
    // Two reads, running side by side: the device subtree and the musiccast instances' `alive`.
    expect(host.reads.bulk).toHaveLength(2);
    expect(host.reads.bulk).toEqual(
      expect.arrayContaining(["yamaha.0.rx-v6a-2b3c.*", ["system.adapter.musiccast.0.alive"]]),
    );
    expect(report.objectTree).toHaveLength(50);
    expect(report.objectTree.find(entry => entry.id === "dp7")?.val).toBe(7);
    expect(report.device.transports).toEqual({ ynca: false, yxc: true, xml: false });
    expect(report.environment.musiccast.status).toBe("running");
  });

  it("says when the device is not connected instead of failing", async () => {
    const host = makeHost({ devices: [device({ connected: false, capture: () => Promise.resolve(undefined) })] });
    const answer = (await exportReport(host, "rx-v6a-2b3c")) as { content: string };
    expect(JSON.parse(answer.content).connection).toEqual({
      note: "not connected — no live read",
      ownersAtLastConnection: null,
    });
  });

  // Server test 2026-10-06: a receiver without power since the evening before, the adapter restarted in the morning —
  // the trail had no "disconnected", and the report said null where plan Y3 wants "offline since".
  it("tells since when an offline device is gone after a restart, from its info.connection", async () => {
    const id = "yamaha.0.rx-v6a-2b3c.info.connection";
    const lc = Date.UTC(2026, 9, 5, 21, 30, 32);
    for (const bulk of [false, true]) {
      const offline = makeHost({
        devices: [device({ connected: false, capture: () => Promise.resolve(undefined) })],
        states: { [id]: false },
        lc: { [id]: lc },
        bulk,
      });
      const answer = (await exportReport(offline, "rx-v6a-2b3c")) as { content: string };
      expect(JSON.parse(answer.content).trail.disconnectedSince, `bulk ${bulk}`).toBe("2026-10-05T21:30:32.000Z");
    }
    // A datapoint that says connected gives no "offline since".
    const stale = makeHost({
      devices: [device({ connected: false, capture: () => Promise.resolve(undefined) })],
      states: { [id]: true },
      lc: { [id]: lc },
    });
    const answer = (await exportReport(stale, "rx-v6a-2b3c")) as { content: string };
    expect(JSON.parse(answer.content).trail.disconnectedSince).toBeNull();
  });

  // Plan „Diagnosebericht“: the live read goes through the same clients the trail listens at; a full ring would lose
  // the history before an outage — the very data the trail is for.
  it("shows the trail as it stood before the live read, whole — the live read's own traffic does not push it out", async () => {
    const recorder = new TrafficRecorder();
    for (let i = 0; i < 40; i++) {
      recorder.xml(`<Basic_Status n="${i}"/>`, { answer: `<YAMAHA_AV>${"x".repeat(2000)}${i}</YAMAHA_AV>` }, 5);
    }
    const before = recorder.snapshot().traffic.xml.length;
    const host = makeHost({
      devices: [
        device({
          trail: () => recorder.snapshot(),
          capture: () => {
            // The live read: dozens of large XML answers through the same seam.
            for (let i = 0; i < 200; i++) {
              recorder.xml(`<Live n="${i}"/>`, { answer: `<YAMAHA_AV>${"y".repeat(2000)}</YAMAHA_AV>` }, 5);
            }
            return Promise.resolve(undefined);
          },
        }),
      ],
    });
    const answer = (await exportReport(host, "rx-v6a-2b3c")) as { content: string };
    const xml = (JSON.parse(answer.content) as { trail: { traffic: { xml: Array<{ request: string }> } } }).trail
      .traffic.xml;
    expect(xml).toHaveLength(before);
    expect(xml.every(entry => entry.request.startsWith("<Basic_Status"))).toBe(true);
  });

  it("takes each report's own trail — an earlier report's trail never stands in a later one", async () => {
    const recorder = new TrafficRecorder();
    recorder.xml("<First/>", { answer: "<YAMAHA_AV/>" }, 5);
    const receiver = device({ trail: () => recorder.snapshot() });
    const host = makeHost({ devices: [receiver] });
    let clock = 0;
    const jobs = new ReportJobs(new YamahaReportSource(host), () => clock);
    await exportReport(host, "rx-v6a-2b3c", undefined, jobs);
    // The receiver drops: the next report reads nothing live and takes the trail as it stands now.
    receiver.connected = false;
    recorder.xml("<Second/>", { answer: "<YAMAHA_AV/>" }, 5);
    clock += 60_000;
    const answer = (await exportReport(host, "rx-v6a-2b3c", undefined, jobs)) as { content: string };
    const xml = (JSON.parse(answer.content) as { trail: { traffic: { xml: Array<{ request: string }> } } }).trail
      .traffic.xml;
    expect(xml.map(entry => entry.request)).toEqual(["<First/>", "<Second/>"]);
  });

  it("reads no unconnected device live, and says so in the report", async () => {
    let reads = 0;
    const host = makeHost({
      devices: [
        device({
          connected: false,
          capture: () => {
            reads++;
            return Promise.resolve(undefined);
          },
        }),
      ],
    });
    const answer = (await exportReport(host, "rx-v6a-2b3c")) as { content: string };
    expect(reads).toBe(0);
    expect(JSON.parse(answer.content).connected).toBe(false);
  });

  // Round 104 (DB-02): a read nobody answered is a failed read, never `read`.
  it("calls a live read that got no answer a failed read", async () => {
    const silent = (transport: "ynca" | "yxc" | "xml"): HandleCapture["captures"][number] => ({
      transport,
      startedAt: "",
      durationMs: 1,
      complete: false,
      asked: 3,
      answers: transport === "ynca" ? {} : { "system/getDeviceInfo": { error: "timeout" } },
      lines: transport === "ynca" ? [] : undefined,
    });
    const capture = (): Promise<HandleCapture> =>
      Promise.resolve({
        live: ["ynca", "yxc", "xml"],
        missing: [],
        owners: {},
        tree: { shared: {}, transports: [] } as unknown as HandleCapture["tree"],
        captures: [silent("ynca"), silent("yxc"), silent("xml")],
      });
    const host = makeHost({ devices: [device({ capture })] });
    const answer = (await exportReport(host, "rx-v6a-2b3c")) as { content: string };
    const report = JSON.parse(answer.content) as { liveRead: string; connection: { note: string } };
    expect(report.liveRead).toBe("failed");
    expect(report.connection.note).toBe("live read failed: the device answered nothing");
  });

  it("counts a refusal, a line or a description as an answer, a transport failure not", () => {
    const base = { transport: "yxc" as const, startedAt: "", durationMs: 1, complete: true, asked: 1 };
    expect(answeredSomething({ ...base, answers: { a: { error: "timeout" } } })).toBe(false);
    expect(answeredSomething({ ...base, answers: { a: { response_code: 5 } } })).toBe(true);
    expect(answeredSomething({ ...base, answers: {}, lines: ["@MAIN:PWR=On"] })).toBe(true);
    expect(answeredSomething({ ...base, answers: {}, descriptor: "<Unit_Description/>" })).toBe(true);
    expect(answeredSomething({ ...base, answers: {}, descriptor: null })).toBe(false);
  });

  it("says why the live read failed, and still hands back the report", async () => {
    const host = makeHost({ devices: [device({ capture: () => Promise.reject(new Error("socket hang up")) })] });
    const answer = (await exportReport(host, "rx-v6a-2b3c")) as { content: string };
    expect(JSON.parse(answer.content).connection.note).toBe("live read failed: socket hang up");
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
    const answer = (await exportReport(host, "rx-v6a-2b3c")) as { content: string };
    expect(JSON.parse(answer.content).environment.musiccast.status).toBe("installed, switched off");
  });
});
