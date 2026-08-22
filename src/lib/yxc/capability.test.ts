import { parseYxcFeatures } from "./capability";
import rxA2070 from "./__fixtures__/RX_A2070_v1.json";
import rxV685 from "./__fixtures__/RX_V685_196_211.json";
import wx10 from "./__fixtures__/WX10_216_208.json";

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
    expect(main?.volumeRange).toEqual({ min: 0, max: 161, step: 1 });
  });

  test("ignores a volume range whose numbers are not numbers", () => {
    // The range comes straight off the device. A string min would land in
    // common.min and make the admin slider refuse every value the user picks.
    const caps = parseYxcFeatures({
      zone: [{ id: "main", range_step: [{ id: "volume", min: "0", max: 161, step: 1 }] }],
    });
    expect(caps.zones.find(z => z.id === "main")?.volumeRange).toBeUndefined();
  });

  test("ignores a range block for something other than the volume", () => {
    const caps = parseYxcFeatures({
      zone: [{ id: "main", range_step: ["nope", null, { id: "tone_control", min: -10, max: 10, step: 1 }] }],
    });
    expect(caps.zones.find(z => z.id === "main")?.volumeRange).toBeUndefined();
  });

  test("returns empty capabilities for a malformed response", () => {
    expect(parseYxcFeatures(null)).toEqual({ zones: [], media: [], hasDistribution: false });
    expect(parseYxcFeatures({ zone: "nope" })).toEqual({ zones: [], media: [], hasDistribution: false });
  });

  test("flags a device that reports a distribution block for multiroom", () => {
    expect(parseYxcFeatures({ zone: [{ id: "main" }], distribution: { version: 2 } }).hasDistribution).toBe(true);
    expect(parseYxcFeatures({ zone: [{ id: "main" }] }).hasDistribution).toBe(false);
  });
});
