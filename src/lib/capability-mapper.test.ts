import { mapYncaToObjects } from "./capability-mapper";
import { parseCapabilities } from "./ynca/capability";
import rxA810 from "./ynca/__fixtures__/RX-A810.json";
import rN500 from "./ynca/__fixtures__/R-N500.json";

function ids(fixture: string[]): string[] {
  return mapYncaToObjects(parseCapabilities(fixture)).map((o) => o.id);
}

describe("mapYncaToObjects", () => {
  test("maps MAIN amplifier functions to top-level states", () => {
    expect(ids(rxA810)).toEqual(expect.arrayContaining(["power", "volume", "mute", "input", "soundProgram"]));
  });

  test("maps a second zone as a channel with its own states", () => {
    const list = ids(rxA810);
    expect(list).toContain("zone2");
    expect(list).toContain("zone2.power");
    expect(list).toContain("zone2.volume");
  });

  test("maps the extra amplifier functions the RX-A810 reported", () => {
    expect(ids(rxA810)).toEqual(expect.arrayContaining(["straight", "enhancer", "pureDirect", "sleep"]));
  });

  test("maps only the zone functions the device reported (Zone 2 has sleep, not straight)", () => {
    const list = ids(rxA810);
    expect(list).toContain("zone2.sleep");
    expect(list).not.toContain("zone2.straight");
  });

  test("power is a writable boolean with a power role", () => {
    const power = mapYncaToObjects(parseCapabilities(rxA810)).find((o) => o.id === "power");
    expect(power?.type).toBe("state");
    expect(power?.common.type).toBe("boolean");
    expect(power?.common.write).toBe(true);
    expect(power?.common.role).toBe("switch.power");
  });

  test("volume is a writable number", () => {
    const volume = mapYncaToObjects(parseCapabilities(rxA810)).find((o) => o.id === "volume");
    expect(volume?.common.type).toBe("number");
    expect(volume?.common.write).toBe(true);
  });

  test("a stereo receiver (MAIN only) has no second zone", () => {
    expect(ids(rN500)).not.toContain("zone2");
  });

  test("only maps functions the device actually reported", () => {
    // A device that only reported MAIN:PWR should get power, not volume.
    const objs = mapYncaToObjects({ model: "X", subunits: { MAIN: { PWR: "Standby" } } });
    const stateIds = objs.filter((o) => o.type === "state").map((o) => o.id);
    expect(stateIds).toEqual(["power"]);
  });
});
