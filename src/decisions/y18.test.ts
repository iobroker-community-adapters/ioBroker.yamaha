import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { groupOf, isGroupEnabled } from "../lib/catalog/groups";

// Y-18: playback and browsing hang on one shared admin switch (the player group); there is no browse switch of its own.

const config = JSON.parse(readFileSync(join(__dirname, "..", "..", "admin", "jsonConfig.json"), "utf-8")) as unknown;

/**
 * Every key of the admin page, at any depth.
 *
 * @param node the part of the page to walk
 * @param out the keys found so far
 * @returns every key
 */
function keys(node: unknown, out: string[] = []): string[] {
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      out.push(key);
      keys(value, out);
    }
  }
  return out;
}

describe("Y-18 one switch for playback and browsing", () => {
  test("the admin page has the player switch and no browse switch", () => {
    const all = keys(config);
    expect(all).toContain("group_player");
    expect(all.filter(key => /browse/i.test(key))).toEqual([]);
  });

  test("browsing, playback and the on-screen remote belong to the player group", () => {
    for (const id of ["player.browse.source", "player.browse.line1", "player.playback", "remote.cursor"]) {
      expect(groupOf(id)).toBe("player");
    }
    expect(groupOf("multiroom.zone2.player.browse.source")).toBe("player");
  });

  test("the one switch takes playback and browsing together", () => {
    const off = { group_player: false };
    for (const id of ["player.browse.source", "player.playback", "remote.cursor"]) {
      expect(isGroupEnabled(id, off)).toBe(false);
      expect(isGroupEnabled(id, {})).toBe(true);
    }
  });
});
