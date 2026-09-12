import { YXC_SYSTEM_CATALOG, presentSystemEntries } from "./system-catalog";
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
  test("every field a captured getFuncStatus carries has an entry; nothing is invented beyond the captures", () => {
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
    // The fields no capture ever showed (ypao_volume, zone_b_volume_sync, network_standby, …)
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

  test("party mode writes through the reference library's setter; the fields without a documented setter are read-only", () => {
    const byState = new Map(YXC_SYSTEM_CATALOG.map(entry => [entry.state, entry]));
    expect(byState.get("multiroom.party")?.write).toBeDefined();
    expect(byState.get("multiroom.party")?.common.write).toBe(true);
    for (const state of [
      "hdmi.out3",
      "hdmi.standbyThrough",
      "advanced.headphone",
      "advanced.speakers.pattern",
      "hdmi.videoPreset",
    ]) {
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
  };

  /** The endpoint each writable entry must reach, and with which argument. */
  const WRITES: Record<string, { value: unknown; method: string; args: unknown[] }> = {
    "advanced.autoPowerStandby": { value: 1, method: "setAutoPowerStandby", args: [true] },
    "hdmi.out1": { value: false, method: "setHdmiOut1", args: [false] },
    "hdmi.out2": { value: "on", method: "setHdmiOut2", args: [true] },
    "multiroom.party": { value: 0, method: "setPartyMode", args: [false] },
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
    await entry.write!.apply(client, expected.value);
    expect(calls).toEqual([{ method: expected.method, args: expected.args }]);
  });
});
