import { describe, expect, test } from "vitest";
import { mapYxcToObjects } from "../lib/yxc/object-mapper";
import { YNCA_CATALOG } from "../lib/ynca/catalog";
import { formatPlayTime, playTimeTwin } from "../lib/catalog/play-time";

// Y-26: play time exists as a number (seconds, for media players and voice assistants) and as text (for VIS).

describe("Y-26 play time as a number and as text", () => {
  test("MusicCast builds both forms for elapsed and total time", () => {
    const objects = mapYxcToObjects({ zones: [{ id: "main", funcs: ["power"], inputs: [] }], media: ["netusb"] });
    const type = (id: string): unknown => objects.find(o => o.id === id)?.common.type;
    expect([type("player.elapsedTime"), type("player.elapsedTimeText")]).toEqual(["number", "string"]);
    expect([type("player.totalTime"), type("player.totalTimeText")]).toEqual(["number", "string"]);
  });

  test("YNCA has the number form, and every number written there brings its text twin", () => {
    const ids = YNCA_CATALOG.map(entry => entry.id);
    expect(ids).toEqual(expect.arrayContaining(["player.elapsedTime", "player.totalTime"]));
    expect(playTimeTwin("player.elapsedTime", 75)).toEqual({ id: "player.elapsedTimeText", value: "1:15" });
    expect(playTimeTwin("player.totalTime", 3725)).toEqual({ id: "player.totalTimeText", value: "1:02:05" });
  });

  test("the text reads like a player's display", () => {
    expect(formatPlayTime(5)).toBe("0:05");
    expect(formatPlayTime(600)).toBe("10:00");
  });
});
