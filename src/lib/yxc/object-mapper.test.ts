import { mapYxcToObjects } from "./object-mapper";
import { parseYxcFeatures } from "./capability";
import rxA2070 from "./__fixtures__/RX_A2070_v1.json";
import wx10 from "./__fixtures__/WX10_216_208.json";

function ids(fixture: unknown): string[] {
  return mapYxcToObjects(parseYxcFeatures(fixture)).map(o => o.id);
}

describe("mapYxcToObjects", () => {
  test("maps main-zone functions to top-level states", () => {
    expect(ids(rxA2070)).toEqual(expect.arrayContaining(["power", "volume", "mute", "soundProgram", "input"]));
  });

  test("maps an additional zone as a channel with its own states", () => {
    const list = ids(rxA2070);
    expect(list).toContain("zone2");
    expect(list).toContain("zone2.power");
  });

  test("a MusicCast speaker has main states but no second zone", () => {
    const list = ids(wx10);
    expect(list).toContain("power");
    expect(list).not.toContain("zone2");
  });

  test("adds an input state only when the zone actually has inputs", () => {
    const caps = { zones: [{ id: "main", funcs: ["power"], inputs: [] }], media: [] };
    expect(mapYxcToObjects(caps).map(o => o.id)).toEqual(["power"]);
  });

  test("power is a writable boolean with a power role", () => {
    const power = mapYxcToObjects(parseYxcFeatures(rxA2070)).find(o => o.id === "power");
    expect(power?.common.type).toBe("boolean");
    expect(power?.common.role).toBe("switch.power");
    expect(power?.common.write).toBe(true);
  });
});
