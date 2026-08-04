import { mediaToRefresh, zonesToRefresh } from "./push";

describe("mediaToRefresh", () => {
  test("returns the media-player blocks present in a push event", () => {
    expect(mediaToRefresh({ netusb: { play_info_updated: true }, main: {} })).toEqual(["netusb"]);
    expect(mediaToRefresh({ cd: {}, tuner: {} })).toEqual(["cd", "tuner"]);
  });

  test("ignores zone keys and unknown keys", () => {
    expect(mediaToRefresh({ main: { power: "on" }, zone2: {} })).toEqual([]);
    expect(mediaToRefresh({ clock: {}, dist: {} })).toEqual([]);
  });

  test("returns empty for a malformed event", () => {
    expect(mediaToRefresh(null)).toEqual([]);
    expect(mediaToRefresh("nope")).toEqual([]);
  });
});

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
