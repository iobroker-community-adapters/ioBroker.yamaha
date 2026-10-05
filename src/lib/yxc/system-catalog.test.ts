import { YXC_SYSTEM_CATALOG, presentSystemEntries, systemWrite } from "./system-catalog";
import type { YxcClientLike } from "./client-contract";

/** The RX-A3080 answer (bundled capture RXA3080_213_215.json) — the richest getFuncStatus on record. */
const RX_A3080 = {
  response_code: 0,
  hdmi_out_1: true,
  hdmi_out_2: false,
  hdmi_out_3: false,
  hdmi_standby_through: "auto",
  headphone: false,
  party_mode: false,
  speaker_pattern: 1,
  video_preset: 1,
  video_preset_disable: false,
};

describe("the device-wide MusicCast settings (coverage audit 2026-09-09)", () => {
  test("every field a captured getFuncStatus carries has an entry; nothing is invented beyond the captures and the specification", () => {
    const states = presentSystemEntries(RX_A3080).map(entry => entry.state);
    expect(states).toEqual(
      expect.arrayContaining([
        "hdmi.out1",
        "hdmi.out2",
        "hdmi.out3",
        "hdmi.standbyThrough",
        "advanced.headphone",
        "multiroom.party",
        "advanced.speakers.pattern",
        "hdmi.videoPreset",
      ]),
    );
    // Fields neither a capture nor the specification's setter list shows (ypao_volume, network_standby, …)
    // have no entry — a capability list is a promise, the answer is the evidence.
    expect(YXC_SYSTEM_CATALOG.some(entry => entry.field === "ypao_volume")).toBe(false);
  });

  test("the RX-V6A's four fields map to the same four entries, and a field the device lacks stays out", () => {
    const rxV6a = {
      response_code: 0,
      headphone: false,
      hdmi_out_1: true,
      party_mode: false,
      hdmi_standby_through: "auto",
    };
    expect(presentSystemEntries(rxV6a).map(entry => entry.state)).toEqual([
      "hdmi.out1",
      "hdmi.standbyThrough",
      "advanced.headphone",
      "multiroom.party",
    ]);
  });

  test("party mode writes through the reference library's setter; the fields without a known setter are read-only", () => {
    const byState = new Map(YXC_SYSTEM_CATALOG.map(entry => [entry.state, entry]));
    expect(byState.get("multiroom.party")?.write).toBeDefined();
    expect(byState.get("multiroom.party")?.common.write).toBe(true);
    // Dimmer (YXC Basic §4.26) and speaker pattern (pyamaha) write since 2026-09-24 (C8).
    for (const state of ["advanced.displayBrightness", "advanced.speakers.pattern"]) {
      expect(byState.get(state)?.write, state).toBeDefined();
      expect(byState.get(state)?.common.write, state).toBe(true);
    }
    for (const state of ["hdmi.out3", "hdmi.standbyThrough", "advanced.headphone", "hdmi.videoPreset"]) {
      expect(byState.get(state)?.write, state).toBeUndefined();
      expect(byState.get(state)?.common.write, state).toBe(false);
    }
  });

  test("the speaker pattern reads in YNCA's spelling, the standby-through and video preset carry their declaration ids", () => {
    const byState = new Map(YXC_SYSTEM_CATALOG.map(entry => [entry.state, entry]));
    expect(byState.get("advanced.speakers.pattern")?.fromStatus(2)).toBe("Pattern 2");
    expect(byState.get("advanced.speakers.pattern")?.countId).toBe("speaker_pattern_num");
    expect(byState.get("hdmi.standbyThrough")?.listId).toBe("hdmi_standby_through_list");
    expect(byState.get("hdmi.videoPreset")?.countId).toBe("video_preset_num");
    expect(byState.get("hdmi.videoPreset")?.fromStatus(3)).toBe(3);
  });
});

/**
 * A stand-in that records what a write called, so the table below can name the endpoint per
 * entry. A proxy instead of 50 hand-written methods — the same move the controller test makes.
 *
 * @returns the client and the calls it collected
 */
function recordingClient(): { client: YxcClientLike; calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const client = new Proxy({} as YxcClientLike, {
    get:
      (_target, method: string) =>
      (...args: unknown[]): Promise<void> => {
        calls.push({ method, args });
        return Promise.resolve();
      },
  });
  return { client, calls };
}

// Every entry, both directions. Until this table existed a third of the catalog's functions were
// never executed: `fromStatus` and `write.apply` of the automatic standby, the display brightness
// and the two HDMI outputs. Swapping out1 and out2 would have gone unnoticed.
describe("every system-catalog entry converts and writes what it claims", () => {
  /** Raw field value → the value the datapoint must carry. */
  const READS: Record<string, Array<[unknown, boolean | number | string]>> = {
    "advanced.autoPowerStandby": [
      [true, true],
      [false, false],
      [0, false],
    ],
    "advanced.displayBrightness": [
      [3, 3],
      ["-1", -1],
    ],
    "hdmi.out1": [
      [true, true],
      [false, false],
    ],
    "hdmi.out2": [
      [true, true],
      [false, false],
    ],
    "hdmi.out3": [
      [true, true],
      [false, false],
    ],
    "hdmi.standbyThrough": [
      ["auto", "auto"],
      ["off", "off"],
    ],
    "advanced.headphone": [
      [true, true],
      [false, false],
    ],
    "multiroom.party": [
      [true, true],
      [false, false],
    ],
    "advanced.speakers.pattern": [
      [1, "Pattern 1"],
      [2, "Pattern 2"],
    ],
    "hdmi.videoPreset": [
      [1, 1],
      ["2", 2],
    ],
    // YXC Basic Rev 1.10 §4.21 (audit 2026-09-24, C25).
    "advanced.speakers.speakerA": [
      [true, true],
      [false, false],
    ],
    "advanced.speakers.speakerB": [
      [true, true],
      [false, false],
    ],
    "advanced.irSensor": [
      [true, true],
      [false, false],
    ],
    "multiroom.zoneB.volumeSync": [
      [true, true],
      [false, false],
    ],
  };

  /** The endpoint each writable entry must reach, and with which argument. */
  const WRITES: Record<string, { value: unknown; method: string; args: unknown[] }> = {
    "advanced.autoPowerStandby": { value: 1, method: "setAutoPowerStandby", args: [true] },
    "hdmi.out1": { value: false, method: "setHdmiOut1", args: [false] },
    "hdmi.out2": { value: "on", method: "setHdmiOut2", args: [true] },
    "multiroom.party": { value: 0, method: "setPartyMode", args: [false] },
    "advanced.displayBrightness": { value: -1, method: "setDimmer", args: [-1] },
    "advanced.speakers.pattern": { value: "Pattern 2", method: "setSpeakerPattern", args: [2] },
    "advanced.speakers.speakerA": { value: true, method: "setSpeakerA", args: [true] },
    "advanced.speakers.speakerB": { value: 0, method: "setSpeakerB", args: [false] },
    "advanced.irSensor": { value: false, method: "setIrSensor", args: [false] },
    "multiroom.zoneB.volumeSync": { value: true, method: "setZoneBVolumeSync", args: [true] },
  };

  test("the tables cover the catalog — a new entry without a case fails here", () => {
    const states = YXC_SYSTEM_CATALOG.map(entry => entry.state).sort();
    expect(Object.keys(READS).sort()).toEqual(states);
    const writable = YXC_SYSTEM_CATALOG.filter(entry => entry.write)
      .map(entry => entry.state)
      .sort();
    expect(Object.keys(WRITES).sort()).toEqual(writable);
  });

  test.each(YXC_SYSTEM_CATALOG.map(entry => [entry.state, entry] as const))("%s reads its field", (state, entry) => {
    for (const [raw, expected] of READS[state]) {
      expect(entry.fromStatus(raw), `${state} <- ${JSON.stringify(raw)}`).toBe(expected);
    }
  });

  test.each(Object.entries(WRITES))("%s writes to its own endpoint", async (state, expected) => {
    const entry = YXC_SYSTEM_CATALOG.find(candidate => candidate.state === state)!;
    const { client, calls } = recordingClient();
    const write = systemWrite(entry, expected.value);
    expect(write.dropped).toBeUndefined();
    await write.run?.(client);
    expect(calls).toEqual([{ method: expected.method, args: expected.args }]);
  });
});

// The one gate of a device-wide write (review 2026-10-05, KISS): the controller coerced the switches on its own and
// the setters did it again with `Boolean()` — the word "false" switched a setter ON when called directly.
describe("systemWrite — the one gate of a device-wide setting", () => {
  const entry = (state: string): (typeof YXC_SYSTEM_CATALOG)[number] =>
    YXC_SYSTEM_CATALOG.find(candidate => candidate.state === state)!;

  it("reads the switch words, and sends nothing for a word that names no switch value", async () => {
    const { client, calls } = recordingClient();
    await systemWrite(entry("hdmi.out1"), "false").run?.(client);
    await systemWrite(entry("multiroom.party"), "ON").run?.(client);
    expect(calls).toEqual([
      { method: "setHdmiOut1", args: [false] },
      { method: "setPartyMode", args: [true] },
    ]);
    expect(systemWrite(entry("hdmi.out1"), "maybe")).toEqual({ dropped: '"maybe" is no switch value' });
  });

  it("a setter itself coerces nothing — only `true` is on", async () => {
    const { client, calls } = recordingClient();
    await entry("hdmi.out2").write!.apply(client, "true");
    expect(calls).toEqual([{ method: "setHdmiOut2", args: [false] }]);
  });

  it("puts a number on the grid the system block declares, and sends none outside it", async () => {
    const declared = { systemRanges: { dimmer: { min: -1, max: 15, step: 1 } } };
    const { client, calls } = recordingClient();
    await systemWrite(entry("advanced.displayBrightness"), "3.4", declared).run?.(client);
    expect(calls).toEqual([{ method: "setDimmer", args: [3] }]);
    expect(systemWrite(entry("advanced.displayBrightness"), 99, declared)).toEqual({
      dropped: "99 is outside the declared range -1…15",
    });
    expect(systemWrite(entry("advanced.displayBrightness"), true, declared).dropped).toBe("true is no number");
  });

  it("a read-only setting sends nothing", () => {
    expect(systemWrite(entry("hdmi.out3"), true)).toEqual({ dropped: "it is read-only on MusicCast" });
  });
});

describe("the speaker pattern write", () => {
  it("sends only a pattern number — a word that names none never reaches the device", async () => {
    const entry = YXC_SYSTEM_CATALOG.find(candidate => candidate.state === "advanced.speakers.pattern")!;
    const { client, calls } = recordingClient();
    await expect(entry.write!.apply(client, "Pattern x")).rejects.toThrow('"Pattern x" is no speaker pattern');
    await entry.write!.apply(client, "3");
    expect(calls).toEqual([{ method: "setSpeakerPattern", args: [3] }]);
  });
});
