import { mapYxcToObjects } from "./object-mapper";
import { parseYxcFeatures } from "./capability";
import rxA2070 from "./__fixtures__/RX_A2070_v1.json";
import wx10 from "./__fixtures__/WX10_216_208.json";

function ids(fixture: unknown): string[] {
  return mapYxcToObjects(parseYxcFeatures(fixture)).map(o => o.id);
}

describe("mapYxcToObjects", () => {
  test("creates the network player channel and states when the device offers netusb", () => {
    const objs = mapYxcToObjects({ zones: [{ id: "main", funcs: ["power"], inputs: [] }], media: ["netusb"] });
    const ids = objs.map(o => o.id);
    expect(ids).toContain("netPlayer");
    expect(ids).toEqual(expect.arrayContaining(["netPlayer.playback", "netPlayer.artist", "netPlayer.track"]));
  });

  test("creates the tuner channel with band, frequency and RDS when the device offers a tuner", () => {
    const objs = mapYxcToObjects({ zones: [{ id: "main", funcs: ["power"], inputs: [] }], media: ["tuner"] });
    const ids = objs.map(o => o.id);
    expect(ids).toContain("tuner");
    expect(ids).toEqual(expect.arrayContaining(["tuner.band", "tuner.frequency", "tuner.rdsText"]));
  });

  test("creates the cd channel with read states and transport buttons when the device offers a cd", () => {
    const objs = mapYxcToObjects({ zones: [{ id: "main", funcs: ["power"], inputs: [] }], media: ["cd"] });
    const ids = objs.map(o => o.id);
    expect(ids).toContain("cd");
    expect(ids).toEqual(
      expect.arrayContaining([
        "cd.playback",
        "cd.artist",
        "cd.album",
        "cd.track",
        "cd.play",
        "cd.pause",
        "cd.stop",
        "cd.next",
        "cd.prev",
      ]),
    );
  });

  test("a cd transport button is a write-only boolean button", () => {
    const objs = mapYxcToObjects({ zones: [{ id: "main", funcs: ["power"], inputs: [] }], media: ["cd"] });
    const play = objs.find(o => o.id === "cd.play");
    expect(play?.common.type).toBe("boolean");
    expect(play?.common.role).toBe("button");
    expect(play?.common.write).toBe(true);
    expect(play?.common.read).toBe(false);
  });

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

  test("the volume state carries min/max/step from the device range", () => {
    const vol = mapYxcToObjects(parseYxcFeatures(rxA2070)).find(o => o.id === "volume");
    expect(vol?.common.min).toBe(0);
    expect(vol?.common.max).toBe(161);
    expect(vol?.common.step).toBe(1);
  });
});
