import { mediaTimeUpdates, mediaToRefresh, netusbNotice, pushSignals, zonesToRefresh } from "./push";

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

// YXC Basic Rev 1.10 §11.3 (audit 2026-09-24, C3): a media block re-reads its playback info only when
// the device says so, or when it carries a field the specification does not know.
describe("mediaToRefresh — only a playback-info change re-reads the playback info", () => {
  test("list, account, preset and error fields alone are no playback-info change", () => {
    expect(mediaToRefresh({ netusb: { preset_info_updated: true } })).toEqual([]);
    expect(mediaToRefresh({ netusb: { list_info_updated: true, play_error: 0 } })).toEqual([]);
    expect(mediaToRefresh({ tuner: { preset_info_updated: true, play_info_updated: false } })).toEqual([]);
    expect(mediaToRefresh({ cd: { device_status: "open" } })).toEqual([]);
  });

  test("the device's own flag, an unknown field, and an empty block still re-read", () => {
    expect(mediaToRefresh({ tuner: { play_info_updated: true } })).toEqual(["tuner"]);
    expect(mediaToRefresh({ netusb: { something_new: 1 } })).toEqual(["netusb"]);
    expect(mediaToRefresh({ cd: {} })).toEqual(["cd"]);
  });
});

describe("pushSignals", () => {
  test("reads each flag of the specification — only a true one counts", () => {
    expect(
      pushSignals({
        dist: { dist_info_updated: true },
        system: { func_status_updated: true, name_text_updated: true },
        main: { signal_info_updated: true },
        zone2: { signal_info_updated: false },
        tuner: { preset_info_updated: true },
        clock: { settings_updated: true },
        netusb: { list_info_updated: true },
      }),
    ).toEqual({
      distribution: true,
      system: true,
      nameText: true,
      signalZones: ["main"],
      tunerPresets: true,
      clock: true,
      list: true,
    });
    expect(pushSignals({ system: { func_status_updated: "yes" } }).system).toBe(false);
  });

  test("a malformed event carries no signal", () => {
    const none = {
      distribution: false,
      system: false,
      nameText: false,
      signalZones: [],
      tunerPresets: false,
      clock: false,
      list: false,
    };
    expect(pushSignals(null)).toEqual(none);
    expect(pushSignals("x")).toEqual(none);
    expect(pushSignals({ dist: 1 })).toEqual(none);
  });
});

describe("netusbNotice", () => {
  test("carries the error, the message and a complete preset result", () => {
    expect(
      netusbNotice({
        netusb: {
          play_error: 3,
          play_message: "Skip limit",
          preset_control: { type: "recall", num: 2, result: "empty" },
        },
      }),
    ).toEqual({ playError: 3, playMessage: "Skip limit", presetControl: { type: "recall", num: 2, result: "empty" } });
  });

  test("ignores mistyped fields and an incomplete preset result", () => {
    expect(netusbNotice({ netusb: { play_error: "3", preset_control: { type: "recall", num: 2 } } })).toEqual({});
    expect(netusbNotice({ main: {} })).toEqual({});
    expect(netusbNotice(null)).toEqual({});
  });
});
