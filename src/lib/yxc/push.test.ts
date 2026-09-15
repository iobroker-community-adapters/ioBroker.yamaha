import { mediaTimeUpdates, mediaToRefresh, zonesToRefresh } from "./push";

describe("mediaToRefresh", () => {
  test("returns the media-player blocks present in a push event", () => {
    expect(mediaToRefresh({ netusb: { play_info_updated: true }, main: {} })).toEqual(["netusb"]);
    expect(mediaToRefresh({ cd: {}, tuner: {} })).toEqual(["cd", "tuner"]);
  });

  test("a block that carries nothing but the playback clock is no re-fetch signal", () => {
    // While a source plays, the device pushes `play_time` every second — a getPlayInfo per
    // tick asked the device for the whole playback status 3600 times an hour.
    expect(mediaToRefresh({ netusb: { play_time: 12 } })).toEqual([]);
    expect(mediaToRefresh({ netusb: { play_time: 12, total_time: 240 } })).toEqual([]);
    expect(mediaToRefresh({ netusb: { play_time: 12, play_info_updated: true } })).toEqual(["netusb"]);
    expect(mediaToRefresh({ cd: { play_time: 3 }, tuner: {} })).toEqual(["tuner"]);
  });
});

describe("mediaTimeUpdates", () => {
  test("hands a clock-only block over with its values, for the player states", () => {
    expect(mediaTimeUpdates({ netusb: { play_time: 12 } })).toEqual([{ block: "netusb", info: { play_time: 12 } }]);
    expect(mediaTimeUpdates({ cd: { play_time: 3, total_time: 200 } })).toEqual([
      { block: "cd", info: { play_time: 3, total_time: 200 } },
    ]);
  });

  test("a block with any other field is a re-fetch, not a clock tick; the tuner has no clock", () => {
    expect(mediaTimeUpdates({ netusb: { play_time: 12, play_info_updated: true } })).toEqual([]);
    expect(mediaTimeUpdates({ tuner: { play_time: 1 } })).toEqual([]);
    expect(mediaTimeUpdates({ netusb: {} })).toEqual([]);
    expect(mediaTimeUpdates({ main: { volume: 1 } })).toEqual([]);
  });

  test("returns empty for a malformed event", () => {
    expect(mediaTimeUpdates(null)).toEqual([]);
    expect(mediaTimeUpdates("nope")).toEqual([]);
    expect(mediaTimeUpdates({ netusb: "12" })).toEqual([]);
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
