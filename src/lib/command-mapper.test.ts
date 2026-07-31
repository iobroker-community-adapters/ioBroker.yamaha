import { stateToYnca, yncaToState } from "./command-mapper";

describe("stateToYnca", () => {
  test("maps power true to MAIN PWR On", () => {
    expect(stateToYnca("power", true)).toEqual({ subunit: "MAIN", func: "PWR", value: "On" });
  });

  test("maps power false to MAIN PWR Standby", () => {
    expect(stateToYnca("power", false)).toEqual({ subunit: "MAIN", func: "PWR", value: "Standby" });
  });

  test("maps a zone-prefixed state to the matching subunit", () => {
    expect(stateToYnca("zone2.power", true)).toEqual({ subunit: "ZONE2", func: "PWR", value: "On" });
  });

  test("maps a numeric volume to a one-decimal string", () => {
    expect(stateToYnca("volume", -30)).toEqual({ subunit: "MAIN", func: "VOL", value: "-30.0" });
  });

  test("maps mute true to MUTE On", () => {
    expect(stateToYnca("mute", true)).toEqual({ subunit: "MAIN", func: "MUTE", value: "On" });
  });

  test("maps input as a plain string", () => {
    expect(stateToYnca("input", "HDMI1")).toEqual({ subunit: "MAIN", func: "INP", value: "HDMI1" });
  });

  test("returns undefined for an unknown state", () => {
    expect(stateToYnca("bogus", 1)).toBeUndefined();
  });
});

describe("yncaToState", () => {
  test("maps MAIN PWR On to power true", () => {
    expect(yncaToState({ subunit: "MAIN", func: "PWR", value: "On" })).toEqual({ id: "power", value: true });
  });

  test("maps a zone subunit to the prefixed state, value parsed", () => {
    expect(yncaToState({ subunit: "ZONE2", func: "VOL", value: "-30.0" })).toEqual({ id: "zone2.volume", value: -30 });
  });

  test("maps MUTE Off to mute false", () => {
    expect(yncaToState({ subunit: "MAIN", func: "MUTE", value: "Off" })).toEqual({ id: "mute", value: false });
  });

  test("returns undefined for an unmapped function", () => {
    expect(yncaToState({ subunit: "MAIN", func: "UNKNOWN", value: "x" })).toBeUndefined();
  });

  test("returns undefined for an unmapped subunit", () => {
    expect(yncaToState({ subunit: "TUN", func: "PWR", value: "On" })).toBeUndefined();
  });
});
