import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PLAYER_DISPLAY_STATES,
  PLAYER_KEY_STATES,
  PLAYER_STATION_STATE,
  playerBlockObjects,
  playerStateObject,
} from "./player-block";
import { formDifferences } from "./object-form";
import { TRANSPORT_KEYS } from "./media-state";
import type { ObjectDef } from "./types";
import { mapYxcToObjects } from "../yxc/object-mapper";
import { parseYxcFeatures } from "../yxc/capability";

const en = (name: ioBroker.StringOrTranslated | undefined): string | undefined =>
  typeof name === "string" ? name : name?.en;

// The player block stood in four builders (review 2026-10-05, E) — one builder for the protocols that build it from
// the tables.
describe("the player block builder", () => {
  test("builds the channel first, then one named object per state, under the zone's prefix", () => {
    const objects = playerBlockObjects("multiroom.zone2.player", [...PLAYER_DISPLAY_STATES, PLAYER_STATION_STATE]);
    expect(objects[0]).toMatchObject({ id: "multiroom.zone2.player", type: "channel" });
    expect(en(objects[0].common.name)).toBe("Media player");
    expect(objects.slice(1).map(object => object.id)).toEqual([
      ...PLAYER_DISPLAY_STATES.map(state => `multiroom.zone2.player.${state.state}`),
      "multiroom.zone2.player.station",
    ]);
    const elapsed = objects.find(object => object.id.endsWith(".elapsedTime"));
    expect(elapsed?.common).toMatchObject({ type: "number", unit: "s", role: "media.elapsed", write: false });
    expect(en(elapsed?.common.desc)).toBeDefined();
    // No key is left on the object — the builder resolves names and explanations.
    expect(objects.some(object => "nameKey" in object.common || "descKey" in object.common)).toBe(false);
  });

  test("the transport keys are the one table's: write-only buttons with the media-player roles", () => {
    expect(PLAYER_KEY_STATES.map(state => state.state)).toEqual(Object.keys(TRANSPORT_KEYS));
    const objects = PLAYER_KEY_STATES.map(state => playerStateObject("player", state));
    expect(objects.map(object => [object.id, object.common.role, object.common.read, object.common.write])).toEqual([
      ["player.play", "button.play", false, true],
      ["player.pause", "button.pause", false, true],
      ["player.stop", "button.stop", false, true],
      ["player.next", "button.next", false, true],
      ["player.prev", "button.prev", false, true],
    ]);
    expect(en(objects[4].common.name)).toBe("Previous");
  });

  test("makes writable only the states the protocol takes writes for", () => {
    const objects = playerBlockObjects("player", PLAYER_DISPLAY_STATES, new Set(["repeat", "shuffle"]));
    const write = (state: string): boolean | undefined =>
      objects.find(object => object.id === `player.${state}`)?.common.write;
    expect(write("repeat")).toBe(true);
    expect(write("shuffle")).toBe(true);
    expect(write("artist")).toBe(false);
    expect(write("playback")).toBe(false);
  });

  // MusicCast can adopt the builder without a change to its tree: the block it builds today, state for state — below
  // API 1.19 with the modes read-only, from 1.19 on writable (C37).
  test.each([
    [1.18, new Set<string>()],
    [1.19, new Set(["repeat", "shuffle"])],
  ])("rebuilds MusicCast's block exactly at API %s — channel, display states, keys", (apiVersion, writable) => {
    const features = JSON.parse(
      readFileSync(join(__dirname, "..", "yxc", "__fixtures__", "RX_A2070_285_208.json"), "utf8"),
    ) as unknown;
    const capabilities = { ...parseYxcFeatures(features), apiVersion };
    expect(capabilities.media).toContain("netusb");
    const built = new Map(mapYxcToObjects(capabilities).map(object => [object.id, object] as const));
    for (const prefix of ["player", "multiroom.zone2.player"]) {
      const ours = playerBlockObjects(prefix, [...PLAYER_DISPLAY_STATES, ...PLAYER_KEY_STATES], writable);
      for (const object of ours) {
        const theirs: ObjectDef | undefined = built.get(object.id);
        expect(theirs, object.id).toBeDefined();
        expect(formDifferences(object, theirs!), object.id).toEqual([]);
        expect(object.common.desc, object.id).toEqual(theirs!.common.desc);
      }
    }
  });
});
