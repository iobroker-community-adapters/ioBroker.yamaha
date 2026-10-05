import { parseYxcClock } from "./clock";

describe("parseYxcClock", () => {
  test("maps the capture-verified getSettings shape onto the clock states", () => {
    // Real ISX-18D response.
    const updates = parseYxcClock({
      response_code: 0,
      auto_sync: true,
      format: "24h",
      alarm: {
        alarm_on: false,
        volume: 25,
        fade_interval: 180,
        fade_type: 1,
        mode: "oneday",
        repeat: false,
        oneday: { enable: false, time: "0800", beep: true, playback_type: "resume", resume: { input: "tuner" } },
      },
    });
    expect(updates).toEqual(
      expect.arrayContaining([
        { id: "clock.autoSync", value: true },
        { id: "clock.format", value: "24h" },
        { id: "clock.alarm.on", value: false },
        { id: "clock.alarm.volume", value: 25 },
        { id: "clock.alarm.mode", value: "oneday" },
        { id: "clock.alarm.oneday.enable", value: false },
        { id: "clock.alarm.oneday.time", value: "08:00" },
        { id: "clock.alarm.oneday.beep", value: true },
        { id: "clock.alarm.oneday.playbackType", value: "resume" },
        { id: "clock.alarm.oneday.resumeInput", value: "tuner" },
      ]),
    );
  });

  test("maps a weekly day block and a preset-type alarm", () => {
    const updates = parseYxcClock({
      alarm: {
        monday: { enable: true, time: "0630", playback_type: "preset", preset: { type: "netusb", num: 2 } },
      },
    });
    expect(updates).toEqual(
      expect.arrayContaining([
        { id: "clock.alarm.monday.enable", value: true },
        { id: "clock.alarm.monday.time", value: "06:30" },
        { id: "clock.alarm.monday.playbackType", value: "preset" },
        { id: "clock.alarm.monday.presetType", value: "netusb" },
        { id: "clock.alarm.monday.presetNumber", value: 2 },
      ]),
    );
    expect(parseYxcClock(null)).toEqual([]);
  });

  // YXC Basic §9.1: the slot's source and name under `netusb_info`, band and frequency under `tuner_info`;
  // the WX-021/WX-051 captures carry `snooze` on the day block (audit 2026-09-29, C34/C35).
  test("reads the preset's source, name, band and frequency, and the snooze flag", () => {
    const updates = parseYxcClock({
      alarm: {
        oneday: {
          snooze: true,
          playback_type: "preset",
          preset: {
            type: "netusb",
            num: 3,
            netusb_info: { input: "net_radio", text: "Radio Paradise" },
            tuner_info: { band: "fm", number: 98100 },
          },
        },
        tuesday: {
          preset: { type: "netusb", num: 1, netusb_info: { input: "unknown", text: "" }, tuner_info: { band: "dab" } },
        },
      },
    });
    expect(updates).toEqual(
      expect.arrayContaining([
        { id: "clock.alarm.oneday.snooze", value: true },
        { id: "clock.alarm.oneday.presetInput", value: "net_radio" },
        { id: "clock.alarm.oneday.presetName", value: "Radio Paradise" },
        { id: "clock.alarm.oneday.presetBand", value: "fm" },
        { id: "clock.alarm.oneday.presetFrequency", value: 98100 },
        // An empty slot: no source; a DAB slot has a station id, which is no frequency.
        { id: "clock.alarm.tuesday.presetInput", value: "" },
        { id: "clock.alarm.tuesday.presetBand", value: "dab" },
        { id: "clock.alarm.tuesday.presetFrequency", value: 0 },
      ]),
    );
  });
});
