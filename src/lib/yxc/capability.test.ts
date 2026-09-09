import { parseYxcFeatures } from "./capability";
import rxA2070 from "./__fixtures__/RX_A2070_v1.json";
import rxV481 from "./__fixtures__/RX_V481_285_208.json";
import rxV685 from "./__fixtures__/RX_V685_196_211.json";
import wx10 from "./__fixtures__/WX10_216_208.json";
import isx18d from "./__fixtures__/ISX_18D_216_208.json";

describe("parseYxcFeatures", () => {
  test("extracts all zones of a multi-zone AVR with their functions", () => {
    const caps = parseYxcFeatures(rxA2070);
    expect(caps.zones.map(z => z.id)).toEqual(["main", "zone2", "zone3", "zone4"]);
    const main = caps.zones.find(z => z.id === "main");
    expect(main?.funcs).toEqual(expect.arrayContaining(["power", "volume", "mute"]));
  });

  test("a MusicCast speaker has a single main zone", () => {
    expect(parseYxcFeatures(wx10).zones.map(z => z.id)).toEqual(["main"]);
  });

  test("detects the media blocks the device offers", () => {
    const caps = parseYxcFeatures(rxV685);
    expect(caps.media).toContain("netusb");
    expect(caps.media).toContain("tuner");
  });

  test("does not treat the clock (alarm/timer) subsystem as a media player", () => {
    const caps = parseYxcFeatures({ zone: [{ id: "main" }], clock: {}, netusb: {}, cd: {} });
    expect(caps.media).toEqual(expect.arrayContaining(["netusb", "cd"]));
    expect(caps.media).not.toContain("clock");
  });

  test("extracts a zone's raw volume range from range_step", () => {
    const main = parseYxcFeatures(rxA2070).zones.find(z => z.id === "main");
    expect(main?.ranges?.volume).toEqual({ min: 0, max: 161, step: 1 });
  });

  test("ignores a range whose numbers are not numbers", () => {
    // The range comes straight off the device. A string min would land in
    // common.min and make the admin slider refuse every value the user picks.
    const caps = parseYxcFeatures({
      zone: [{ id: "main", range_step: [{ id: "volume", min: "0", max: 161, step: 1 }] }],
    });
    expect(caps.zones.find(z => z.id === "main")?.ranges?.volume).toBeUndefined();
  });

  test("keeps every declared range apart, and reports none for an id the device omits", () => {
    const caps = parseYxcFeatures({
      zone: [{ id: "main", range_step: ["nope", null, { id: "tone_control", min: -10, max: 10, step: 1 }] }],
    });
    const ranges = caps.zones.find(z => z.id === "main")?.ranges;
    expect(ranges?.volume).toBeUndefined();
    expect(ranges?.tone_control).toEqual({ min: -10, max: 10, step: 1 });
  });

  test("the on-screen remote vocabularies are the zone's own lists (menu_list varies per device)", () => {
    // Measured over 26 captures: one cursor list everywhere, three menu variants — 5, 9 and 12 words.
    const v481 = parseYxcFeatures(rxV481).zones.find(z => z.id === "main");
    expect(v481?.valueLists?.["remote.cursor"]).toEqual(["up", "down", "left", "right", "select", "return"]);
    expect(v481?.valueLists?.["remote.menu"]).toEqual(["on_screen", "top_menu", "menu", "option", "display"]);
    expect(parseYxcFeatures(rxA2070).zones.find(z => z.id === "main")?.valueLists?.["remote.menu"]).toHaveLength(9);
    expect(parseYxcFeatures(rxV685).zones.find(z => z.id === "main")?.valueLists?.["remote.menu"]).toHaveLength(12);
  });

  test("the tuner's frequency ranges are read per band", () => {
    expect(parseYxcFeatures(rxV685).tuner?.ranges).toEqual({
      am: { min: 531, max: 1611, step: 9 },
      fm: { min: 87500, max: 108000, step: 50 },
    });
    // A tuner block without range_step declares no ranges — undefined, not an empty object.
    expect(parseYxcFeatures({ zone: [{ id: "main" }], tuner: { func_list: ["fm"] } }).tuner?.ranges).toBeUndefined();
  });

  test("returns empty capabilities for a malformed response", () => {
    expect(parseYxcFeatures(null)).toEqual({ zones: [], media: [], hasDistribution: false });
    expect(parseYxcFeatures({ zone: "nope" })).toMatchObject({ zones: [], media: [], hasDistribution: false });
    // A response without a system block declares no device-wide ranges — not undefined,
    // so a caller can look one up without a guard.
    expect(parseYxcFeatures({ zone: "nope" }).systemRanges).toEqual({});
  });

  test("reads the device-wide ranges from the system block", () => {
    // The dimmer range is the device's own and differs per model (ISX-18D declares -1..2,
    // the WX-21 0..2) — the audit on 2026-09-06 found it parsed and thrown away.
    const caps = parseYxcFeatures({
      zone: [{ id: "main" }],
      system: { range_step: [{ id: "dimmer", min: -1, max: 2, step: 1 }] },
    });
    expect(caps.systemRanges).toEqual({ dimmer: { min: -1, max: 2, step: 1 } });
  });

  test("flags a device that reports a distribution block for multiroom", () => {
    expect(parseYxcFeatures({ zone: [{ id: "main" }], distribution: { version: 2 } }).hasDistribution).toBe(true);
    expect(parseYxcFeatures({ zone: [{ id: "main" }] }).hasDistribution).toBe(false);
  });

  test("collects a zone's device-reported value lists, keyed by the unified state id", () => {
    const main = parseYxcFeatures(rxA2070).zones.find(z => z.id === "main");
    expect(main?.valueLists?.soundProgram).toEqual(expect.arrayContaining(["munich", "roxy_theatre"]));
    expect(main?.valueLists?.["sound.surroundDecoder"]).toBeDefined();
    expect(main?.valueLists?.["sound.toneMode"]).toBeDefined();
  });

  test("parses the tuner features: bands and a per-band (separate) preset list", () => {
    // ISX-18D: func_list fm/dab plus non-band flags, preset {type separate, num 30}.
    const tuner = parseYxcFeatures(isx18d).tuner;
    expect(tuner).toEqual({
      bands: ["fm", "dab"],
      presetType: "separate",
      presetNum: 30,
      ranges: { fm: { min: 87500, max: 108000, step: 50 } },
    });
  });

  test("parses a shared (common) tuner preset list", () => {
    // RX-V481: am/fm with one common 40-slot list.
    const tuner = parseYxcFeatures(rxV481).tuner;
    expect(tuner).toEqual({
      bands: ["am", "fm"],
      presetType: "common",
      presetNum: 40,
      ranges: { am: { min: 531, max: 1611, step: 9 }, fm: { min: 87500, max: 108000, step: 50 } },
    });
  });

  test("parses the clock features: alarm modes and the alarm volume range", () => {
    const clock = parseYxcFeatures(isx18d).clock;
    expect(clock?.alarmModes).toEqual(["oneday"]);
    expect(clock?.alarmVolumeRange).toEqual({ min: 5, max: 60, step: 1 });
    expect(parseYxcFeatures(rxV481).clock).toBeUndefined();
  });
});

describe("scene count and netusb functions (RX-V6A getFeatures, 2026-09-01)", () => {
  test("parses scene_num per zone and the netusb func_list", () => {
    const caps = parseYxcFeatures({
      response_code: 0,
      zone: [
        { id: "main", func_list: ["power", "scene"], input_list: ["hdmi1"], scene_num: 8 },
        { id: "zone2", func_list: ["power", "scene"], input_list: ["hdmi1"], scene_num: 8 },
      ],
      netusb: { func_list: ["mc_playlist", "play_queue", "recent_info"] },
    });
    expect(caps.zones[0].sceneNum).toBe(8);
    expect(caps.zones[1].sceneNum).toBe(8);
    expect(caps.netusbFuncs).toEqual(["mc_playlist", "play_queue", "recent_info"]);
  });

  test("a device without scenes or a netusb block reports neither", () => {
    const caps = parseYxcFeatures({ response_code: 0, zone: [{ id: "main", func_list: ["power"] }] });
    expect(caps.zones[0].sceneNum).toBeUndefined();
    expect(caps.netusbFuncs).toBeUndefined();
  });
});

describe("parseYxcFeatures — a malformed range entry is skipped, not half-read", () => {
  it("ignores an entry whose id is not a string", () => {
    const caps = parseYxcFeatures({
      zone: [{ id: "main", range_step: [{ id: 42, min: 0, max: 1, step: 1 }] }],
    });
    expect(caps.zones[0]?.ranges).toEqual({});
  });

  it("ignores an entry with a missing bound", () => {
    const caps = parseYxcFeatures({
      zone: [{ id: "main", range_step: [{ id: "tone_control", min: 0, max: 1 }] }],
    });
    expect(caps.zones[0]?.ranges).toEqual({});
  });
});
