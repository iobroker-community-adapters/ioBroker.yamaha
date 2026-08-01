import { parseYxcStatus, stateToYxc } from "./command-mapper";
import ysp from "./__fixtures__/status/YSP1600_main.json";
import rx from "./__fixtures__/status/RX_A2070_main.json";

describe("parseYxcStatus", () => {
  test("maps a main getStatus to unified amp states", () => {
    // YSP-1600: power=standby, volume=30, mute=false, input=hdmi, sound_program=stereo
    expect(parseYxcStatus(ysp, "main")).toEqual(
      expect.arrayContaining([
        { id: "power", value: false },
        { id: "volume", value: 30 },
        { id: "mute", value: false },
        { id: "input", value: "hdmi" },
        { id: "soundProgram", value: "stereo" },
      ]),
    );
  });

  test("maps power=on to true and reads the raw volume", () => {
    // RX-A2070: power=on, volume=66, input=server
    const updates = parseYxcStatus(rx, "main");
    expect(updates).toContainEqual({ id: "power", value: true });
    expect(updates).toContainEqual({ id: "volume", value: 66 });
    expect(updates).toContainEqual({ id: "input", value: "server" });
  });

  test("prefixes the state id for non-main zones", () => {
    expect(parseYxcStatus(ysp, "zone2")).toContainEqual({ id: "zone2.power", value: false });
  });

  test("returns no updates for malformed input or a status without amp fields", () => {
    expect(parseYxcStatus(null, "main")).toEqual([]);
    expect(parseYxcStatus({ response_code: 0 }, "main")).toEqual([]);
  });
});

describe("stateToYxc", () => {
  test("maps a power write to the power method on main", () => {
    expect(stateToYxc("power", true)).toEqual({ method: "power", zone: "main", value: true });
  });

  test("maps a zoned volume write to setVolumeTo", () => {
    expect(stateToYxc("zone2.volume", 40)).toEqual({ method: "setVolumeTo", zone: "zone2", value: 40 });
  });

  test("maps soundProgram to setSound (not setSoundProgram)", () => {
    expect(stateToYxc("soundProgram", "stereo")).toEqual({ method: "setSound", zone: "main", value: "stereo" });
  });

  test("returns undefined for an unmapped state or unknown zone", () => {
    expect(stateToYxc("nonsense", 1)).toBeUndefined();
    expect(stateToYxc("zone9.power", true)).toBeUndefined();
  });
});
