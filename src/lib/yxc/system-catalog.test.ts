import { YXC_SYSTEM_CATALOG, presentSystemEntries } from "./system-catalog";

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
