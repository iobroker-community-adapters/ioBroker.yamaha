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

  test("returns empty capabilities for a malformed response", () => {
    expect(parseYxcFeatures(null)).toEqual({ zones: [], media: [] });
    expect(parseYxcFeatures({ zone: "nope" })).toEqual({ zones: [], media: [] });
  });
});
