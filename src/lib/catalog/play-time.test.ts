import { formatPlayTime, parsePlayTime, playTimeTwin } from "./play-time";

describe("parsePlayTime", () => {
  it("reads the device's m:ss form", () => {
    expect(parsePlayTime("1:23")).toBe(83);
    expect(parsePlayTime("0:07")).toBe(7);
    expect(parsePlayTime("59:59")).toBe(3599);
  });

  it("reads the h:mm:ss form long tracks use", () => {
    expect(parsePlayTime("1:00:00")).toBe(3600);
    expect(parsePlayTime("1:02:03")).toBe(3723);
    expect(parsePlayTime("12:00:00")).toBe(43200);
  });

  it("has nothing to report for the device's placeholders", () => {
    // A stopped source answers with an empty value or a dash placeholder — that is
    // "no time", not zero, so the state stays without a bogus value.
    expect(parsePlayTime("")).toBeUndefined();
    expect(parsePlayTime("--:--")).toBeUndefined();
    expect(parsePlayTime("  ")).toBeUndefined();
    expect(parsePlayTime("nonsense")).toBeUndefined();
    expect(parsePlayTime("1:2:3:4")).toBeUndefined();
    expect(parsePlayTime("83")).toBeUndefined();
  });
});

describe("formatPlayTime", () => {
  it("writes m:ss below an hour and h:mm:ss from an hour on", () => {
    expect(formatPlayTime(83)).toBe("1:23");
    expect(formatPlayTime(7)).toBe("0:07");
    expect(formatPlayTime(3599)).toBe("59:59");
    expect(formatPlayTime(3600)).toBe("1:00:00");
    expect(formatPlayTime(3723)).toBe("1:02:03");
  });

  it("round-trips both device forms", () => {
    for (const text of ["0:07", "1:23", "59:59", "1:00:00", "1:02:03"]) {
      expect(formatPlayTime(parsePlayTime(text) as number)).toBe(text);
    }
  });

  it("shows nothing for a value that is no time", () => {
    expect(formatPlayTime(Number.NaN)).toBe("");
    expect(formatPlayTime(-5)).toBe("");
  });
});

describe("playTimeTwin", () => {
  it("pairs the numeric time states with their readable form", () => {
    expect(playTimeTwin("player.elapsedTime", 83)).toEqual({ id: "player.elapsedTimeText", value: "1:23" });
    expect(playTimeTwin("player.totalTime", 215)).toEqual({ id: "player.totalTimeText", value: "3:35" });
  });

  it("leaves every other state alone", () => {
    expect(playTimeTwin("player.track", "Song")).toBeUndefined();
    expect(playTimeTwin("volume", -30)).toBeUndefined();
  });

  it("shows an empty text when the value is not a number", () => {
    expect(playTimeTwin("player.elapsedTime", "")).toEqual({ id: "player.elapsedTimeText", value: "" });
  });
});
