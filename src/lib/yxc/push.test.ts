import { zonesToRefresh } from "./push";

describe("zonesToRefresh", () => {
  test("returns the zone keys present in a push event", () => {
    expect(zonesToRefresh({ main: { power: "on" }, device_id: "x" })).toEqual(["main"]);
    expect(zonesToRefresh({ main: {}, zone2: {} })).toEqual(["main", "zone2"]);
  });

  test("ignores media blocks and unknown keys", () => {
    expect(zonesToRefresh({ netusb: { play_info_updated: true }, tuner: {} })).toEqual([]);
    expect(zonesToRefresh({ zone2: {}, netusb: {} })).toEqual(["zone2"]);
  });

  test("returns empty for a malformed event", () => {
    expect(zonesToRefresh(null)).toEqual([]);
    expect(zonesToRefresh("nope")).toEqual([]);
  });
});
