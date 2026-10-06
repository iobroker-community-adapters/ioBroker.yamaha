import { COMMAND_RING, ENTRY_MAX_BYTES, HISTORY_RING, TRAFFIC_LIMITS, TrafficRecorder } from "./traffic-recorder";

/**
 * A recorder on a clock the test moves.
 *
 * @returns the recorder and the clock
 */
function recorder(): { rec: TrafficRecorder; tick: (ms: number) => void } {
  let now = Date.UTC(2026, 9, 6, 12, 0, 0);
  return { rec: new TrafficRecorder(() => now), tick: ms => void (now += ms) };
}

describe("TrafficRecorder — R1: what recurs is counted, not stacked", () => {
  test("the same YNCA line counts up and moves to the newest place, first and last time kept", () => {
    const { rec, tick } = recorder();
    rec.yncaLine("sent", "@SYS:MODELNAME=?");
    tick(1000);
    rec.yncaLine("received", "@MAIN:VOL=-40.0");
    tick(30_000);
    rec.yncaLine("sent", "@SYS:MODELNAME=?");
    const ynca = rec.snapshot().traffic.ynca;
    expect(ynca.map(e => [e.direction, e.answer, e.count])).toEqual([
      ["received", "@MAIN:VOL=-40.0", 1],
      ["sent", "@SYS:MODELNAME=?", 2],
    ]);
    expect(ynca[1].first).toBe("2026-10-06T12:00:00.000Z");
    expect(ynca[1].last).toBe("2026-10-06T12:00:31.000Z");
  });

  test("the playback clock does not make a line new — the latest one is kept", () => {
    const { rec } = recorder();
    for (const t of ["0:01", "0:02", "0:03"]) {
      rec.yncaLine("received", `@NETRADIO:ELAPSEDTIME=${t}`);
    }
    rec.event('{"netusb":{"play_time":1},"device_id":"AABB"}');
    rec.event('{"netusb":{"play_time":2},"device_id":"AABB"}');
    const { traffic } = rec.snapshot();
    expect(traffic.ynca).toHaveLength(1);
    expect(traffic.ynca[0]).toMatchObject({ count: 3, answer: "@NETRADIO:ELAPSEDTIME=0:03" });
    expect(traffic.events).toHaveLength(1);
    expect(traffic.events[0]).toMatchObject({ count: 2, answer: { netusb: { play_time: 2 }, device_id: "AABB" } });
  });

  test("a MusicCast or XML answer counts only while it is the same answer", () => {
    const { rec } = recorder();
    rec.musiccast("/main/getStatus", undefined, { answer: { power: "on" } }, 20);
    rec.musiccast("/main/getStatus", undefined, { answer: { power: "on" } }, 30);
    rec.musiccast("/main/getStatus", undefined, { answer: { power: "standby" } }, 25);
    rec.musiccast("/main/getStatus", undefined, { error: "connect ECONNREFUSED" }, 5);
    rec.xml("<Basic_Status>", { answer: "<A/>" }, 40);
    rec.xml("<Basic_Status>", { answer: "<A/>" }, 41);
    const { traffic } = rec.snapshot();
    expect(traffic.musiccast.map(e => [e.answer ?? e.error, e.count, e.durationMs])).toEqual([
      [{ power: "on" }, 2, 30],
      [{ power: "standby" }, 1, 25],
      ["connect ECONNREFUSED", 1, 5],
    ]);
    expect(traffic.xml).toEqual([expect.objectContaining({ request: "<Basic_Status>", answer: "<A/>", count: 2 })]);
  });
});

describe("TrafficRecorder — R2/R3: each source its own limit, entries whole", () => {
  test("a source over its limit drops whole entries from the oldest end; the others keep theirs", () => {
    const { rec } = recorder();
    rec.xml("first", { answer: "<keep/>" }, 1);
    const line = "x".repeat(1000);
    for (let i = 0; i < 400; i++) {
      rec.yncaLine("received", `@MAIN:N${i}=${line}`);
    }
    const { traffic } = rec.snapshot();
    const bytes = Buffer.byteLength(JSON.stringify(traffic.ynca), "utf8");
    expect(bytes).toBeLessThanOrEqual(TRAFFIC_LIMITS.ynca + 1000);
    expect(traffic.ynca.at(-1)?.answer).toBe(`@MAIN:N399=${line}`);
    expect(traffic.ynca[0].answer).not.toBe(`@MAIN:N0=${line}`);
    // Every kept line is whole.
    expect(traffic.ynca.every(e => typeof e.answer === "string" && e.answer.endsWith(line))).toBe(true);
    expect(traffic.xml).toHaveLength(1);
  });

  test("an entry over 64 KB keeps its request and size, never half its body", () => {
    const { rec } = recorder();
    const body = `<Unit_Description>${'<Menu Title_1="x"/>'.repeat(5000)}</Unit_Description>`;
    expect(Buffer.byteLength(body)).toBeGreaterThan(ENTRY_MAX_BYTES);
    rec.xml("GET /YamahaRemoteControl/desc.xml", { answer: body }, 300);
    const [entry] = rec.snapshot().traffic.xml;
    expect(entry.request).toBe("GET /YamahaRemoteControl/desc.xml");
    expect(entry.answer).toBeUndefined();
    expect(entry.omittedBytes).toBeGreaterThan(ENTRY_MAX_BYTES);
  });

  test("an event that is no JSON is kept as it came, marked", () => {
    const { rec } = recorder();
    rec.event("not json");
    expect(rec.snapshot().traffic.events).toEqual([expect.objectContaining({ answer: "not json", unreadable: true })]);
  });
});

describe("TrafficRecorder — commands, connection history, last owners", () => {
  test("keeps the last 30 commands and the last 50 connection events, oldest dropped", () => {
    const { rec } = recorder();
    for (let i = 0; i < COMMAND_RING + 5; i++) {
      rec.command("volume", i, [{ transport: "yxc", outcome: "sent" }]);
    }
    for (let i = 0; i < HISTORY_RING + 3; i++) {
      rec.connection("connected", { n: i });
    }
    const snap = rec.snapshot();
    expect(snap.commands).toHaveLength(COMMAND_RING);
    expect(snap.commands[0].value).toBe(5);
    expect(snap.connectionHistory).toHaveLength(HISTORY_RING);
    expect(snap.connectionHistory[0]).toMatchObject({ event: "connected", n: 3 });
  });

  test("a command that went to the next protocol says why; one dropped offline says so", () => {
    const { rec } = recorder();
    rec.command("power", false, [
      { transport: "yxc", outcome: "refused" },
      { transport: "ynca", outcome: "sent", because: "yxc refused it" },
    ]);
    rec.command("volume", -40, [], "the device is offline — dropped");
    expect(rec.snapshot().commands).toEqual([
      expect.objectContaining({
        id: "power",
        attempts: [expect.anything(), expect.objectContaining({ because: "yxc refused it" })],
      }),
      expect.objectContaining({ id: "volume", attempts: [], note: "the device is offline — dropped" }),
    ]);
  });

  test("the owners of the last connection, with their time — and a snapshot is a copy", () => {
    const { rec } = recorder();
    expect(rec.snapshot().lastOwners).toBeNull();
    rec.lastOwners(
      new Map([
        ["volume", "yxc"],
        ["input", "ynca"],
      ] as const),
    );
    const snap = rec.snapshot();
    expect(snap.lastOwners).toEqual({ at: "2026-10-06T12:00:00.000Z", owners: { input: "ynca", volume: "yxc" } });
    snap.commands.push({ at: "", id: "x", value: 1, attempts: [] });
    expect(rec.snapshot().commands).toEqual([]);
  });
});
